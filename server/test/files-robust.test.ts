import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileListResponse, UploadResponse } from '../../shared/api.ts';
import type {
  AlbumsResponse,
  HashQueryResponse,
  TrashResponse,
  UploadSessionState,
} from '../../shared/storage-extras.ts';
import { sanitizeName } from '../src/files/names.ts';
import { SESSION_MAX_AGE_MS } from '../src/files/sessions.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createTestApp,
  FAMILY,
  makeTempDir,
  removeDir,
  type TestApp,
} from './helpers.ts';

const SON = { username: 'son', password: 'son-password-12', role: 'family' as const };
const GPS = 'GPSCANARY-N55.7558-E37.6173';

/** A small JPEG (valid segments, not a decodable picture) with a readable GPS-like text in an EXIF segment. */
function photo(extra = 0): Buffer {
  const segment = (marker: number, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt8(0xff, 0);
    head.writeUInt8(marker, 1);
    head.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'latin1')),
    segment(0xe1, Buffer.from(`Exif\0\0MM\0*\0\0\0\b\0\0\0\0\0\0${GPS}\0`, 'latin1')),
    segment(0xdb, Buffer.alloc(65, 7)),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.alloc(300 + extra, 0x55),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup(env: Record<string, string> = {}) {
  const filesDir = await makeTempDir('fd-rfiles-');
  const photosDir = await makeTempDir('fd-rphotos-');
  const t = await createTestApp({
    env: { FAMILY_FILES_DIR: filesDir, FAMILY_PHOTOS_DIR: photosDir, MIN_FREE_GB: '0', ...env },
    freeBytes: async () => 500 * 1024 ** 3,
  });
  for (const user of [ADMIN, FAMILY, SON]) await addUser(t.dataDir, t.clock, user);
  cleanup.push(async () => {
    await t.app.close();
    for (const dir of [t.dataDir, filesDir, photosDir]) await removeDir(dir);
  });
  return {
    t,
    filesDir,
    photosDir,
    mama: await cookieFor(t.app, FAMILY),
    son: await cookieFor(t.app, SON),
    admin: await cookieFor(t.app, ADMIN),
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const json = (t: TestApp, cookie: string, url: string, payload: object) =>
  t.app.inject({ method: 'POST', url, headers: { cookie }, payload });

const put = (t: TestApp, cookie: string, url: string, body: Buffer) =>
  t.app.inject({
    method: 'PUT',
    url,
    headers: { cookie, 'content-type': 'application/octet-stream', 'x-upload': '1' },
    payload: body,
  });

const list = (t: TestApp, cookie: string, root: string, space: string, p = '') =>
  t.app.inject({
    url: `/api/storage/${root}/list?space=${space}&path=${encodeURIComponent(p)}`,
    headers: { cookie },
  });

const names = async (t: TestApp, cookie: string, root: string, space: string, p = '') =>
  ((await list(t, cookie, root, space, p)).json() as FileListResponse).entries.map((entry) => entry.name);

async function start(
  c: Ctx,
  cookie: string,
  body: {
    root?: string;
    space?: string;
    path?: string;
    name: string;
    size: number;
    strip?: boolean;
    sha256?: string;
  },
) {
  const { root = 'files', ...rest } = body;
  return json(c.t, cookie, `/api/storage/${root}/session`, { space: 'personal', path: '', ...rest });
}

const piece = (c: Ctx, cookie: string, root: string, id: string, offset: number, data: Buffer) =>
  put(c.t, cookie, `/api/storage/${root}/session/${id}?offset=${offset}`, data);

describe('uploads that survive a broken connection', { timeout: 60_000 }, () => {
  it('takes a file in pieces, tells the true position after a mistake, and places it only at the end', async () => {
    const c = await setup();
    const data = Buffer.from(Array.from({ length: 30_000 }, (_, index) => index % 251));
    const begun = await start(c, c.mama, { name: 'видео.mp4', size: data.length });
    expect(begun.statusCode, begun.body).toBe(200);
    const session = begun.json() as UploadSessionState;
    expect(session.receivedBytes).toBe(0);

    expect((await piece(c, c.mama, 'files', session.id, 0, data.subarray(0, 10_000))).json()).toEqual({
      receivedBytes: 10_000,
    });
    // The same piece again (the phone did not hear the answer): refused, with the place where the server is.
    const again = await piece(c, c.mama, 'files', session.id, 0, data.subarray(0, 10_000));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'offset_mismatch', receivedBytes: 10_000 });
    // A piece that skips ahead: refused as well.
    const skipped = await piece(c, c.mama, 'files', session.id, 20_000, data.subarray(20_000));
    expect(skipped.statusCode).toBe(409);
    expect(skipped.json()).toMatchObject({ receivedBytes: 10_000 });
    // After a break the phone asks where to go on.
    const state = await t_status(c, c.mama, 'files', session.id);
    expect(state.receivedBytes).toBe(10_000);
    // Not finished yet: nothing is in the folder, and the parts are not listed.
    expect(await names(c.t, c.mama, 'files', 'personal')).toEqual([]);
    expect((await finish(c, c.mama, 'files', session.id)).statusCode).toBe(409);

    await piece(c, c.mama, 'files', session.id, 10_000, data.subarray(10_000, 20_000));
    await piece(c, c.mama, 'files', session.id, 20_000, data.subarray(20_000));
    const done = await finish(c, c.mama, 'files', session.id);
    expect(done.statusCode, done.body).toBe(200);
    const result = done.json() as UploadResponse;
    expect(result).toMatchObject({ name: 'видео.mp4', sizeBytes: 30_000, sha256: sha(data) });
    expect(await names(c.t, c.mama, 'files', 'personal')).toEqual(['видео.mp4']);
    expect((await readFile(path.join(c.filesDir, 'users', 'mama', 'видео.mp4'))).equals(data)).toBe(true);
    // The temporary parts are gone.
    expect(await readdir(path.join(c.filesDir, 'users', 'mama', '.uploads'))).toEqual([]);
    // A second file with the same name never replaces the first.
    const second = (await start(c, c.mama, { name: 'видео.mp4', size: 3 })).json() as UploadSessionState;
    await piece(c, c.mama, 'files', second.id, 0, Buffer.from('abc'));
    expect(((await finish(c, c.mama, 'files', second.id)).json() as UploadResponse).name).toBe(
      'видео (2).mp4',
    );
  });

  it('goes on after the server was restarted (the hash is then read from the file)', async () => {
    const c = await setup();
    const data = Buffer.from('x'.repeat(5000));
    const session = (
      await start(c, c.mama, { name: 'a.txt', size: 5000, sha256: sha(data) })
    ).json() as UploadSessionState;
    await piece(c, c.mama, 'files', session.id, 0, data.subarray(0, 2000));
    // A second app on the same folders stands in for the restarted portal: it knows the session only from disk.
    const again = await createTestApp({
      dataDir: c.t.dataDir,
      clock: c.t.clock,
      env: { FAMILY_FILES_DIR: c.filesDir, FAMILY_PHOTOS_DIR: c.photosDir, MIN_FREE_GB: '0' },
      freeBytes: async () => 500 * 1024 ** 3,
    });
    cleanup.push(() => again.app.close());
    const cookie = await cookieFor(again.app, FAMILY);
    const ctx = { ...c, t: again, mama: cookie } as Ctx;
    expect((await t_status(ctx, cookie, 'files', session.id)).receivedBytes).toBe(2000);
    await piece(ctx, cookie, 'files', session.id, 2000, data.subarray(2000));
    const done = await finish(ctx, cookie, 'files', session.id);
    expect(done.statusCode, done.body).toBe(200);
    expect((await readFile(path.join(c.filesDir, 'users', 'mama', 'a.txt'))).equals(data)).toBe(true);
  });

  it('checks the hash at the end and throws away a file that arrived damaged', async () => {
    const c = await setup();
    const data = Buffer.from('правда'.repeat(100));
    const session = (
      await start(c, c.mama, { name: 'b.txt', size: data.length, sha256: sha(Buffer.from('другое')) })
    ).json() as UploadSessionState;
    await piece(c, c.mama, 'files', session.id, 0, data);
    const done = await finish(c, c.mama, 'files', session.id);
    expect(done.statusCode).toBe(422);
    expect((done.json() as { error: string }).error).toBe('hash_mismatch');
    expect(await names(c.t, c.mama, 'files', 'personal')).toEqual([]);
    expect((await t_raw(c, c.mama, 'files', session.id)).statusCode).toBe(404);
  });

  it('keeps every rule of an ordinary upload: no programs, only pictures in the photos, size, free space', async () => {
    const c = await setup();
    expect((await start(c, c.mama, { name: 'setup.exe', size: 10 })).statusCode).toBe(422);
    expect((await start(c, c.mama, { name: '.hidden', size: 10 })).statusCode).toBe(400);
    expect((await start(c, c.mama, { name: 'a.txt', size: -1 })).statusCode).toBe(400);
    expect((await start(c, c.mama, { name: 'a.txt', size: 1e15 })).statusCode).toBe(413);
    // A program under another name is found by what it is made of.
    const exe = (await start(c, c.mama, { name: 'doc.txt', size: 100 })).json() as UploadSessionState;
    await piece(c, c.mama, 'files', exe.id, 0, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(98)]));
    expect((await finish(c, c.mama, 'files', exe.id)).statusCode).toBe(422);
    // «Фото»: a text file is not a photo.
    const text = (
      await start(c, c.mama, { root: 'photos', name: 'нет.jpg', size: 100 })
    ).json() as UploadSessionState;
    await piece(c, c.mama, 'photos', text.id, 0, Buffer.alloc(100, 0x41));
    expect((await finish(c, c.mama, 'photos', text.id)).statusCode).toBe(415);
    expect(await names(c.t, c.mama, 'photos', 'personal')).toEqual([]);
    // Too big a piece, or one that goes past the end.
    const big = (await start(c, c.mama, { name: 'c.txt', size: 10 })).json() as UploadSessionState;
    expect((await piece(c, c.mama, 'files', big.id, 0, Buffer.alloc(11))).statusCode).toBe(413);
    expect((await put(c.t, c.mama, `/api/storage/files/session/${big.id}`, Buffer.alloc(3))).statusCode).toBe(
      400,
    );
  });

  it('is only for the person who started it, and the id is nothing a person can guess or turn into a path', async () => {
    const c = await setup();
    const session = (await start(c, c.mama, { name: 'a.txt', size: 3 })).json() as UploadSessionState;
    for (const other of [c.son, c.admin]) {
      expect((await t_raw(c, other, 'files', session.id)).statusCode).toBe(404);
      expect((await piece(c, other, 'files', session.id, 0, Buffer.from('abc'))).statusCode).toBe(404);
      expect((await finish(c, other, 'files', session.id)).statusCode).toBe(404);
    }
    for (const id of ['../../x', '..%2F..%2Fa', 'zz', session.id.toUpperCase(), `${session.id}.json`]) {
      const res = await c.t.app.inject({
        url: `/api/storage/files/session/${id}`,
        headers: { cookie: c.mama },
      });
      expect(res.statusCode, id).toBeGreaterThanOrEqual(400);
    }
    // The other person's attempt to cancel changes nothing.
    await json(c.t, c.son, `/api/storage/files/session/${session.id}/cancel`, {});
    expect((await t_status(c, c.mama, 'files', session.id)).receivedBytes).toBe(0);
    // The owner may cancel; the parts disappear.
    await json(c.t, c.mama, `/api/storage/files/session/${session.id}/cancel`, {});
    expect((await t_raw(c, c.mama, 'files', session.id)).statusCode).toBe(404);
    expect(await readdir(path.join(c.filesDir, 'users', 'mama', '.uploads'))).toEqual([]);
  });

  it('removes sessions that nobody finished within a day, and limits how many a person may leave open', async () => {
    const c = await setup();
    const old = (await start(c, c.mama, { name: 'old.txt', size: 5 })).json() as UploadSessionState;
    const parts = path.join(c.filesDir, 'users', 'mama', '.uploads');
    expect(await readdir(parts)).toHaveLength(2);
    // A day and a bit later the portal starts again (its sweep runs at the start): the old session is gone, a new one stays.
    c.t.clock.advance(SESSION_MAX_AGE_MS + 60_000);
    const fresh = (await start(c, c.mama, { name: 'new.txt', size: 5 })).json() as UploadSessionState;
    const later = await createTestApp({
      dataDir: c.t.dataDir,
      clock: c.t.clock,
      startBackground: true,
      env: { FAMILY_FILES_DIR: c.filesDir, FAMILY_PHOTOS_DIR: c.photosDir, MIN_FREE_GB: '0' },
      freeBytes: async () => 500 * 1024 ** 3,
    });
    cleanup.push(() => later.app.close());
    await later.app.ready();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await readdir(parts)).toEqual([`${fresh.id}.json`, `${fresh.id}.part`].sort());
    expect(old.id).not.toBe(fresh.id);
    // Leftover parts without a record are removed by the cleanup of the family folders once they are old.
    await writeFile(path.join(parts, 'leftover.part'), 'x');
    const { removeStaleTempFiles } = await import('../src/files/cleanup.ts');
    const removed = await removeStaleTempFiles(c.filesDir, Date.now() + 2 * SESSION_MAX_AGE_MS);
    expect(removed.some((file) => file.endsWith('leftover.part'))).toBe(true);
    expect(await readdir(parts)).toEqual([]);
    // Thirty open sessions are the most a person may hold.
    let refused = 0;
    for (let n = 0; n < 32; n += 1) {
      const res = await start(c, c.son, { name: `f${n}.txt`, size: 5 });
      if (res.statusCode === 429) refused += 1;
    }
    expect(refused).toBe(2);
  });
});

