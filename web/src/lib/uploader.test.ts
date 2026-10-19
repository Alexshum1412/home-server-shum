import { describe, expect, it } from 'vitest';
import type { StorageRoot, StorageSpace, UploadResponse } from '../../../shared/api.ts';
import { ApiFailure, NO_CONNECTION } from '../api.ts';
import { sha256OfBlob } from './sha256.ts';
import {
  createUploader,
  isTemporary,
  OffsetError,
  type SessionMemory,
  type UploadApi,
  type UploadItem,
  type UploadSnapshot,
} from './uploader.ts';

const sleepNot = async () => undefined;

function memory(): SessionMemory & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (key) => map.get(key) ?? null,
    set: (key, id) => void map.set(key, id),
    remove: (key) => void map.delete(key),
  };
}

function file(name: string, size: number, seed = 1): File {
  const bytes = new Uint8Array(size).map((_, index) => (index * seed) % 251);
  return new File([bytes], name, { type: 'application/octet-stream', lastModified: 1_700_000_000_000 });
}

/** A server in memory: sessions with a growing copy, a list of known hashes, scripted failures. */
function fakeServer() {
  const state = {
    known: new Set<string>(),
    complete: true,
    sessions: new Map<string, { size: number; received: number; name: string }>(),
    saved: [] as Array<{ name: string; size: number }>,
    calls: [] as string[],
    failPieces: [] as Array<'network' | 'quota' | 'lost'>,
    failSingle: [] as Array<'network' | 'quota'>,
    chunk: 1000,
    sessionCounter: 0,
    forgetSessions: false,
  };
  const api: UploadApi = {
    async hashes(_space, hashes) {
      state.calls.push(`hashes:${hashes.length}`);
      return {
        known: hashes.filter((hash) => state.known.has(hash)),
        complete: state.complete,
        pending: state.complete ? 0 : 5,
      };
    },
    async putSingle(_root, params, body) {
      state.calls.push(`single:${params.name}:strip=${params.strip}:sha=${params.sha256 ? 'y' : 'n'}`);
      const failure = state.failSingle.shift();
      if (failure === 'network') throw new ApiFailure('network', NO_CONNECTION);
      if (failure === 'quota') throw new ApiFailure('http', 'Ваше место заполнено', 507, 'quota');
      state.saved.push({ name: params.name, size: body.size });
      return { name: params.name, sizeBytes: body.size, media: null, stripped: params.strip };
    },
    async startSession(_root, body) {
      state.calls.push(`start:${body.name}`);
      state.sessionCounter += 1;
      const id = `s${state.sessionCounter}`;
      state.sessions.set(id, { size: body.size, received: 0, name: body.name });
      return { id, name: body.name, size: body.size, receivedBytes: 0, chunkBytes: state.chunk };
    },
    async sessionStatus(_root, id) {
      state.calls.push(`status:${id}`);
      const session = state.sessions.get(id);
      if (!session || state.forgetSessions) return null;
      return {
        id,
        name: session.name,
        size: session.size,
        receivedBytes: session.received,
        chunkBytes: state.chunk,
      };
    },
    async putPiece(_root, id, offset, body, onProgress) {
      const session = state.sessions.get(id);
      if (!session) throw new ApiFailure('http', 'нет', 404, 'not_found');
      state.calls.push(`piece:${id}:${offset}+${body.size}`);
      const failure = state.failPieces.shift();
      if (failure === 'network') {
        // Half of the piece arrived before the line broke.
        session.received += Math.floor(body.size / 2);
        throw new ApiFailure('network', NO_CONNECTION);
      }
      if (failure === 'quota') throw new ApiFailure('http', 'Нет места', 507, 'no_space');
      if (failure === 'lost') {
        session.received += body.size; // it arrived, but the answer did not
        throw new ApiFailure('network', NO_CONNECTION);
      }
      if (offset !== session.received) throw new OffsetError(session.received);
      onProgress(body.size);
      session.received += body.size;
      return session.received;
    },
    async finish(_root, id) {
      state.calls.push(`finish:${id}`);
      const session = state.sessions.get(id);
      if (!session) throw new ApiFailure('http', 'нет', 404, 'not_found');
      if (session.received !== session.size) throw new ApiFailure('http', 'не весь', 409, 'offset_mismatch');
      state.sessions.delete(id);
      state.saved.push({ name: session.name, size: session.size });
      return { name: session.name, sizeBytes: session.size, media: null };
    },
    async cancelSession(_root, id) {
      state.sessions.delete(id);
    },
    async mkdir(_root: StorageRoot, _space: StorageSpace, path: string) {
      state.calls.push(`mkdir:${path}`);
    },
  };
  return { api, state };
}

