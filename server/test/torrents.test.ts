import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  DownloadCheckResponse,
  DownloadsResponse,
  DownloadTaskView,
  NotificationsResponse,
} from '../../shared/api.ts';
import { readAria2Secret } from '../src/downloads/aria2.ts';
import {
  decode,
  parseTorrent,
  problemWithComponent,
  rebuildTorrent,
  TorrentError,
} from '../src/downloads/bencode.ts';
import { buildMagnet, parseMagnet } from '../src/downloads/magnet.ts';
import { type FakeAria2, startFakeAria2 } from './fixtures/fake-aria2.ts';
import { enc, makeTorrent } from './fixtures/torrent-builder.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, removeDir, type TestApp } from './helpers.ts';

const SASHA = { username: 'sasha', password: 'sasha-password-1', displayName: 'Саша' };

describe('reading a .torrent file', () => {
  it('finds the hash, the name, the files and the trackers', () => {
    const { bytes, infoHash } = makeTorrent({
      name: 'Каникулы',
      files: [
        { path: ['Видео', 'серия 1.mkv'], length: 700 },
        { path: ['Субтитры.srt'], length: 30 },
      ],
      announce: 'udp://tracker.example.org:6969/announce',
      announceList: [['udp://tracker.example.org:6969/announce'], ['https://t2.example.org/announce']],
    });
    const meta = parseTorrent(bytes);
    expect(meta.infoHash).toBe(infoHash);
    expect(meta).toMatchObject({ name: 'Каникулы', single: false, totalBytes: 730, v2Only: false });
    expect(meta.files.map((f) => f.path.join('/'))).toEqual(['Видео/серия 1.mkv', 'Субтитры.srt']);
    expect(meta.trackers).toEqual([
      'udp://tracker.example.org:6969/announce',
      'https://t2.example.org/announce',
    ]);
  });

  it('knows a single-file torrent', () => {
    const meta = parseTorrent(makeTorrent({ name: 'film.mp4', length: 5000 }).bytes);
    expect(meta).toMatchObject({ single: true, totalBytes: 5000 });
    expect(meta.files).toEqual([{ path: ['film.mp4'], length: 5000 }]);
  });

  it.each([
    ['a way out of the folder', ['..', 'x.txt']],
    ['an absolute path', ['C:', 'Windows', 'x.txt']],
    ['a hidden stream', ['file.txt:evil']],
    ['a device name', ['nul.txt']],
    ['a trailing dot', ['file.']],
    ['a slash inside a name', ['a/b']],
    ['an empty name', ['']],
    ['a control character', ['bad\u0007name']],
  ])('refuses %s', (_label, parts) => {
    const { bytes } = makeTorrent({ name: 'Раздача', files: [{ path: parts, length: 10 }] });
    expect(() => parseTorrent(bytes)).toThrow(TorrentError);
  });

  it('refuses a name of the whole torrent that is not a safe name', () => {
    expect(() => parseTorrent(makeTorrent({ name: '..', length: 1 }).bytes)).toThrow(TorrentError);
    expect(() => parseTorrent(makeTorrent({ name: 'con', length: 1 }).bytes)).toThrow(TorrentError);
    expect(problemWithComponent('Нормальное имя (2026).mkv')).toBeNull();
  });

  it('recognises a new-format (v2 only) torrent', () => {
    const v2 = makeTorrent({
      name: 'v2',
      length: 10,
      extraInfo: { 'meta version': 2, 'file tree': { 'a.txt': { '': { length: 10 } } } },
    });
    // the builder always adds pieces; remove them to look like v2 only
    const info = decode(v2.bytes).value as { info: Record<string, unknown> };
    expect(info.info['meta version']).toBe(2);
    const noPieces = enc({
      info: { name: 'v2', 'meta version': 2, 'file tree': { 'a.txt': { '': { length: 10 } } }, length: 10 },
    });
    expect(parseTorrent(noPieces).v2Only).toBe(true);
    expect(parseTorrent(v2.bytes).v2Only).toBe(false);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['text', Buffer.from('not a torrent')],
    ['truncated', makeTorrent({ name: 'a', length: 1 }).bytes.subarray(0, 40)],
    ['trailing garbage', Buffer.concat([makeTorrent({ name: 'a', length: 1 }).bytes, Buffer.from('zzz')])],
    ['too deep', Buffer.from(`${'l'.repeat(40)}${'e'.repeat(40)}`)],
    ['huge', Buffer.alloc(5 * 1024 * 1024, 0x6c)],
    ['no info', enc({ announce: 'x' })],
    ['a bad number', Buffer.from('d4:infod4:name1:a6:lengthi12xeee')],
  ])('refuses a damaged file: %s', (_label, bytes) => {
    expect(() => parseTorrent(bytes)).toThrow(TorrentError);
  });

  it('rewrites the file: the hash stays, web seeds and the comment go, only the given trackers stay', () => {
    const original = makeTorrent({
      name: 'Каникулы',
      files: [{ path: ['a.mkv'], length: 100 }],
      announce: 'http://192.168.1.1/announce',
      announceList: [['http://192.168.1.1/announce'], ['udp://tracker.example.org:6969/announce']],
      urlList: ['http://192.168.1.5:8080/files/'],
      httpSeeds: ['http://127.0.0.1/seed'],
      comment: 'secret note',
    });
    const rebuilt = rebuildTorrent(original.bytes, ['udp://tracker.example.org:6969/announce']);
    const meta = parseTorrent(rebuilt);
    expect(meta.infoHash).toBe(original.infoHash);
    expect(meta.trackers).toEqual(['udp://tracker.example.org:6969/announce']);
    const text = rebuilt.toString('latin1');
    for (const gone of ['url-list', 'httpseeds', '192.168.1.5', '127.0.0.1', 'secret note', 'created by']) {
      expect(text, gone).not.toContain(gone);
    }
    const noTrackers = parseTorrent(rebuildTorrent(original.bytes, []));
    expect(noTrackers.trackers).toEqual([]);
    expect(noTrackers.infoHash).toBe(original.infoHash);
  });
});