function t_raw(c: Ctx, cookie: string, root: string, id: string) {
  return c.t.app.inject({ url: `/api/storage/${root}/session/${id}`, headers: { cookie } });
}

async function t_status(c: Ctx, cookie: string, root: string, id: string) {
  return (await t_raw(c, cookie, root, id)).json() as UploadSessionState;
}

function finish(c: Ctx, cookie: string, root: string, id: string) {
  return json(c.t, cookie, `/api/storage/${root}/session/${id}/finish`, {});
}

describe('the place of shooting and the camera are taken out of a JPEG', { timeout: 60_000 }, () => {
  it('on the ordinary upload: the canary is gone, the answer says so, and the hash is of the file as it was sent', async () => {
    const c = await setup();
    const original = photo();
    expect(original.includes(GPS)).toBe(true);
    const query = (strip: string) =>
      `/api/storage/photos/upload?space=personal&path=2026-10&name=a${strip}.jpg&size=${original.length}&strip=${strip}`;
    await json(c.t, c.mama, '/api/storage/photos/mkdir', { space: 'personal', path: '', name: '2026-10' });
    const stripped = await put(c.t, c.mama, query('1'), original);
    expect(stripped.statusCode, stripped.body).toBe(200);
    const result = stripped.json() as UploadResponse;
    expect(result.stripped).toBe(true);
    expect(result.sha256).toBe(sha(original));
    expect(result.sizeBytes).toBeLessThan(original.length);
    const stored = await readFile(path.join(c.photosDir, 'users', 'mama', '2026-10', result.name));
    expect(stored.includes(GPS)).toBe(false);
    expect(stored.length).toBe(result.sizeBytes);
    // «Keep as it is» keeps the file exactly.
    const kept = (await put(c.t, c.mama, query('0'), original)).json() as UploadResponse;
    expect(kept.stripped).toBe(false);
    expect(
      (await readFile(path.join(c.photosDir, 'users', 'mama', '2026-10', kept.name))).equals(original),
    ).toBe(true);
  });

  it('in a resumable upload as well, and a PNG is stored as it is', async () => {
    const c = await setup();
    const original = photo(5000);
    const session = (
      await start(c, c.mama, { root: 'photos', path: '', name: 'b.jpg', size: original.length, strip: true })
    ).json() as UploadSessionState;
    await piece(c, c.mama, 'photos', session.id, 0, original.subarray(0, 2000));
    await piece(c, c.mama, 'photos', session.id, 2000, original.subarray(2000));
    const done = (await finish(c, c.mama, 'photos', session.id)).json() as UploadResponse;
    expect(done.stripped).toBe(true);
    expect(done.sha256).toBe(sha(original));
    const stored = await readFile(path.join(c.photosDir, 'users', 'mama', done.name));
    expect(stored.includes(GPS)).toBe(false);
    expect(stored.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(100, 3),
    ]);
    const second = (
      await start(c, c.mama, { root: 'photos', path: '', name: 'c.png', size: png.length, strip: true })
    ).json() as UploadSessionState;
    await piece(c, c.mama, 'photos', second.id, 0, png);
    const result = (await finish(c, c.mama, 'photos', second.id)).json() as UploadResponse;
    expect(result.stripped).toBe(false);
    expect((await readFile(path.join(c.photosDir, 'users', 'mama', result.name))).equals(png)).toBe(true);
  });
});

