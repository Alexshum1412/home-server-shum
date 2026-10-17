import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadCheckResponse, DownloadsResponse, DownloadTaskView } from '../../shared/api.ts';
import { createUserStore } from '../src/auth/users.ts';
import { checkDownloadUrl, createSafeLookup, isPublicAddress } from '../src/downloads/net-guard.ts';
import { isBlockedName, resolveInside, sanitizeName } from '../src/files/names.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createTestApp,
  FAMILY,
  makeTempDir,
  removeDir,
  type TestApp,
  makeTempDir as tmp,
} from './helpers.ts';

const BIG = Buffer.alloc(3 * 1024 * 1024, 7);
for (let i = 0; i < BIG.length; i += 4096) BIG[i] = i % 251;
const SHA = createHash('sha256').update(BIG).digest('hex');
let server: Server;
let base: string;
let slowDelayMs = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/file.bin') || url.startsWith('/slow.bin')) {
      const slow = url.startsWith('/slow.bin');
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Number(range[2]) : BIG.length - 1;
      const headers: Record<string, string | number> = {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        etag: '"v1"',
        'content-length': end - start + 1,
      };
      if (range) headers['content-range'] = `bytes ${start}-${end}/${BIG.length}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') return res.end();
      const body = BIG.subarray(start, end + 1);
      if (!slow) return res.end(body);
      let pos = 0;
      const tick = () => {
        if (res.destroyed) return;
        if (pos >= body.length) return res.end();
        res.write(body.subarray(pos, pos + 64 * 1024));
        pos += 64 * 1024;
        setTimeout(tick, slowDelayMs);
      };
      tick();
      return;
    }
    if (url === '/page') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    if (url === '/setup.exe')
      return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end('MZ');
    if (url === '/to-lan') return res.writeHead(302, { location: 'http://192.168.1.1/router.cfg' }).end();
    if (url === '/to-file') return res.writeHead(302, { location: '/file.bin' }).end();
    if (url === '/named') {
      return res
        .writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': "attachment; filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82.pdf",
          'content-length': 4,
        })
        .end('%PDF');
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  slowDelayMs = 0;
});

async function app(env: Record<string, string> = {}, opts: { allowLoopback?: boolean; free?: number } = {}) {
  const filesDir = await makeTempDir('fd-files-');
  const t = await createTestApp({
    env: { FAMILY_FILES_DIR: filesDir, MIN_FREE_GB: '0.001', ...env },
    // The test source runs on 127.0.0.1; everything else stays blocked as in production.
    downloadAllowAddress:
      opts.allowLoopback === false ? undefined : (ip) => ip === '127.0.0.1' || isPublicAddress(ip),
    freeBytes: async () => opts.free ?? 500 * 1024 ** 3,
  });
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
  cleanup.push(async () => {
    await t.app.close();
    await removeDir(t.dataDir);
    await removeDir(filesDir);
  });
  return { t, filesDir };
}

async function allow(t: TestApp, username: string) {
  const store = createUserStore(t.dataDir, { clock: t.clock, reloadIntervalMs: 0 });
  const user = await store.findByUsername(username);
  if (!user) throw new Error('no user');
  await store.update(user.id, { permissions: ['downloads'] });
}

function post(t: TestApp, cookie: string, url: string, payload: unknown = {}) {
  return t.app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as object });
}

async function addDownload(t: TestApp, cookie: string, url: string): Promise<DownloadTaskView> {
  const check = await post(t, cookie, '/api/downloads/check', { url });
  expect(check.statusCode, check.body).toBe(200);
  const { checkId } = check.json() as DownloadCheckResponse;
  const res = await post(t, cookie, '/api/downloads', { checkId });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

describe('network guard', () => {
  it('lets only public internet addresses through', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.252',
      '100.116.219.8',
      '169.254.1.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd7a:115c:a1e0::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.1.1',
      '64:ff9b::7f00:1',
      'not-an-ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('rejects wrong schemes, credentials, private literals and home names before any request', () => {
    expect(checkDownloadUrl('ftp://example.com/a')).toMatchObject({ code: 'bad_url' });
    expect(checkDownloadUrl('file:///C:/Windows/win.ini')).toMatchObject({ code: 'bad_url' });
    expect(checkDownloadUrl('https://user:pw@example.com/a')).toMatchObject({ code: 'bad_url' });
    expect(checkDownloadUrl('not a url')).toMatchObject({ code: 'bad_url' });
    for (const url of [
      'http://127.0.0.1:8070/api/admin/users',
      'http://[::1]/',
      'http://192.168.1.1/',
      'http://localhost/',
      'http://server-home.tail89d77e.ts.net/',
      'http://printer.local/',
      'http://0x7f000001/',
      'http://2130706433/',
    ]) {
      expect(checkDownloadUrl(url), url).toMatchObject({ code: 'private_address' });
    }
    expect('url' in checkDownloadUrl('https://example.com/film.mkv')).toBe(true);
  });

  it('refuses a name that resolves to this PC at connection time', async () => {
    const lookup = createSafeLookup();
    const error = await new Promise<Error | null>((resolve) =>
      (lookup as unknown as (h: string, o: object, cb: (e: Error | null) => void) => void)(
        'localhost',
        {},
        (e) => resolve(e),
      ),
    );
    expect(error?.message).toMatch(/внутрь домашней сети/);
  });
});

describe('safe names', () => {
  it('cleans names and blocks programs', () => {
    expect(sanitizeName('..\\..\\Windows\\win.ini')).toBe('.._.._Windows_win.ini');
    expect(sanitizeName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeName('file.txt:secret')).toBe('file.txt_secret');
    expect(sanitizeName('film. . ')).toBe('film');
    expect(sanitizeName('..')).toBeNull();
    expect(isBlockedName('film.mp4.exe')).toBe(true);
    expect(isBlockedName('SCRIPT.PS1')).toBe(true);
    expect(isBlockedName('Отчёт.pdf')).toBe(false);
    expect(resolveInside('C:\\root', '..\\x')).toBeNull();
    expect(resolveInside('C:\\root', 'a/b.txt')).toBe(path.resolve('C:\\root', 'a', 'b.txt'));
    expect(resolveInside('C:\\root', 'a:b')).toBeNull();
  });
});

describe('download queue API', { timeout: 60_000 }, () => {
  it('needs the downloads right; admins have it', async () => {
    const { t } = await app();
    const family = await cookieFor(t.app, FAMILY);
    const list = await t.app.inject({ url: '/api/downloads', headers: { cookie: family } });
    expect((list.json() as DownloadsResponse).allowed).toBe(false);
    const check = await post(t, family, '/api/downloads/check', { url: `${base}/file.bin` });
    expect(check.statusCode).toBe(403);
    expect(check.json().message).toMatch(/allow/);
    const admin = await cookieFor(t.app, ADMIN);
    expect((await post(t, admin, '/api/downloads/check', { url: `${base}/file.bin` })).statusCode).toBe(200);
  });

  it('downloads a confirmed link into the owner’s folder, byte for byte, marked as from the internet', async () => {
    const { t, filesDir } = await app();
    await allow(t, 'mama');
    const cookie = await cookieFor(t.app, FAMILY);
    const check = await post(t, cookie, '/api/downloads/check', { url: `${base}/to-file` });
    const info = check.json() as DownloadCheckResponse;
    expect(info).toMatchObject({ fileName: 'file.bin', sizeBytes: BIG.length, resumable: true });
    const task = (
      await post(t, cookie, '/api/downloads', { checkId: info.checkId })
    ).json() as DownloadTaskView;
    await t.app.dashboard.downloads.idle();
    const list = (
      await t.app.inject({ url: '/api/downloads', headers: { cookie } })
    ).json() as DownloadsResponse;
    expect(list.tasks[0]).toMatchObject({ id: task.id, state: 'completed', receivedBytes: BIG.length });
    const file = path.join(filesDir, 'users', 'mama', 'Загрузки', 'file.bin');
    expect(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ).toBe(SHA);
    if (process.platform === 'win32') {
      expect(await readFile(`${file}:Zone.Identifier`, 'utf8')).toContain('ZoneId=3');
    }
    // The check id is single-use.
    expect((await post(t, cookie, '/api/downloads', { checkId: info.checkId })).statusCode).toBe(400);
  });

  it('uses the name from Content-Disposition', async () => {
    const { t, filesDir } = await app();
    const admin = await cookieFor(t.app, ADMIN);
    await addDownload(t, admin, `${base}/named`);
    await t.app.dashboard.downloads.idle();
    expect(existsSync(path.join(filesDir, 'users', 'papa', 'Загрузки', 'Отчёт.pdf'))).toBe(true);
  });

  it('pauses, resumes with a Range request and still gets the exact file; cancel removes the part', async () => {
    slowDelayMs = 30;
    const { t, filesDir } = await app();
    const admin = await cookieFor(t.app, ADMIN);
    const task = await addDownload(t, admin, `${base}/slow.bin`);
    await new Promise((r) => setTimeout(r, 300));
    const paused = (await post(t, admin, `/api/downloads/${task.id}/pause`)).json() as DownloadTaskView;
    expect(paused.state).toBe('paused');
    expect(paused.receivedBytes).toBeGreaterThan(0);
    expect(paused.receivedBytes).toBeLessThan(BIG.length);
    // A second identical link while one is in the queue is refused.
    const dupCheck = (await post(t, admin, '/api/downloads/check', { url: `${base}/slow.bin` })).json();
    expect((await post(t, admin, '/api/downloads', { checkId: dupCheck.checkId })).statusCode).toBe(409);
    slowDelayMs = 0;
    await post(t, admin, `/api/downloads/${task.id}/resume`);
    await new Promise((r) => setTimeout(r, 50));
    await t.app.dashboard.downloads.idle();
    const file = path.join(filesDir, 'users', 'papa', 'Загрузки', 'slow.bin');
    expect(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ).toBe(SHA);

    slowDelayMs = 30;
    const second = (await addDownload(t, admin, `${base}/slow.bin?again=1`)) as DownloadTaskView;
    await new Promise((r) => setTimeout(r, 200));
    const canceled = (await post(t, admin, `/api/downloads/${second.id}/cancel`)).json() as DownloadTaskView;
    expect(canceled.state).toBe('canceled');
    const left = await readdir(path.join(filesDir, 'users', 'papa', 'Загрузки'));
    expect(left.filter((n) => n.endsWith('.part'))).toEqual([]);
    expect((await post(t, admin, `/api/downloads/${second.id}/remove`)).statusCode).toBe(204);
  });

  it('refuses pages, programs, files over the limit, redirects into the LAN and missing files', async () => {
    const { t } = await app({ DOWNLOAD_MAX_FILE_GB: '0.001' });
    const admin = await cookieFor(t.app, ADMIN);
    const check = async (url: string) => post(t, admin, '/api/downloads/check', { url });
    expect((await check(`${base}/page`)).json().error).toBe('not_a_file');
    expect((await check(`${base}/setup.exe`)).json().error).toBe('blocked_type');
    expect((await check(`${base}/file.bin`)).statusCode).toBe(413);
    const lan = await check(`${base}/to-lan`);
    expect(lan.statusCode).toBe(403);
    expect(lan.json().error).toBe('private_address');
    expect((await check(`${base}/missing`)).statusCode).toBe(502);
    expect((await check('javascript:alert(1)')).statusCode).toBe(400);
  });

  it('with the real guard, never fetches from this PC', async () => {
    const { t } = await app({}, { allowLoopback: false });
    const admin = await cookieFor(t.app, ADMIN);
    for (const url of [`${base}/file.bin`, base.replace('127.0.0.1', 'localhost')]) {
      const res = await post(t, admin, '/api/downloads/check', { url });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error).toBe('private_address');
    }
  });

  it('refuses to start when the disk is nearly full', async () => {
    const { t } = await app({ MIN_FREE_GB: '10' }, { free: 5 * 1024 ** 3 });
    const admin = await cookieFor(t.app, ADMIN);
    const info = (await post(t, admin, '/api/downloads/check', { url: `${base}/file.bin` })).json();
    const res = await post(t, admin, '/api/downloads', { checkId: info.checkId });
    expect(res.statusCode).toBe(507);
    expect(res.json().error).toBe('no_space');
  });

  it('reports an unavailable storage folder instead of crashing', async () => {
    const broken = await tmp('fd-broken-');
    const asFile = path.join(broken, 'not-a-dir');
    await writeFile(asFile, 'x');
    const { t } = await app({ FAMILY_FILES_DIR: asFile });
    cleanup.push(() => removeDir(broken));
    const admin = await cookieFor(t.app, ADMIN);
    const info = (await post(t, admin, '/api/downloads/check', { url: `${base}/file.bin` })).json();
    const res = await post(t, admin, '/api/downloads', { checkId: info.checkId });
    expect(res.statusCode).toBe(507);
    expect(res.json()).toMatchObject({ error: 'storage_error' });
  });

  it('keeps tasks private: another member cannot see or cancel them, the admin can', async () => {
    slowDelayMs = 50;
    const { t } = await app();
    await allow(t, 'mama');
    await addUser(t.dataDir, t.clock, { username: 'son', password: 'son-password-12', role: 'family' });
    await allow(t, 'son');
    const mama = await cookieFor(t.app, FAMILY);
    const son = await cookieFor(t.app, { username: 'son', password: 'son-password-12' });
    const task = await addDownload(t, mama, `${base}/slow.bin`);
    const sonList = (
      await t.app.inject({ url: '/api/downloads', headers: { cookie: son } })
    ).json() as DownloadsResponse;
    expect(sonList.tasks).toEqual([]);
    expect((await post(t, son, `/api/downloads/${task.id}/cancel`)).statusCode).toBe(404);
    const admin = await cookieFor(t.app, ADMIN);
    const adminList = (
      await t.app.inject({ url: '/api/downloads', headers: { cookie: admin } })
    ).json() as DownloadsResponse;
    expect(adminList.tasks.map((x) => x.owner)).toContain('mama');
    expect(
      ((await post(t, admin, `/api/downloads/${task.id}/cancel`)).json() as DownloadTaskView).state,
    ).toBe('canceled');
  });
});