describe('magnet links', () => {
  const hex = 'a'.repeat(20) + 'b'.repeat(20);

  it('reads a hex hash, a base32 hash, the name and the trackers', () => {
    expect(
      parseMagnet(
        `magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=%D0%A4%D0%B8%D0%BB%D1%8C%D0%BC&tr=udp%3A%2F%2Ft.example.org%3A1%2Fa`,
      ),
    ).toEqual({
      infoHash: hex,
      name: 'Фильм',
      trackers: ['udp://t.example.org:1/a'],
    });
    const base32 = 'VKVKVKVKVKVKVKVKVKVKXOXOXOXOXOXO';
    expect(parseMagnet(`magnet:?xt=urn:btih:${base32}`)?.infoHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each([
    '',
    'http://x',
    'magnet:?dn=x',
    'magnet:?xt=urn:btih:xyz',
    `magnet:?xt=urn:sha1:${'a'.repeat(40)}`,
    `magnet:?xt=urn:btih:${'g'.repeat(40)}`,
  ])('refuses %j', (text) => expect(parseMagnet(text)).toBeNull());

  it('builds a clean magnet: no addresses to fetch from', () => {
    const dirty = parseMagnet(
      `magnet:?xt=urn:btih:${hex}&ws=http%3A%2F%2F127.0.0.1%2Fx&xs=http%3A%2F%2F192.168.1.1%2Ft&as=http%3A%2F%2Fa&tr=http%3A%2F%2F10.0.0.1%2Fa`,
    );
    const clean = buildMagnet(dirty as NonNullable<typeof dirty>, ['udp://t.example.org:1/a']);
    expect(clean).toBe(`magnet:?xt=urn:btih:${hex}&tr=udp%3A%2F%2Ft.example.org%3A1%2Fa`);
  });
});

// ---------------------------------------------------------------------------------------------

let t: TestApp;
let fake: FakeAria2;
let mama: string;
let papa: string;
let sasha: string;
let refreshes: number;
let installed = true;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const RESOLVE: Record<string, string[]> = {
  'tracker.example.org': ['93.184.216.34'],
  't2.example.org': ['93.184.216.35'],
  'evil.example.net': ['192.168.1.1'],
  'rebind.example.net': ['93.184.216.36', '127.0.0.1'],
};

async function boot(withEngine = true) {
  const port = await freePort();
  t = await createTestApp({
    env: { TORRENT_RPC_URL: `http://127.0.0.1:${port}/jsonrpc` },
    torrentClientInstalled: () => installed,
    resolveTrackerHost: async (host) => {
      const found = RESOLVE[host];
      if (!found) throw new Error('no such host');
      return found;
    },
    freeBytes: async () => 5 * 1024 ** 4,
    jellyfinFetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/Library/Refresh') && init?.method === 'POST') {
        refreshes += 1;
        return new Response(null, { status: 204 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  await writeFile(path.join(t.dataDir, 'jellyfin-api.json'), JSON.stringify({ apiKey: 'a'.repeat(32) }));
  const secret = (await readAria2Secret(t.dataDir)) as string;
  if (withEngine) fake = await startFakeAria2({ secret, port });
  const a = await addUser(t.dataDir, t.clock, ADMIN);
  const b = await addUser(t.dataDir, t.clock, FAMILY);
  const c = await addUser(t.dataDir, t.clock, { ...SASHA, role: 'family' });
  await t.app.dashboard.users.update(b.id, { permissions: ['downloads'] });
  expect(a.id).toBeDefined();
  expect(c.id).toBeDefined();
  mama = await cookieFor(t.app, FAMILY);
  papa = await cookieFor(t.app, ADMIN);
  sasha = await cookieFor(t.app, SASHA);
}

beforeEach(() => {
  refreshes = 0;
  installed = true;
});

afterEach(async () => {
  if (t) {
    await t.app.close();
    await removeDir(t.dataDir);
    t = undefined as unknown as TestApp;
  }
  if (fake) {
    await fake.close().catch(() => undefined);
    fake = undefined as unknown as FakeAria2;
  }
});

const json = async <T>(res: Promise<{ statusCode: number; json: () => unknown }>) => {
  const r = await res;
  return { status: r.statusCode, body: r.json() as T };
};
const post = (cookie: string, url: string, payload: object = {}) =>
  json<DownloadCheckResponse & DownloadTaskView & { error?: string; message?: string }>(
    t.app.inject({ method: 'POST', url, headers: { cookie }, payload }),
  );
const get = <T>(cookie: string, url: string) => json<T>(t.app.inject({ url, headers: { cookie } }));
const putFile = (cookie: string, bytes: Buffer) =>
  json<DownloadCheckResponse & { error?: string; message?: string }>(
    t.app.inject({
      method: 'PUT',
      url: '/api/downloads/torrent-file?name=test.torrent',
      headers: { cookie, 'content-type': 'application/octet-stream', 'x-upload': '1' },
      payload: bytes,
    }),
  );
const tasks = async (cookie: string) => (await get<DownloadsResponse>(cookie, '/api/downloads')).body.tasks;

const SAMPLE = () =>
  makeTorrent({
    name: 'Каникулы',
    files: [
      { path: ['серия 1.mkv'], length: 4000 },
      { path: ['серия 2.mkv'], length: 6000 },
      { path: ['setup.exe'], length: 500 },
      { path: ['Субтитры', 'ru.srt'], length: 20 },
    ],
    announce: 'udp://tracker.example.org:6969/announce',
    announceList: [
      ['udp://tracker.example.org:6969/announce'],
      ['http://192.168.1.1/announce'],
      ['http://evil.example.net/a'],
    ],
    urlList: ['http://192.168.1.9/seed/'],
  });

describe('the torrent client is not there', () => {
  it('says so in plain words: not installed, or installed but not answering', async () => {
    installed = false;
    await boot(false);
    const state = (await get<DownloadsResponse>(mama, '/api/downloads')).body.torrentEngine;
    expect(state.state).toBe('not_installed');
    expect(state.hint).toContain('torrent-setup.cmd');
    const refused = await post(mama, '/api/downloads/check', {
      url: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
    });
    expect(refused.status).toBe(503);
    expect(refused.body.message).toContain('не установлен');
    // links still work: the queue of links does not need the client
    installed = true;
    expect((await get<DownloadsResponse>(mama, '/api/downloads')).body.torrentEngine.state).toBe('down');
    expect((await get<DownloadsResponse>(mama, '/api/downloads')).body.torrentEngine.hint).toContain(
      'service.cmd restart aria2',
    );
  });

  it('does not make up a queue: a task shows that the client is silent, not a progress', async () => {
    await boot();
    const sample = SAMPLE();
    const check = await putFile(mama, sample.bytes);
    await post(mama, '/api/downloads', { checkId: check.body.checkId });
    fake.progress(sample.infoHash, 1000);
    expect((await tasks(mama))[0]).toMatchObject({ state: 'downloading', receivedBytes: 1000 });
    await fake.close();
    const [task] = await tasks(mama);
    expect(task).toMatchObject({ state: 'failed', speedBps: null });
    expect(task?.error).toContain('не отвечает');
    expect(task?.torrent?.etaSec).toBeNull();
  });
});

describe('checking a torrent', () => {
  beforeEach(() => boot());

  it('needs a person with the right', async () => {
    expect(
      (await post(sasha, '/api/downloads/check', { url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) })).status,
    ).toBe(403);
    expect((await putFile(sasha, SAMPLE().bytes)).status).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: '/api/downloads/torrent-file',
          headers: { 'content-type': 'application/octet-stream', 'x-upload': '1' },
          payload: Buffer.from('x'),
        })
      ).statusCode,
    ).toBe(401);
    expect((await get<DownloadsResponse>(sasha, '/api/downloads')).body).toMatchObject({
      allowed: false,
      tasks: [],
    });
  });

  it('shows what is inside a file, marks programs as skipped and counts what will really come', async () => {
    const { status, body } = await putFile(mama, SAMPLE().bytes);
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'torrent', status: 'ready', fileName: 'Каникулы', sizeBytes: 10520 });
    expect(body.files.map((f) => [f.path, f.skipped])).toEqual([
      ['серия 1.mkv', false],
      ['серия 2.mkv', false],
      ['setup.exe', true],
      ['Субтитры/ru.srt', false],
    ]);
    expect(body.willDownload).toEqual({ files: 3, sizeBytes: 10020 });
    expect(body.destinations.map((d) => d.id)).toEqual(['personal', 'movies', 'series', 'cartoons', 'music']);
  });

  it('refuses a torrent of programs only, and a damaged or v2-only file', async () => {
    const programs = makeTorrent({
      name: 'crack',
      files: [
        { path: ['a.exe'], length: 1 },
        { path: ['b.bat'], length: 1 },
      ],
    });
    const refused = await putFile(mama, programs.bytes);
    expect(refused.body.status).toBe('failed');
    expect(refused.body.error).toContain('программы и скрипты');
    const damaged = await putFile(mama, Buffer.from('garbage'));
    expect(damaged.status).toBe(400);
    const v2 = await putFile(
      mama,
      enc({ info: { name: 'v2', 'meta version': 2, 'file tree': {}, length: 10 } }),
    );
    expect(v2.body.status).toBe('failed');
    expect(v2.body.error).toContain('v2');
    const tooBig = await t.app.inject({
      method: 'PUT',
      url: '/api/downloads/torrent-file',
      headers: { cookie: mama, 'content-type': 'application/octet-stream', 'x-upload': '1' },
      payload: Buffer.alloc(5 * 1024 * 1024, 1),
    });
    expect(tooBig.statusCode).toBe(413);
  });

  it('asks the client for the contents of a magnet and shows them when they arrive', async () => {
    const sample = SAMPLE();
    fake.setMetadata(sample.infoHash, sample.bytes);
    const pending = await post(mama, '/api/downloads/check', {
      url: `magnet:?xt=urn:btih:${sample.infoHash}&dn=x&ws=http%3A%2F%2F127.0.0.1%2Fa&tr=udp%3A%2F%2Ftracker.example.org%3A6969%2Fannounce&tr=http%3A%2F%2F192.168.1.1%2Fa`,
    });
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ kind: 'torrent', status: 'pending' });
    let ready: DownloadCheckResponse | undefined;
    for (let i = 0; i < 60 && ready?.status !== 'ready'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ready = (await get<DownloadCheckResponse>(mama, `/api/downloads/check/${pending.body.checkId}`)).body;
    }
    expect(ready?.status).toBe('ready');
    expect(ready?.files).toHaveLength(4);
    // what reached the client: a clean magnet, metadata only, nothing from the dangerous parts of the link
    const call = fake.calls.find((c) => c.method === 'aria2.addUri');
    const [uris, options] = (call as { params: unknown[] }).params as [string[], Record<string, string>];
    expect(uris[0]).toBe(
      `magnet:?xt=urn:btih:${sample.infoHash}&dn=x&tr=udp%3A%2F%2Ftracker.example.org%3A6969%2Fannounce`,
    );
    expect(options).toMatchObject({ 'bt-metadata-only': 'true', 'bt-save-metadata': 'true' });
    expect(JSON.stringify(call)).not.toContain('127.0.0.1');
    expect(JSON.stringify(call)).not.toContain('192.168');
    // the temporary task is gone from the client
    expect(fake.calls.some((c) => c.method === 'aria2.removeDownloadResult')).toBe(true);
  });

  it('says when nobody shares: the person is not left waiting', async () => {
    const sample = SAMPLE();
    const pending = await post(mama, '/api/downloads/check', {
      url: `magnet:?xt=urn:btih:${sample.infoHash}`,
    });
    // the fake never delivers metadata; the check is cancelled by stopping the application at the end of the test
    expect(pending.body.status).toBe('pending');
    const again = await get<DownloadCheckResponse>(mama, `/api/downloads/check/${pending.body.checkId}`);
    expect(again.body.status).toBe('pending');
    // another person cannot read this check
    expect((await get(papa, `/api/downloads/check/${pending.body.checkId}`)).status).toBe(404);
  });

  it('refuses text that is not a magnet link; other links still go to the direct-link queue', async () => {
    const bad = await post(mama, '/api/downloads/check', { url: 'magnet:?dn=nothing' });
    expect(bad.status).toBe(400);
    const link = await post(mama, '/api/downloads/check', { url: 'http://192.168.1.1/file.zip' });
    expect(link.status).toBe(403);
  });
});