describe('«это фото у нас уже есть»', { timeout: 60_000 }, () => {
  const ask = async (c: Ctx, cookie: string, space: string, hashes: string[]) =>
    (await json(c.t, cookie, '/api/storage/photos/hashes', { space, hashes })).json() as HashQueryResponse;

  it('knows what was uploaded (by the hash of the file as it was sent), per space, and forgets what is in the trash', async () => {
    const c = await setup();
    const original = photo();
    await put(
      c.t,
      c.mama,
      `/api/storage/photos/upload?space=personal&path=&name=a.jpg&size=${original.length}&strip=1`,
      original,
    );
    const other = photo(77);
    const answer = await ask(c, c.mama, 'personal', [sha(original), sha(other)]);
    expect(answer.known).toEqual([sha(original)]);
    // Another person's photos are not looked at, and neither is the shared space for a personal question.
    expect((await ask(c, c.son, 'personal', [sha(original)])).known).toEqual([]);
    expect((await ask(c, c.mama, 'shared', [sha(original)])).known).toEqual([]);
    // In the trash it is no longer «there».
    await json(c.t, c.mama, '/api/storage/photos/trash', { space: 'personal', path: 'a.jpg' });
    expect((await ask(c, c.mama, 'personal', [sha(original)])).known).toEqual([]);
  });

  it('checks the photos that were there before in the background, and says it has not finished yet', async () => {
    const c = await setup();
    const older = [photo(1), photo(2), photo(3)];
    await mkdir(path.join(c.photosDir, 'users', 'mama', '2025-01'), { recursive: true });
    for (const [n, data] of older.entries())
      await writeFile(path.join(c.photosDir, 'users', 'mama', '2025-01', `old${n}.jpg`), data);
    const wanted = older.map(sha);
    const first = await ask(c, c.mama, 'personal', wanted);
    expect(first.pending).toBeGreaterThan(0);
    expect(first.complete).toBe(false);
    let last = first;
    for (let attempt = 0; attempt < 100 && !last.complete; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      last = await ask(c, c.mama, 'personal', wanted);
    }
    expect(last.complete).toBe(true);
    expect(last.known.sort()).toEqual([...wanted].sort());
  });

  it('refuses nonsense: not a hash, too many, nobody signed in', async () => {
    const c = await setup();
    expect(
      (await json(c.t, c.mama, '/api/storage/photos/hashes', { space: 'personal', hashes: ['abc'] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await json(c.t, c.mama, '/api/storage/photos/hashes', { space: 'personal', hashes: [] })).statusCode,
    ).toBe(400);
    expect(
      (
        await json(c.t, c.mama, '/api/storage/photos/hashes', {
          space: 'elsewhere',
          hashes: [sha(Buffer.from('a'))],
        })
      ).statusCode,
    ).toBe(400);
    const many = Array.from({ length: 201 }, (_, n) => sha(Buffer.from(String(n))));
    expect(
      (await json(c.t, c.mama, '/api/storage/photos/hashes', { space: 'personal', hashes: many })).statusCode,
    ).toBe(400);
    expect(
      (
        await c.t.app.inject({
          method: 'POST',
          url: '/api/storage/photos/hashes',
          payload: { space: 'personal', hashes: [sha(Buffer.from('a'))] },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('the limit of a person’s own space', { timeout: 60_000 }, () => {
  it('warns from 90 %, refuses at 100 %, leaves the shared space alone, and frees room when something goes to the trash', async () => {
    // 1 MB per person.
    const c = await setup({ USER_QUOTA_GB: '0.001' });
    const limit = Math.round(0.001 * 1024 ** 3);
    const state = async () =>
      ((await list(c.t, c.mama, 'files', 'personal')).json() as FileListResponse).quota;
    expect(await state()).toMatchObject({ level: 'ok', limitBytes: limit });
    const big = Buffer.alloc(Math.round(limit * 0.92), 7);
    const ok = await put(
      c.t,
      c.mama,
      `/api/storage/files/upload?space=personal&path=&name=big.bin&size=${big.length}`,
      big,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await state())?.level).toBe('warn');
    const more = Buffer.alloc(Math.round(limit * 0.2), 1);
    const refused = await put(
      c.t,
      c.mama,
      `/api/storage/files/upload?space=personal&path=&name=more.bin&size=${more.length}`,
      more,
    );
    expect(refused.statusCode).toBe(507);
    expect((refused.json() as { error: string; message: string }).error).toBe('quota');
    expect((refused.json() as { message: string }).message).toContain('Ваше место заполнено');
    // The refusal comes before a session is made as well.
    expect((await start(c, c.mama, { name: 'more.bin', size: more.length })).statusCode).toBe(507);
    // The shared space has no personal limit, and another person has their own room.
    expect(
      (
        await put(
          c.t,
          c.mama,
          `/api/storage/files/upload?space=shared&path=&name=more.bin&size=${more.length}`,
          more,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await put(
          c.t,
          c.son,
          `/api/storage/files/upload?space=personal&path=&name=mine.bin&size=${more.length}`,
          more,
        )
      ).statusCode,
    ).toBe(200);
    expect((await list(c.t, c.son, 'files', 'shared')).json()).toMatchObject({ quota: null });
    // The trash gives the room back at once.
    await json(c.t, c.mama, '/api/storage/files/trash', { space: 'personal', path: 'big.bin' });
    expect((await state())?.level).toBe('ok');
    expect(
      (
        await put(
          c.t,
          c.mama,
          `/api/storage/files/upload?space=personal&path=&name=more.bin&size=${more.length}`,
          more,
        )
      ).statusCode,
    ).toBe(200);
  });

  it('is off when no limit is set', async () => {
    const c = await setup();
    expect(((await list(c.t, c.mama, 'files', 'personal')).json() as FileListResponse).quota).toBeNull();
  });
});

describe('the trash can be looked at and put back from; nothing is deleted for good', {
  timeout: 60_000,
}, () => {
  async function seed(c: Ctx) {
    await json(c.t, c.mama, '/api/storage/files/mkdir', { space: 'personal', path: '', name: 'Документы' });
    await put(
      c.t,
      c.mama,
      '/api/storage/files/upload?space=personal&path=%D0%94%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B&name=%D0%B4%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80.txt&size=5',
      Buffer.from('текст').subarray(0, 5),
    );
  }
  const trashOf = async (c: Ctx, cookie: string, space = 'personal') =>
    (
      (
        await c.t.app.inject({ url: `/api/storage/files/trash?space=${space}`, headers: { cookie } })
      ).json() as TrashResponse
    ).entries;

  it('lists what was deleted with the old name and folder, and returns it to that folder under a free name', async () => {
    const c = await setup();
    await seed(c);
    await json(c.t, c.mama, '/api/storage/files/trash', { space: 'personal', path: 'Документы/договор.txt' });
    const entries = await trashOf(c, c.mama);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'договор.txt', type: 'file', from: 'Документы' });
    expect(entries[0]?.deletedAt).toMatch(/^\d{4}-/);
    // A new file of the same name came meanwhile: the old one comes back as «(2)».
    await put(
      c.t,
      c.mama,
      '/api/storage/files/upload?space=personal&path=%D0%94%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B&name=%D0%B4%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80.txt&size=3',
      Buffer.from('new'),
    );
    const back = await json(c.t, c.mama, '/api/storage/files/restore', {
      space: 'personal',
      id: entries[0]?.id,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toEqual({ name: 'договор (2).txt', folder: 'Документы' });
    expect(await names(c.t, c.mama, 'files', 'personal', 'Документы')).toEqual([
      'договор (2).txt',
      'договор.txt',
    ]);
    expect(await trashOf(c, c.mama)).toEqual([]);
  });

  it('puts it at the top when the folder it came from is gone', async () => {
    const c = await setup();
    await seed(c);
    await json(c.t, c.mama, '/api/storage/files/trash', { space: 'personal', path: 'Документы/договор.txt' });
    await json(c.t, c.mama, '/api/storage/files/trash', { space: 'personal', path: 'Документы' });
    const entries = await trashOf(c, c.mama);
    const file = entries.find((entry) => entry.type === 'file');
    const back = await json(c.t, c.mama, '/api/storage/files/restore', { space: 'personal', id: file?.id });
    expect(back.json()).toEqual({ name: 'договор.txt', folder: '' });
    expect(await names(c.t, c.mama, 'files', 'personal')).toEqual(['договор.txt']);
    // A folder comes back whole.
    const folder = (await trashOf(c, c.mama)).find((entry) => entry.type === 'dir');
    expect(folder?.name).toBe('Документы');
    expect(
      (await json(c.t, c.mama, '/api/storage/files/restore', { space: 'personal', id: folder?.id }))
        .statusCode,
    ).toBe(200);
    expect(await names(c.t, c.mama, 'files', 'personal')).toEqual(['Документы', 'договор.txt']);
  });

  it('shows each person their own trash only, and refuses ids that are not plain names of the trash', async () => {
    const c = await setup();
    await seed(c);
    await json(c.t, c.mama, '/api/storage/files/trash', { space: 'personal', path: 'Документы/договор.txt' });
    const id = (await trashOf(c, c.mama))[0]?.id;
    for (const other of [c.son, c.admin]) {
      expect(await trashOf(c, other)).toEqual([]);
      expect(
        (await json(c.t, other, '/api/storage/files/restore', { space: 'personal', id })).statusCode,
      ).toBe(404);
    }
    for (const bad of ['../x', '..\\x', 'a/b', '.index', '', 'C:\\Windows', `${id}/../..`]) {
      const res = await json(c.t, c.mama, '/api/storage/files/restore', { space: 'personal', id: bad });
      expect([400, 404], bad).toContain(res.statusCode);
    }
    // Nothing was lost by the attempts.
    expect(await trashOf(c, c.mama)).toHaveLength(1);
    // A program that was somehow in the trash is not put back under a program name either.
    expect(
      (await json(c.t, c.mama, '/api/storage/files/restore', { space: 'personal', id })).statusCode,
    ).toBe(200);
  });
});

describe('moving, albums, the torrent client’s control files', { timeout: 60_000 }, () => {
  it('moves into another folder of the same space, never into itself, and numbers a clash', async () => {
    const c = await setup();
    const mk = (name: string, p = '') =>
      json(c.t, c.mama, '/api/storage/files/mkdir', { space: 'personal', path: p, name });
    await mk('A');
    await mk('B');
    await mk('inner', 'A');
    await put(
      c.t,
      c.mama,
      '/api/storage/files/upload?space=personal&path=A&name=f.txt&size=1',
      Buffer.from('1'),
    );
    await put(
      c.t,
      c.mama,
      '/api/storage/files/upload?space=personal&path=B&name=f.txt&size=1',
      Buffer.from('2'),
    );
    const move = (p: string, to: string, cookie = c.mama) =>
      json(c.t, cookie, '/api/storage/files/move', { space: 'personal', path: p, to });
    const ok = await move('A/f.txt', 'B');
    expect(ok.json()).toEqual({ name: 'f (2).txt', folder: 'B' });
    expect(await names(c.t, c.mama, 'files', 'personal', 'B')).toEqual(['f (2).txt', 'f.txt']);
    expect((await move('A', 'A/inner')).statusCode).toBe(400);
    expect((await move('A', 'A')).statusCode).toBe(400);
    expect((await move('B/f.txt', 'B/f.txt')).statusCode).toBe(400);
    expect((await move('', 'B')).statusCode).toBe(400);
    expect((await move('B/f.txt', '../x')).statusCode).toBe(400);
    expect((await move('B/f.txt', '.uploads')).statusCode).toBe(400);
    expect((await move('nothing', 'B')).statusCode).toBe(404);
    // Another person cannot move into or out of this one's folders.
    expect((await move('B/f.txt', 'A', c.son)).statusCode).toBe(404);
    // To the top of the space.
    expect((await move('B/f.txt', '')).json()).toEqual({ name: 'f.txt', folder: '' });
  });

  it('lists albums (folders under «Альбомы») with their sizes, and hides hidden parts', async () => {
    const c = await setup();
    await json(c.t, c.mama, '/api/storage/photos/mkdir', { space: 'personal', path: '', name: 'Альбомы' });
    await json(c.t, c.mama, '/api/storage/photos/mkdir', {
      space: 'personal',
      path: 'Альбомы',
      name: 'Дача',
    });
    await json(c.t, c.mama, '/api/storage/photos/mkdir', {
      space: 'personal',
      path: 'Альбомы',
      name: 'Море',
    });
    const data = photo();
    for (const n of [1, 2]) {
      const res = await put(
        c.t,
        c.mama,
        `/api/storage/photos/upload?space=personal&path=${encodeURIComponent('Альбомы/Дача')}&name=${n}.jpg&size=${data.length}`,
        data,
      );
      expect(res.statusCode, res.body).toBe(200);
    }
    const albums = (
      await c.t.app.inject({ url: '/api/storage/photos/albums?space=personal', headers: { cookie: c.mama } })
    ).json() as AlbumsResponse;
    expect(albums.albums).toEqual([
      { name: 'Дача', count: 2, cover: null },
      { name: 'Море', count: 0, cover: null },
    ]);
    // Another person has no albums of this one.
    expect(
      (
        (
          await c.t.app.inject({
            url: '/api/storage/photos/albums?space=personal',
            headers: { cookie: c.son },
          })
        ).json() as AlbumsResponse
      ).albums,
    ).toEqual([]);
    expect(
      (await c.t.app.inject({ url: '/api/storage/photos/albums?space=nowhere', headers: { cookie: c.mama } }))
        .statusCode,
    ).toBe(400);
  });

  it('does not show «name.aria2» next to «name» (the torrent client keeps it while it works), but shows a lone one', async () => {
    const c = await setup();
    const dir = path.join(c.filesDir, 'users', 'mama', 'Загрузки');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'debian.iso'), 'x');
    await writeFile(path.join(dir, 'debian.iso.aria2'), 'control');
    await writeFile(path.join(dir, 'alone.txt.aria2'), 'control');
    expect(await names(c.t, c.mama, 'files', 'personal', 'Загрузки')).toEqual([
      'alone.txt.aria2',
      'debian.iso',
    ]);
  });
});

describe('where a path may lead', { timeout: 60_000 }, () => {
  it('refuses «..», drive letters, streams, device names and hidden parts in a path', async () => {
    const c = await setup();
    await put(
      c.t,
      c.mama,
      '/api/storage/files/upload?space=personal&path=&name=a.txt&size=1',
      Buffer.from('1'),
    );
    const bad = [
      '..',
      '../x',
      '..\\x',
      'a/../../x',
      'C:\\Windows',
      'C:/Windows/win.ini',
      'a.txt:stream',
      'CON',
      'nul.txt',
      'a/CON/b',
      '.uploads',
      '.trash',
      'a.txt.',
      'a.txt ',
      'x'.repeat(500),
    ];
    for (const p of bad) {
      for (const url of [
        `/api/storage/files/list?space=personal&path=${encodeURIComponent(p)}`,
        `/api/storage/files/file?space=personal&path=${encodeURIComponent(p)}`,
      ]) {
        const res = await c.t.app.inject({ url, headers: { cookie: c.mama } });
        expect([400, 403, 404], `${p} → ${res.statusCode}`).toContain(res.statusCode);
      }
    }
  });

  it('turns odd names into safe ones when files are made: device names, trailing dots and spaces, invisible marks, very long names', async () => {
    const c = await setup();
    const make = (name: string) =>
      json(c.t, c.mama, '/api/storage/files/mkdir', { space: 'personal', path: '', name });
    expect((await make('CON')).json()).toEqual({ name: '_CON' });
    expect((await make('aux.txt')).json()).toEqual({ name: '_aux.txt' });
    expect((await make('Нужное. . ')).json()).toEqual({ name: 'Нужное' });
    // Zero-width and text-direction marks are removed: a name cannot pretend to be another one.
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    expect(sanitizeName(`счёт${rlo}fdp.txt`)).toBe('счётfdp.txt');
    expect(sanitizeName(`до${zwsp}говор`)).toBe('договор');
    expect(sanitizeName('a:b*c?d')).toBe('a_b_c_d');
    expect(sanitizeName('...')).toBeNull();
    const long = `${'д'.repeat(400)}.txt`;
    const safe = sanitizeName(long) ?? '';
    expect(Array.from(safe).length).toBeLessThanOrEqual(150);
    expect(safe.endsWith('.txt')).toBe(true);
    // A program name hidden behind marks is still a program.
    const hidden = await put(
      c.t,
      c.mama,
      `/api/storage/files/upload?space=personal&path=&name=${encodeURIComponent(`invoice${rlo}txt.cmd`)}&size=1`,
      Buffer.from('1'),
    );
    expect(hidden.statusCode).toBe(422);
    const named = await put(
      c.t,
      c.mama,
      `/api/storage/files/upload?space=personal&path=&name=${encodeURIComponent(`NUL.txt`)}&size=1`,
      Buffer.from('1'),
    );
    expect((named.json() as UploadResponse).name).toBe('_NUL.txt');
  });

  it('does not follow a junction or a link out of the space: neither to read, nor to write', async () => {
    const c = await setup();
    const outside = await makeTempDir('fd-outside-');
    cleanup.push(() => removeDir(outside));
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    const home = path.join(c.filesDir, 'users', 'mama');
    await mkdir(home, { recursive: true });
    let linked = true;
    try {
      await symlink(outside, path.join(home, 'link'), 'junction');
    } catch {
      linked = false; // links are not allowed for this account: nothing to prove
    }
    if (!linked) return;
    for (const url of [
      '/api/storage/files/list?space=personal&path=link',
      '/api/storage/files/file?space=personal&path=link/secret.txt',
    ]) {
      const res = await c.t.app.inject({ url, headers: { cookie: c.mama } });
      expect([403, 404], url).toContain(res.statusCode);
      expect(res.body).not.toContain('secret');
    }
    const written = await put(
      c.t,
      c.mama,
      '/api/storage/files/upload?space=personal&path=link&name=x.txt&size=1',
      Buffer.from('1'),
    );
    expect([403, 404]).toContain(written.statusCode);
    expect((await readdir(outside)).sort()).toEqual(['secret.txt']);
    // The link itself is not even listed.
    expect(await names(c.t, c.mama, 'files', 'personal')).not.toContain('link');
    expect((await stat(path.join(outside, 'secret.txt'))).size).toBe(6);
  });
});