function setup(
  options: {
    server?: ReturnType<typeof fakeServer>;
    strip?: boolean;
    duplicates?: boolean;
    single?: number;
    mem?: ReturnType<typeof memory>;
  } = {},
) {
  const server = options.server ?? fakeServer();
  const mem = options.mem ?? memory();
  const snapshots: UploadSnapshot[] = [];
  const saved: Array<{ item: UploadItem; saved: UploadResponse }> = [];
  const uploader = createUploader({
    root: 'photos',
    space: 'personal',
    api: server.api,
    memory: mem,
    strip: () => options.strip ?? true,
    checkDuplicates: () => options.duplicates ?? true,
    onChange: (snapshot) => snapshots.push(snapshot),
    afterSaved: async (item, result) => {
      saved.push({ item, saved: result });
    },
    sleep: sleepNot,
    singleMaxBytes: options.single ?? 1000,
  });
  return { uploader, server, mem, snapshots, saved };
}

const month = () => '2026-10';

describe('the upload queue', () => {
  it('sends small files in one request each, with the strip choice and the hash, and reports progress', async () => {
    const t = setup();
    t.uploader.add([file('a.jpg', 100, 1), file('b.jpg', 200, 2)], month);
    await t.uploader.start();
    const end = t.uploader.snapshot();
    expect(end).toMatchObject({
      running: false,
      doneCount: 2,
      failedCount: 0,
      leftCount: 0,
      bytesTotal: 300,
      bytesSent: 300,
    });
    expect(t.server.state.calls.filter((call) => call.startsWith('single'))).toEqual([
      'single:a.jpg:strip=true:sha=y',
      'single:b.jpg:strip=true:sha=y',
    ]);
    expect(t.server.state.calls).toContain('mkdir:2026-10');
    expect(end.items.map((item) => item.status)).toEqual(['done', 'done']);
    expect(end.items[0]?.note).toContain('Место съёмки');
    expect(t.saved.map((entry) => entry.item.name)).toEqual(['a.jpg', 'b.jpg']);
    // The queue showed what it was doing on the way.
    expect(t.snapshots.some((snapshot) => snapshot.checking !== null)).toBe(true);
    expect(t.snapshots.some((snapshot) => snapshot.items.some((item) => item.status === 'uploading'))).toBe(
      true,
    );
  });

  it('skips what the server already holds, says so, and uploads it anyway on request', async () => {
    const server = fakeServer();
    const duplicate = file('copy.jpg', 150, 3);
    server.state.known.add(await sha256OfBlob(duplicate));
    const t = setup({ server });
    t.uploader.add([duplicate, file('new.jpg', 120, 4)], month);
    await t.uploader.start();
    let end = t.uploader.snapshot();
    expect(end).toMatchObject({ doneCount: 1, skippedCount: 1, bytesTotal: 120 });
    expect(end.items[0]).toMatchObject({ status: 'skipped', note: 'Уже есть на сервере — пропущено.' });
    expect(server.state.saved.map((entry) => entry.name)).toEqual(['new.jpg']);
    // One question for all of them, not one per file.
    expect(server.state.calls.filter((call) => call.startsWith('hashes'))).toEqual(['hashes:2']);
    await t.uploader.uploadSkipped();
    end = t.uploader.snapshot();
    expect(end).toMatchObject({ doneCount: 2, skippedCount: 0 });
    expect(server.state.saved.map((entry) => entry.name)).toEqual(['new.jpg', 'copy.jpg']);
  });

  it('says when the server has not finished checking its older photos', async () => {
    const server = fakeServer();
    server.state.complete = false;
    const t = setup({ server });
    t.uploader.add([file('a.jpg', 10)], month);
    await t.uploader.start();
    expect(t.uploader.snapshot().partialCheck).toBe(true);
  });

  it('does not count hashes at all when the check is off', async () => {
    const t = setup({ duplicates: false });
    t.uploader.add([file('a.jpg', 10)], month);
    await t.uploader.start();
    expect(t.server.state.calls.some((call) => call.startsWith('hashes'))).toBe(false);
    expect(t.server.state.calls).toContain('single:a.jpg:strip=true:sha=n');
  });

  it('puts a big file through a session in pieces and forgets the session when it is done', async () => {
    const t = setup({ duplicates: false });
    t.uploader.add([file('video.mp4', 2500)], () => '');
    await t.uploader.start();
    expect(t.server.state.calls.filter((call) => call.startsWith('piece'))).toEqual([
      'piece:s1:0+1000',
      'piece:s1:1000+1000',
      'piece:s1:2000+500',
    ]);
    expect(t.uploader.snapshot()).toMatchObject({ doneCount: 1, bytesSent: 2500 });
    expect(t.mem.map.size).toBe(0);
    expect(t.server.state.saved).toEqual([{ name: 'video.mp4', size: 2500 }]);
  });

  it('goes on from where the server’s copy ends after a break — with half a piece or a lost answer', async () => {
    const t = setup({ duplicates: false });
    t.server.state.failPieces = ['network', 'lost'];
    t.uploader.add([file('video.mp4', 3000)], () => '');
    await t.uploader.start();
    const end = t.uploader.snapshot();
    expect(end).toMatchObject({ doneCount: 1, failedCount: 0 });
    const pieces = t.server.state.calls.filter((call) => call.startsWith('piece'));
    // 0+1000 broke with 500 arrived → status → 500+1000 (lost answer: 1500 arrived) → status → 1500+1000 → 2500+500.
    expect(pieces).toEqual([
      'piece:s1:0+1000',
      'piece:s1:500+1000',
      'piece:s1:1500+1000',
      'piece:s1:2500+500',
    ]);
    expect(t.server.state.saved).toEqual([{ name: 'video.mp4', size: 3000 }]);
  });

  it('takes the server’s word when it says a piece began at the wrong place', async () => {
    const t = setup({ duplicates: false });
    t.uploader.add([file('video.mp4', 2000)], () => '');
    // The first piece "arrives" twice from the server's point of view: another run already moved its copy on.
    const original = t.server.api.startSession;
    t.server.api.startSession = async (root, body) => {
      const session = await original(root, body);
      const record = t.server.state.sessions.get(session.id);
      if (record) record.received = 1000; // sessions of another tab
      return session;
    };
    await t.uploader.start();
    expect(t.uploader.snapshot().doneCount).toBe(1);
    expect(t.server.state.calls.filter((call) => call.startsWith('piece'))).toEqual([
      'piece:s1:0+1000',
      'piece:s1:1000+1000',
    ]);
  });

  it('continues an old upload when the same file is chosen again after a reload', async () => {
    const mem = memory();
    const server = fakeServer();
    const first = setup({ server, mem, duplicates: false });
    server.state.failPieces = [
      'network',
      'network',
      'network',
      'network',
      'network',
      'network',
      'network',
      'network',
      'network',
    ];
    first.uploader.add([file('video.mp4', 3000)], () => '');
    await first.uploader.start();
    expect(first.uploader.snapshot()).toMatchObject({ failedCount: 1, doneCount: 0 });
    expect(mem.map.size).toBe(1); // the session is remembered
    // A new page, the same file: the old session is asked for its position, nothing starts from zero.
    server.state.failPieces = [];
    server.state.calls.length = 0;
    const second = setup({ server, mem, duplicates: false });
    second.uploader.add([file('video.mp4', 3000)], () => '');
    await second.uploader.start();
    expect(second.uploader.snapshot().doneCount).toBe(1);
    expect(server.state.calls.some((call) => call.startsWith('start:'))).toBe(false);
    expect(server.state.calls.find((call) => call.startsWith('piece'))).toMatch(/^piece:s1:\d+\+/);
    expect(mem.map.size).toBe(0);
  });

  it('starts anew when the server has forgotten the session, and says so when it happens in the middle', async () => {
    const mem = memory();
    const server = fakeServer();
    mem.set('photos|personal||video.mp4|2500|1700000000000', 'old-session');
    const t = setup({ server, mem, duplicates: false });
    t.uploader.add([file('video.mp4', 2500)], () => '');
    await t.uploader.start();
    expect(t.uploader.snapshot().doneCount).toBe(1);
    expect(server.state.calls).toContain('start:video.mp4');
  });

  it('does not retry what will not get better: no room, a refusal; and keeps the others going', async () => {
    const t = setup({ duplicates: false });
    t.server.state.failSingle = ['quota'];
    t.uploader.add([file('a.jpg', 100), file('b.jpg', 100)], month);
    await t.uploader.start();
    const end = t.uploader.snapshot();
    expect(end.items.map((item) => item.status)).toEqual(['failed', 'done']);
    expect(end.items[0]?.note).toBe('Ваше место заполнено');
    expect(t.server.state.calls.filter((call) => call.startsWith('single:a.jpg'))).toHaveLength(1);
    // «Повторить» sends only the failed one.
    await t.uploader.retry();
    expect(t.uploader.snapshot()).toMatchObject({ doneCount: 2, failedCount: 0 });
    expect(t.server.state.saved.map((entry) => entry.name)).toEqual(['b.jpg', 'a.jpg']);
  });

  it('retries a small file when the line breaks, a few times, then gives up with plain words', async () => {
    const t = setup({ duplicates: false });
    t.server.state.failSingle = ['network', 'network'];
    t.uploader.add([file('a.jpg', 100)], month);
    await t.uploader.start();
    expect(t.uploader.snapshot().doneCount).toBe(1);
    const again = setup({ duplicates: false });
    again.server.state.failSingle = ['network', 'network', 'network', 'network', 'network'];
    again.uploader.add([file('a.jpg', 100)], month);
    await again.uploader.start();
    expect(again.uploader.snapshot().items[0]).toMatchObject({ status: 'failed', note: NO_CONNECTION });
  });

  it('stops on request and takes the stopped files up again', async () => {
    const t = setup({ duplicates: false });
    let stopped = false;
    const original = t.server.api.putSingle;
    t.server.api.putSingle = async (root, params, body, onProgress, signal) => {
      if (params.name === 'b.jpg' && !stopped) {
        stopped = true;
        t.uploader.stop();
        throw new DOMException('Остановлено', 'AbortError');
      }
      return original(root, params, body, onProgress, signal);
    };
    t.uploader.add([file('a.jpg', 50), file('b.jpg', 50), file('c.jpg', 50)], month);
    await t.uploader.start();
    const end = t.uploader.snapshot();
    expect(end.items.map((item) => item.status)).toEqual(['done', 'stopped', 'waiting']);
    expect(end.leftCount).toBe(2);
    await t.uploader.retry();
    expect(t.uploader.snapshot()).toMatchObject({ doneCount: 3, leftCount: 0 });
  });

  it('can forget a finished batch but keeps what still needs attention', async () => {
    const t = setup({ duplicates: false });
    t.server.state.failSingle = ['quota'];
    t.uploader.add([file('a.jpg', 50), file('b.jpg', 50)], month);
    await t.uploader.start();
    t.uploader.clearFinished();
    expect(t.uploader.snapshot().items.map((item) => item.name)).toEqual(['a.jpg']);
  });
});

describe('what counts as trouble that passes by itself', () => {
  it('knows a broken line, a slow server and a restarting portal, not a refusal', () => {
    expect(isTemporary(new ApiFailure('network', NO_CONNECTION))).toBe(true);
    expect(isTemporary(new ApiFailure('timeout', 'долго'))).toBe(true);
    expect(isTemporary(new ApiFailure('http', 'x', 503))).toBe(true);
    expect(isTemporary(new ApiFailure('http', 'x', 400, 'incomplete'))).toBe(true);
    expect(isTemporary(new OffsetError(5))).toBe(true);
    expect(isTemporary(new ApiFailure('http', 'x', 507, 'quota'))).toBe(false);
    expect(isTemporary(new ApiFailure('http', 'x', 422, 'blocked_type'))).toBe(false);
    expect(isTemporary(new Error('boom'))).toBe(false);
  });
});