describe('adding, watching and ending a torrent', () => {
  beforeEach(() => boot());

  async function addSample(destination = 'personal', cookie = mama) {
    const sample = SAMPLE();
    const check = await putFile(cookie, sample.bytes);
    const added = await post(cookie, '/api/downloads', { checkId: check.body.checkId, destination });
    return { sample, check: check.body, added };
  }

  it('hands the client a checked, rewritten torrent with the right folder and no programs', async () => {
    const { sample, added } = await addSample();
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({
      kind: 'torrent',
      id: `t-${sample.infoHash}`,
      fileName: 'Каникулы',
      sizeBytes: 10020,
      state: 'downloading',
      destinationLabel: 'Файлы → Личное → Загрузки',
      inLibrary: false,
    });
    const call = fake.calls.find((c) => c.method === 'aria2.addTorrent');
    const [b64, , options] = (call as { params: unknown[] }).params as [
      string,
      unknown[],
      Record<string, string>,
    ];
    expect(options.dir).toBe(path.join(t.config.filesDir, 'users', 'mama', 'Загрузки'));
    expect(options['select-file']).toBe('1,2,4'); // the setup.exe (3) is left out
    expect(options).toMatchObject({
      'seed-ratio': '1',
      'max-upload-limit': '500K',
      'allow-overwrite': 'false',
    });
    const sent = Buffer.from(b64, 'base64');
    const meta = parseTorrent(sent);
    expect(meta.infoHash).toBe(sample.infoHash);
    expect(meta.trackers).toEqual(['udp://tracker.example.org:6969/announce']);
    expect(sent.toString('latin1')).not.toMatch(/url-list|192\.168|evil\.example/);
    expect(fake.calls.map((c) => c.method).filter((m) => m === 'aria2.addTorrent')).toHaveLength(1);
  });

  it('shows progress, speed and the time left; seeding is told as «раздаётся»', async () => {
    const { sample } = await addSample();
    fake.progress(sample.infoHash, 1020, 1000);
    let [task] = await tasks(mama);
    expect(task).toMatchObject({ state: 'downloading', receivedBytes: 1020, speedBps: 1000 });
    expect(task?.torrent).toMatchObject({
      etaSec: 9,
      seeders: 3,
      connections: 5,
      seeding: false,
      fileCount: 3,
    });
    fake.finish(sample.infoHash, { seeding: true });
    [task] = await tasks(mama);
    expect(task).toMatchObject({ state: 'completed', receivedBytes: 10020, speedBps: null });
    expect(task?.torrent).toMatchObject({ seeding: true, etaSec: null });
    expect(task?.torrent?.ratio).toBeCloseTo(0.4, 1);
  });

  it('pauses, resumes and cancels through the client; a cancelled download takes its crumbs away, only its own', async () => {
    const { sample } = await addSample();
    const id = `t-${sample.infoHash}`;
    expect((await post(mama, `/api/downloads/${id}/pause`)).body.state).toBe('paused');
    expect((await post(mama, `/api/downloads/${id}/resume`)).body.state).toBe('downloading');
    // partial files: two of its own, and somebody else's neighbour in the same folder
    const root = path.join(t.config.filesDir, 'users', 'mama', 'Загрузки');
    const own = path.join(root, 'Каникулы', 'серия 1.mkv');
    await mkdir(path.dirname(own), { recursive: true });
    await writeFile(own, 'part');
    await writeFile(`${own}.aria2`, 'ctl');
    const neighbour = path.join(root, 'Мои документы.txt');
    await writeFile(neighbour, 'mine');
    const stranger = path.join(root, 'Каникулы', 'мои заметки.txt');
    await writeFile(stranger, 'keep me');
    const cancelled = await t.app.inject({
      method: 'POST',
      url: `/api/downloads/${id}/cancel`,
      headers: { cookie: mama },
      payload: {},
    });
    expect(cancelled.statusCode).toBe(204);
    await expect(stat(own)).rejects.toThrow();
    await expect(stat(`${own}.aria2`)).rejects.toThrow();
    expect(await readFile(neighbour, 'utf8')).toBe('mine');
    expect(await readFile(stranger, 'utf8')).toBe('keep me');
    expect(await tasks(mama)).toEqual([]);
    expect(fake.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining([
        'aria2.pause',
        'aria2.unpause',
        'aria2.forceRemove',
        'aria2.removeDownloadResult',
      ]),
    );
  });

  it('keeps people apart: nobody touches another person’s torrent; an administrator sees all', async () => {
    await t.app.dashboard.users.update((await t.app.dashboard.users.findByUsername('sasha'))?.id ?? '', {
      permissions: ['downloads'],
    });
    const { sample } = await addSample();
    const id = `t-${sample.infoHash}`;
    expect(await tasks(sasha)).toEqual([]);
    expect((await tasks(papa)).map((x) => x.owner)).toEqual(['mama']);
    for (const action of ['pause', 'resume', 'cancel', 'remove', 'retry']) {
      expect((await post(sasha, `/api/downloads/${id}/${action}`)).status, action).toBe(404);
    }
    expect((await post(papa, `/api/downloads/${id}/pause`)).body.state).toBe('paused');
    // a check belongs to the person who made it
    const check = await putFile(mama, makeTorrent({ name: 'Другой', length: 100 }).bytes);
    expect((await post(sasha, '/api/downloads', { checkId: check.body.checkId })).status).toBe(400);
  });

  it('refuses the same torrent twice and too many at once', async () => {
    const { sample, check } = await addSample();
    const again = await putFile(mama, sample.bytes);
    expect(again.status).toBe(409);
    expect(again.body.message).toContain('уже скачивается');
    expect(check.checkId).toBeDefined();
    for (let i = 0; i < 19; i += 1) {
      const next = await putFile(mama, makeTorrent({ name: `Раздача ${i}`, length: 100 + i }).bytes);
      expect((await post(mama, '/api/downloads', { checkId: next.body.checkId })).status).toBe(200);
    }
    const overflow = await putFile(mama, makeTorrent({ name: 'Лишняя', length: 999 }).bytes);
    expect(overflow.status).toBe(429);
  });

  it('puts a finished download into the media folder and tells Jellyfin to look for it', async () => {
    const { sample, added } = await addSample('movies');
    expect(added.body.destinationLabel).toBe('Общая медиатека → Фильмы');
    const call = fake.calls.find((c) => c.method === 'aria2.addTorrent');
    expect(((call as { params: unknown[] }).params[2] as Record<string, string>).dir).toBe(
      path.join(t.config.mediaDir, 'Фильмы'),
    );
    fake.finish(sample.infoHash);
    await t.app.dashboard.torrents.poll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refreshes).toBe(1);
    await t.app.dashboard.torrents.poll();
    expect(refreshes).toBe(1); // once per download
    expect((await tasks(mama))[0]).toMatchObject({ state: 'completed', inLibrary: true });
  });

  it('a personal download does not disturb Jellyfin', async () => {
    const { sample } = await addSample('personal');
    fake.finish(sample.infoHash);
    await t.app.dashboard.torrents.poll();
    expect(refreshes).toBe(0);
  });

  it('tells the owner when it is finished, marks the files «from the internet», and survives a restart of the client', async () => {
    const { sample } = await addSample();
    const root = path.join(t.config.filesDir, 'users', 'mama', 'Загрузки', 'Каникулы');
    await mkdir(path.join(root, 'Субтитры'), { recursive: true });
    await writeFile(path.join(root, 'серия 1.mkv'), 'a');
    await writeFile(path.join(root, 'серия 2.mkv'), 'b');
    await writeFile(path.join(root, 'Субтитры', 'ru.srt'), 'c');
    fake.finish(sample.infoHash);
    await t.app.dashboard.torrents.poll();
    await t.app.dashboard.notify.idle();
    const mamaNotes = (await get<NotificationsResponse>(mama, '/api/notifications')).body;
    expect(mamaNotes.notifications[0]).toMatchObject({ kind: 'download', title: 'Загрузка завершена' });
    expect((await get<NotificationsResponse>(papa, '/api/notifications')).body.notifications).toEqual([]);
    if (process.platform === 'win32') {
      expect(await readFile(`${path.join(root, 'серия 1.mkv')}:Zone.Identifier`, 'utf8')).toContain(
        'ZoneId=3',
      );
    }
    // the client forgets finished tasks when it restarts: the portal still lists it as finished
    fake.forget(sample.infoHash);
    expect((await tasks(mama))[0]).toMatchObject({ state: 'completed', receivedBytes: 10020 });
    // «Убрать из списка» keeps the files
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/downloads/t-${sample.infoHash}/remove`,
          headers: { cookie: mama },
          payload: {},
        })
      ).statusCode,
    ).toBe(204);
    expect(await readFile(path.join(root, 'серия 1.mkv'), 'utf8')).toBe('a');
    expect(await tasks(mama)).toEqual([]);
  });

  it('explains an error in plain words and retries from the saved torrent', async () => {
    const { sample } = await addSample();
    fake.fail(sample.infoHash, '9', 'No space');
    await t.app.dashboard.torrents.poll();
    const [failed] = await tasks(mama);
    expect(failed).toMatchObject({ state: 'failed', error: 'Не хватило места на диске сервера.' });
    await t.app.dashboard.notify.idle();
    expect(
      (await get<NotificationsResponse>(mama, '/api/notifications')).body.notifications[0],
    ).toMatchObject({ title: 'Загрузка не удалась' });
    const retried = await post(mama, `/api/downloads/${failed?.id}/retry`);
    expect(retried.status).toBe(200);
    expect(fake.calls.filter((c) => c.method === 'aria2.addTorrent')).toHaveLength(2);
    expect((await tasks(mama))[0]?.state).toBe('downloading');
  });

  it('refuses when the disk is nearly full, and a torrent that is too big', async () => {
    const sample = makeTorrent({ name: 'Огромный', length: 80 * 1024 ** 3 });
    const check = await putFile(mama, sample.bytes);
    const big = await post(mama, '/api/downloads', { checkId: check.body.checkId });
    expect(big.status).toBe(413);
    await t.app.close();
    await boot();
    const small = makeTorrent({ name: 'Нормальный', length: 5 * 1024 ** 3 });
    const ok = await putFile(mama, small.bytes);
    expect((await post(mama, '/api/downloads', { checkId: ok.body.checkId })).status).toBe(200);
  });

  it('refuses a destination that is not on the list', async () => {
    const check = await putFile(mama, SAMPLE().bytes);
    expect(
      (await post(mama, '/api/downloads', { checkId: check.body.checkId, destination: '../../Windows' }))
        .status,
    ).toBe(400);
    expect(
      (await post(mama, '/api/downloads', { checkId: check.body.checkId, destination: 'C:\\' })).status,
    ).toBe(400);
    expect(fake.calls.some((c) => c.method === 'aria2.addTorrent')).toBe(false);
  });

  it('checks that the client accepts the portal’s key', async () => {
    await fake.close();
    const wrong = await startFakeAria2({
      secret: 'f'.repeat(64),
      port: Number(new URL(t.config.torrent.rpcUrl).port),
    });
    fake = wrong;
    const state = (await get<DownloadsResponse>(mama, '/api/downloads')).body.torrentEngine;
    expect(state).toMatchObject({ state: 'down', message: 'Торрент-клиент не принимает ключ портала.' });
  });

  it('the client’s secret is made once, stays in the data folder and never reaches a browser', async () => {
    const file = JSON.parse(await readFile(path.join(t.dataDir, 'aria2-rpc.json'), 'utf8')) as {
      secret: string;
    };
    expect(file.secret).toMatch(/^[0-9a-f]{64}$/);
    const secretHash = createHash('sha256').update(file.secret).digest('hex');
    expect(secretHash).toHaveLength(64);
    const { sample } = await addSample();
    fake.progress(sample.infoHash, 100);
    const raw = JSON.stringify([
      (await t.app.inject({ url: '/api/downloads', headers: { cookie: mama } })).body,
      (await t.app.inject({ url: '/api/admin/diagnostics', headers: { cookie: papa } })).body,
    ]);
    expect(raw).not.toContain(file.secret);
  });
});

describe('trackers', () => {
  beforeEach(() => boot());

  it('keeps only trackers on the public internet; names inside the home network or resolving there are dropped', async () => {
    const sample = makeTorrent({
      name: 'Трекеры',
      length: 100,
      announce: 'http://tracker.example.org/announce',
      announceList: [
        ['http://tracker.example.org/announce'],
        ['http://router.lan/announce'],
        ['http://localhost:8096/announce'],
        ['http://10.0.0.1/announce'],
        ['http://evil.example.net/announce'],
        ['http://rebind.example.net/announce'],
        ['http://nosuchhost.example.com/announce'],
        ['ftp://t2.example.org/announce'],
        ['http://user:pw@t2.example.org/announce'],
        ['https://t2.example.org/announce'],
        ['http://[::1]/announce'],
        ['http://tailnet-pc.ts.net/announce'],
        ['http://singlelabel/announce'],
      ],
    });
    const check = await putFile(mama, sample.bytes);
    await post(mama, '/api/downloads', { checkId: check.body.checkId });
    const sent = fake.calls.find((c) => c.method === 'aria2.addTorrent') as { params: unknown[] };
    const [b64] = sent.params as [string];
    expect(parseTorrent(Buffer.from(b64, 'base64')).trackers).toEqual([
      'http://tracker.example.org/announce',
      'https://t2.example.org/announce',
    ]);
  });
});
