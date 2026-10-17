import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileListResponse, UploadResponse } from '../../shared/api.ts';
import { sniffMedia } from '../src/files/storage.ts';
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
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function app(env: Record<string, string> = {}, free = 500 * 1024 ** 3) {
  const filesDir = await makeTempDir('fd-files-');
  const photosDir = await makeTempDir('fd-photos-');
  const t = await createTestApp({
    env: { FAMILY_FILES_DIR: filesDir, FAMILY_PHOTOS_DIR: photosDir, MIN_FREE_GB: '1', ...env },
    freeBytes: async () => free,
  });
  for (const u of [ADMIN, FAMILY, SON]) await addUser(t.dataDir, t.clock, u);
  cleanup.push(async () => {
    await t.app.close();
    for (const d of [t.dataDir, filesDir, photosDir]) await removeDir(d);
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

function upload(
  t: TestApp,
  cookie: string,
  q: { root?: string; space: string; path?: string; name: string; size?: number },
  body: Buffer,
  headers: Record<string, string> = {},
) {
  const query = new URLSearchParams({
    space: q.space,
    path: q.path ?? '',
    name: q.name,
    size: String(q.size ?? body.length),
  });
  return t.app.inject({
    method: 'PUT',
    url: `/api/storage/${q.root ?? 'files'}/upload?${query}`,
    headers: { cookie, 'content-type': 'application/octet-stream', 'x-upload': '1', ...headers },
    payload: body,
  });
}

async function list(t: TestApp, cookie: string, root: string, space: string, p = '') {
  const res = await t.app.inject({
    url: `/api/storage/${root}/list?space=${space}&path=${encodeURIComponent(p)}`,
    headers: { cookie },
  });
  return res;
}

describe('family storage', { timeout: 60_000 }, () => {
  it('keeps personal files private, even from the admin; shared files are for everyone', async () => {
    const { t, mama, son, admin, filesDir } = await app();
    expect(
      (await upload(t, mama, { space: 'personal', name: 'паспорт.pdf' }, Buffer.from('%PDF-1.7'))).statusCode,
    ).toBe(200);
    expect(
      (await upload(t, mama, { space: 'shared', name: 'рецепт.txt' }, Buffer.from('борщ'))).statusCode,
    ).toBe(200);
    const mine = (await list(t, mama, 'files', 'personal')).json() as FileListResponse;
    expect(mine.entries.map((e) => e.name)).toEqual(['паспорт.pdf']);
    for (const other of [son, admin]) {
      const theirs = (await list(t, other, 'files', 'personal')).json() as FileListResponse;
      expect(theirs.entries).toEqual([]);
      const shared = (await list(t, other, 'files', 'shared')).json() as FileListResponse;
      expect(shared.entries.map((e) => e.name)).toEqual(['рецепт.txt']);
    }
    expect(await readFile(path.join(filesDir, 'users', 'mama', 'паспорт.pdf'), 'utf8')).toBe('%PDF-1.7');
    // No parameter can name another user's personal folder.
    for (const p of ['../mama', '..\\mama', '../../users/mama', 'C:\\Windows', 'a:b', '%2e%2e']) {
      const res = await list(t, son, 'files', 'personal', p);
      expect([400, 404], p).toContain(res.statusCode);
    }
    const sneaky = await t.app.inject({
      url: '/api/storage/files/list?space=other&path=',
      headers: { cookie: son },
    });
    expect(sneaky.statusCode).toBe(400);
  });

  it('never follows a link out of the space', async () => {
    const { t, mama, filesDir } = await app();
    const outside = await makeTempDir('fd-outside-');
    cleanup.push(() => removeDir(outside));
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await mkdir(path.join(filesDir, 'shared'), { recursive: true });
    await symlink(outside, path.join(filesDir, 'shared', 'link'), 'junction');
    const top = (await list(t, mama, 'files', 'shared')).json() as FileListResponse;
    expect(top.entries.map((e) => e.name)).not.toContain('link');
    const through = await list(t, mama, 'files', 'shared', 'link');
    expect(through.statusCode).toBe(403);
    const file = await t.app.inject({
      url: '/api/storage/files/file?space=shared&path=link/secret.txt',
      headers: { cookie: mama },
    });
    expect(file.statusCode).toBe(403);
  });

  it('accepts uploads only as a raw PUT with X-Upload from the portal itself', async () => {
    const { t, mama } = await app();
    const body = Buffer.from('hello');
    expect(
      (await upload(t, mama, { space: 'personal', name: 'a.txt' }, body, { 'x-upload': '0' })).statusCode,
    ).toBe(415);
    expect(
      (await upload(t, mama, { space: 'personal', name: 'a.txt' }, body, { 'content-type': 'text/plain' }))
        .statusCode,
    ).toBe(415);
    const foreign = await upload(t, mama, { space: 'personal', name: 'a.txt' }, body, {
      origin: 'https://evil.example',
    });
    expect(foreign.statusCode).toBe(403);
    const anonymous = await t.app.inject({
      method: 'PUT',
      url: '/api/storage/files/upload?space=personal&path=&name=a.txt&size=5',
      headers: { 'content-type': 'application/octet-stream', 'x-upload': '1' },
      payload: body,
    });
    expect(anonymous.statusCode).toBe(401);
    // The raw body is not accepted on JSON routes.
    const raw = await t.app.inject({
      method: 'POST',
      url: '/api/storage/files/mkdir',
      headers: { cookie: mama, 'content-type': 'application/octet-stream', 'x-upload': '1' },
      payload: body,
    });
    expect(raw.statusCode).toBe(415);
  });

  it('refuses programs (by name or content), wrong sizes, files over the limit and a full disk', async () => {
    const { t, mama } = await app({ UPLOAD_MAX_FILE_GB: '0.001' });
    expect(
      (await upload(t, mama, { space: 'personal', name: 'setup.exe' }, Buffer.from('x'))).json().error,
    ).toBe('blocked_type');
    expect(
      (await upload(t, mama, { space: 'personal', name: 'doc.pdf' }, Buffer.from('MZ\x90\x00'))).json().error,
    ).toBe('blocked_type');
    expect(
      (await upload(t, mama, { space: 'personal', name: 'big.bin' }, Buffer.alloc(2 * 1024 * 1024)))
        .statusCode,
    ).toBe(413);
    const mismatch = await upload(
      t,
      mama,
      { space: 'personal', name: 'a.txt', size: 3 },
      Buffer.from('hello'),
    );
    expect(mismatch.statusCode).toBe(411);
    const left = await readdir(path.join(t.config.filesDir, 'users', 'mama'));
    expect(left).toEqual([]);
    const full = await app({}, 0.5 * 1024 ** 3);
    expect(
      (await upload(full.t, full.mama, { space: 'personal', name: 'a.txt' }, Buffer.from('hi'))).statusCode,
    ).toBe(507);
  });

  it('photos: only real images and videos, with browser-made thumbnails', async () => {
    const { t, mama, photosDir } = await app();
    const notPhoto = await upload(
      t,
      mama,
      { root: 'photos', space: 'personal', name: 'note.jpg' },
      Buffer.from('just text'),
    );
    expect(notPhoto.statusCode).toBe(415);
    const ok = await upload(
      t,
      mama,
      { root: 'photos', space: 'personal', path: '', name: 'IMG_0001.jpg' },
      JPEG,
    );
    expect((ok.json() as UploadResponse).media).toBe('image');
    const thumb = await t.app.inject({
      method: 'PUT',
      url: '/api/storage/photos/thumb?space=personal&path=&name=IMG_0001.jpg',
      headers: { cookie: mama, 'content-type': 'application/octet-stream', 'x-upload': '1' },
      payload: JPEG,
    });
    expect(thumb.statusCode).toBe(204);
    const listing = (await list(t, mama, 'photos', 'personal')).json() as FileListResponse;
    expect(listing.entries[0]).toMatchObject({ name: 'IMG_0001.jpg', hasThumb: true, mime: 'image/jpeg' });
    const got = await t.app.inject({
      url: '/api/storage/photos/thumb?space=personal&path=IMG_0001.jpg',
      headers: { cookie: mama },
    });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect((await readdir(path.join(photosDir, '.thumbs', 'users', 'mama'))).length).toBe(1);
    expect(sniffMedia(Buffer.from('00000018ftypqt  ', 'latin1'))).toBeNull(); // too short header string
  });

  it('serves files as downloads; only safe types inline, sandboxed; supports Range for video seeking', async () => {
    const { t, mama } = await app();
    await upload(t, mama, { space: 'personal', name: 'clip.mp4' }, Buffer.from('0123456789'));
    await upload(t, mama, { space: 'personal', name: 'page.html' }, Buffer.from('<script>alert(1)</script>'));
    const plain = await t.app.inject({
      url: '/api/storage/files/file?space=personal&path=clip.mp4',
      headers: { cookie: mama },
    });
    expect(plain.headers['content-disposition']).toMatch(/^attachment/);
    expect(plain.headers['content-type']).toBe('application/octet-stream');
    const inline = await t.app.inject({
      url: '/api/storage/files/file?space=personal&path=clip.mp4&inline=1',
      headers: { cookie: mama, range: 'bytes=2-5' },
    });
    expect(inline.statusCode).toBe(206);
    expect(inline.body).toBe('2345');
    expect(inline.headers['content-range']).toBe('bytes 2-5/10');
    expect(inline.headers['content-type']).toBe('video/mp4');
    expect(inline.headers['content-security-policy']).toMatch(/^sandbox/);
    const html = await t.app.inject({
      url: '/api/storage/files/file?space=personal&path=page.html&inline=1',
      headers: { cookie: mama },
    });
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(html.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('creates folders, renames, moves to the trash (never deletes) and logs only shared names', async () => {
    const { t, mama, filesDir, admin } = await app();
    const post = (url: string, payload: object) =>
      t.app.inject({ method: 'POST', url, headers: { cookie: mama }, payload });
    expect(
      (await post('/api/storage/files/mkdir', { space: 'shared', path: '', name: 'Документы' })).statusCode,
    ).toBe(200);
    expect(
      (await post('/api/storage/files/mkdir', { space: 'shared', path: '', name: 'Документы' })).statusCode,
    ).toBe(409);
    await upload(t, mama, { space: 'shared', path: 'Документы', name: 'счёт.pdf' }, Buffer.from('%PDF'));
    expect(
      (
        await post('/api/storage/files/rename', {
          space: 'shared',
          path: 'Документы/счёт.pdf',
          name: 'счёт.exe',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await post('/api/storage/files/rename', {
          space: 'shared',
          path: 'Документы/счёт.pdf',
          name: 'счёт-2026.pdf',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await post('/api/storage/files/trash', { space: 'shared', path: 'Документы/счёт-2026.pdf' }))
        .statusCode,
    ).toBe(204);
    expect((await post('/api/storage/files/trash', { space: 'shared', path: '' })).statusCode).toBe(400);
    const folder = (await list(t, mama, 'files', 'shared', 'Документы')).json() as FileListResponse;
    expect(folder.entries).toEqual([]);
    const binned = await readdir(path.join(filesDir, '.trash', 'shared'));
    expect(binned[0]).toMatch(/счёт-2026\.pdf$/);
    await upload(t, mama, { space: 'personal', name: 'личное.txt' }, Buffer.from('x'));
    const audit = await t.app.inject({ url: '/api/admin/audit?limit=50', headers: { cookie: admin } });
    const details = (audit.json().entries as Array<{ action: string; detail: string | null }>)
      .filter((e) => e.action.startsWith('file.'))
      .map((e) => e.detail ?? '');
    expect(details.some((d) => d.includes('счёт.pdf'))).toBe(true);
    expect(details.some((d) => d.includes('личное.txt'))).toBe(false);
  });
});
