import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaListResponse } from '../../shared/api.ts';
import {
  addUser,
  cookieFor,
  createTestApp,
  FAMILY,
  makeTempDir,
  removeDir,
  type TestApp,
} from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const MOVIE = Buffer.from('0123456789'.repeat(100)); // 1000 bytes stand in for a film

async function library(withFiles = true) {
  const mediaDir = await makeTempDir('fd-media-');
  const t = await createTestApp({ env: { MEDIA_DIR: mediaDir } });
  await addUser(t.dataDir, t.clock, FAMILY);
  cleanup.push(async () => {
    await t.app.close();
    await removeDir(t.dataDir);
    await removeDir(mediaDir);
  });
  if (withFiles) {
    await mkdir(path.join(mediaDir, 'Фильмы', 'Тестовое видео (2026)'), { recursive: true });
    await writeFile(
      path.join(mediaDir, 'Фильмы', 'Тестовое видео (2026)', 'Тестовое видео (2026).mp4'),
      MOVIE,
    );
    await writeFile(path.join(mediaDir, 'Фильмы', 'Тестовое видео (2026)', 'poster.jpg'), 'jpeg');
    await writeFile(path.join(mediaDir, 'Фильмы', 'Тестовое видео (2026)', 'movie.nfo'), '<xml/>');
    await writeFile(path.join(mediaDir, 'Фильмы', 'setup.exe'), 'MZ');
    await mkdir(path.join(mediaDir, 'Аудиокниги'), { recursive: true });
    await writeFile(path.join(mediaDir, 'Аудиокниги', 'Глава 02.mp3'), 'mp3');
    await writeFile(path.join(mediaDir, 'Аудиокниги', 'Глава 10.mp3'), 'mp3');
    await writeFile(path.join(mediaDir, 'Аудиокниги', '.hidden.mp3'), 'mp3');
  }
  return { t, mediaDir, cookie: await cookieFor(t.app, FAMILY) };
}

const list = (t: TestApp, cookie: string, p = '') =>
  t.app.inject({ url: `/api/media/list?path=${encodeURIComponent(p)}`, headers: { cookie } });
const file = (t: TestApp, cookie: string, p: string, headers: Record<string, string> = {}) =>
  t.app.inject({ url: `/api/media/file?path=${encodeURIComponent(p)}`, headers: { cookie, ...headers } });

describe('media library fallback', () => {
  it('needs a signed-in user', async () => {
    const { t } = await library();
    expect((await t.app.inject({ url: '/api/media/list' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/media/file?path=x.mp4' })).statusCode).toBe(401);
  });

  it('lists folders first and only files a browser can play, in natural order', async () => {
    const { t, cookie } = await library();
    const top = (await list(t, cookie)).json() as MediaListResponse;
    expect(top.available).toBe(true);
    expect(top.entries.map((e) => [e.name, e.type])).toEqual([
      ['Аудиокниги', 'dir'],
      ['Фильмы', 'dir'],
    ]);
    const books = (await list(t, cookie, 'Аудиокниги')).json() as MediaListResponse;
    expect(books.entries.map((e) => [e.name, e.kind])).toEqual([
      ['Глава 02.mp3', 'audio'],
      ['Глава 10.mp3', 'audio'],
    ]);
    const films = (await list(t, cookie, 'Фильмы/Тестовое видео (2026)')).json() as MediaListResponse;
    expect(films.entries.map((e) => e.name)).toEqual(['Тестовое видео (2026).mp4']);
    expect(films.entries[0]).toMatchObject({ kind: 'video', sizeBytes: MOVIE.length });
    const mixed = (await list(t, cookie, 'Фильмы')).json() as MediaListResponse;
    expect(mixed.entries.map((e) => e.name)).not.toContain('setup.exe');
  });

  it('plays a file, supports seeking with Range and answers 416 outside the file', async () => {
    const { t, cookie } = await library();
    const name = 'Фильмы/Тестовое видео (2026)/Тестовое видео (2026).mp4';
    const whole = await file(t, cookie, name);
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-security-policy']).toContain('sandbox');
    expect(whole.rawPayload.equals(MOVIE)).toBe(true);

    const part = await file(t, cookie, name, { range: 'bytes=10-19' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 10-19/1000');
    expect(part.body).toBe('0123456789');
    const tail = await file(t, cookie, name, { range: 'bytes=-5' });
    expect(tail.statusCode).toBe(206);
    expect(tail.body).toBe('56789');
    expect((await file(t, cookie, name, { range: 'bytes=5000-6000' })).statusCode).toBe(416);
  });

  it('never serves non-media files, hidden files, folders or paths outside the library', async () => {
    const { t, cookie, mediaDir } = await library();
    expect((await file(t, cookie, 'Фильмы/setup.exe')).statusCode).toBe(415);
    expect((await file(t, cookie, 'Фильмы/Тестовое видео (2026)/movie.nfo')).statusCode).toBe(415);
    expect((await file(t, cookie, 'Фильмы')).statusCode).toBe(400);
    expect((await file(t, cookie, '../secret.mp4')).statusCode).toBe(400);
    expect((await file(t, cookie, 'Фильмы/../../x.mp4')).statusCode).toBe(400);
    expect((await file(t, cookie, 'C:/Windows/notepad.exe')).statusCode).toBe(400);
    expect((await file(t, cookie, 'Фильмы/movie.mp4:stream')).statusCode).toBe(400);
    expect((await file(t, cookie, 'Нет такого.mp4')).statusCode).toBe(404);
    expect((await list(t, cookie, '..')).statusCode).toBe(400);

    // A junction that leads outside the library is refused, in the list and for files.
    const outside = await makeTempDir('fd-outside-');
    cleanup.push(() => removeDir(outside));
    await writeFile(path.join(outside, 'secret.mp4'), 'secret');
    await symlink(outside, path.join(mediaDir, 'link'), 'junction');
    const top = (await list(t, cookie)).json() as MediaListResponse;
    expect(top.entries.map((e) => e.name)).not.toContain('link');
    expect((await list(t, cookie, 'link')).statusCode).toBe(403);
    expect((await file(t, cookie, 'link/secret.mp4')).statusCode).toBe(403);
  });

  it('says honestly that the library folder is missing', async () => {
    const { t, cookie, mediaDir } = await library(false);
    await removeDir(mediaDir);
    const body = (await list(t, cookie)).json() as MediaListResponse;
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/не найдена/);
    expect(body.entries).toEqual([]);
    expect((await file(t, cookie, 'x.mp4')).statusCode).toBe(404);
  });
});
