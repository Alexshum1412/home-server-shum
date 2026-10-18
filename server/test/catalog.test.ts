import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogDetailResponse, CatalogHomeResponse, CatalogItemsResponse } from '../../shared/api.ts';
import { FAKE_KEY, ITEMS, startFakeJellyfin } from '../../tests/e2e/fake-jellyfin.mjs';
import { judgePlayback } from '../src/jellyfin/client.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, removeDir, type TestApp } from './helpers.ts';

const VIDEO = path.join(import.meta.dirname, '..', '..', 'tests', 'e2e', 'fixture-video.mp4');
const movie = (n: number) =>
  ITEMS.find((item) => item.Id.endsWith(n.toString(16).padStart(2, '0')))?.Id ?? '';
const ID = {
  holidays: movie(1),
  mkv: movie(2),
  hevc: movie(3),
  noCover: movie(4),
  series: '0'.repeat(30) + '0a',
  season: '0'.repeat(30) + '0b',
  episode: '0'.repeat(30) + '0c',
  book: '0'.repeat(30) + '14',
  chapter: '0'.repeat(30) + '15',
  booksLibrary: '0'.repeat(30) + 'a3',
};

let fake: Awaited<ReturnType<typeof startFakeJellyfin>>;
let port: number;
let t: TestApp;
let mama: string;
let papa: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port: found } = server.address() as net.AddressInfo;
      server.close(() => resolve(found));
    });
  });
}

async function boot(options: { key?: string | null; url?: string } = {}) {
  t = await createTestApp({ env: { JELLYFIN_URL: options.url ?? `http://127.0.0.1:${port}` } });
  if (options.key !== null) {
    await writeFile(
      path.join(t.dataDir, 'jellyfin-api.json'),
      JSON.stringify({ apiKey: options.key ?? FAKE_KEY }),
    );
  }
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
  mama = await cookieFor(t.app, FAMILY);
  papa = await cookieFor(t.app, ADMIN);
}

beforeEach(async () => {
  port = await freePort();
  fake = await startFakeJellyfin({ port, videoFile: VIDEO });
});

afterEach(async () => {
  await t.app.close();
  await removeDir(t.dataDir);
  await fake.close();
});

const get = <T = unknown>(cookie: string, url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ url, headers: { cookie, ...headers } }).then((res) => ({
    res,
    status: res.statusCode,
    body: (res.headers['content-type'] ?? '').toString().includes('json') ? (res.json() as T) : (null as T),
  }));

describe('cinema catalogue', () => {
  it('shows libraries, the newest titles and genres; chapters and library folders are not cards', async () => {
    await boot();
    const { body } = await get<CatalogHomeResponse>(mama, '/api/catalog');
    expect(body.available).toBe(true);
    expect(body.libraries.map((l) => [l.name, l.kind])).toEqual([
      ['Фильмы', 'movies'],
      ['Сериалы', 'tvshows'],
      ['Аудиокниги', 'books'],
      ['Музыка', 'music'],
    ]);
    const titles = body.latest.map((item) => item.title).sort();
    expect(titles).toEqual(
      [
        'Весёлые каникулы',
        'Звёздный курьер',
        'Приключения кота Мурзика',
        'Семейные песни',
        'Тайна старого маяка',
        'Фильм без обложки',
      ].sort(),
    );
    expect(body.latest.find((item) => item.title === 'Весёлые каникулы')).toMatchObject({
      kind: 'movie',
      year: 2019,
      genres: ['Комедия', 'Семейный'],
      runtimeMin: 96,
      rating: 7.8,
      hasPoster: true,
    });
    expect(body.latest.find((item) => item.title === 'Фильм без обложки')?.hasPoster).toBe(false);
    expect(body.genres).toEqual([
      'Детская',
      'Драма',
      'Комедия',
      'Мультфильм',
      'Приключения',
      'Семейный',
      'Фантастика',
    ]);
  });

  it('needs a signed-in person everywhere', async () => {
    await boot();
    for (const url of [
      '/api/catalog',
      '/api/catalog/items',
      `/api/catalog/items/${ID.holidays}`,
      `/api/catalog/image/${ID.holidays}`,
      `/api/catalog/stream/${ID.holidays}`,
    ]) {
      expect((await t.app.inject({ url })).statusCode, url).toBe(401);
    }
    const post = await t.app.inject({
      method: 'POST',
      url: '/api/catalog/progress',
      payload: { id: ID.holidays, positionSec: 100, durationSec: 1000 },
    });
    expect(post.statusCode).toBe(401);
    expect(fake.requests).toEqual([]);
  });

  it('filters by library, search text and genre, sorts, and pages', async () => {
    await boot();
    const films = await get<CatalogItemsResponse>(mama, `/api/catalog/items?library=${'0'.repeat(30)}a1`);
    expect(films.body.items.map((i) => i.title)).toEqual([
      'Весёлые каникулы',
      'Звёздный курьер',
      'Тайна старого маяка',
      'Фильм без обложки',
    ]);
    expect(films.body.total).toBe(4);
    const search = await get<CatalogItemsResponse>(
      mama,
      `/api/catalog/items?q=${encodeURIComponent('курьер')}`,
    );
    expect(search.body.items.map((i) => i.title)).toEqual(['Звёздный курьер']);
    const genre = await get<CatalogItemsResponse>(
      mama,
      `/api/catalog/items?genre=${encodeURIComponent('Приключения')}`,
    );
    expect(genre.body.items.map((i) => i.title)).toEqual(['Звёздный курьер', 'Тайна старого маяка']);
    const page = await get<CatalogItemsResponse>(
      mama,
      `/api/catalog/items?library=${'0'.repeat(30)}a1&limit=2&start=2`,
    );
    expect(page.body).toMatchObject({ total: 4, start: 2 });
    expect(page.body.items).toHaveLength(2);
    expect((await get(mama, '/api/catalog/items?limit=1000')).status).toBe(400);
    expect((await get(mama, '/api/catalog/items?library=not-an-id')).status).toBe(400);
  });

  it('lists a book (a folder of chapters) as one card in the audiobooks library', async () => {
    await boot();
    const list = await get<CatalogItemsResponse>(mama, `/api/catalog/items?library=${ID.booksLibrary}`);
    expect(list.body.items.map((i) => [i.kind, i.title])).toEqual([['book', 'Сказки на ночь']]);
    const detail = await get<CatalogDetailResponse>(mama, `/api/catalog/items/${ID.book}`);
    expect(detail.body.children.map((c) => [c.kind, c.title, c.episode])).toEqual([
      ['audiobook', 'Глава 1. Лесной гость', 1],
      ['audiobook', 'Глава 2. Река', 2],
    ]);
    const chapter = await get<CatalogDetailResponse>(mama, `/api/catalog/items/${ID.chapter}`);
    expect(chapter.body).toMatchObject({ media: 'audio', playback: 'direct' });
  });

  it('tells how each film can be played: directly, maybe, or only through Jellyfin', async () => {
    await boot();
    const direct = await get<CatalogDetailResponse>(mama, `/api/catalog/items/${ID.holidays}`);
    expect(direct.body).toMatchObject({
      playback: 'direct',
      media: 'video',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      playbackNote: null,
    });
    expect(direct.body.overview).toContain('Семья едет на море');
    const maybe = await get<CatalogDetailResponse>(mama, `/api/catalog/items/${ID.mkv}`);
    expect(maybe.body.playback).toBe('maybe');
    expect(maybe.body.playbackNote).toContain('MKV');
    const hard = await get<CatalogDetailResponse>(mama, `/api/catalog/items/${ID.hevc}`);
    expect(hard.body.playback).toBe('jellyfin');
    expect(hard.body.playbackNote).toMatch(/hevc/);
    expect(hard.body.playbackNote).toMatch(/dts/);
  });

  it('follows a series down to its seasons and episodes', async () => {
    await boot();
    const series = await get<CatalogDetailResponse>(mama, `/api/catalog/items/${ID.series}`);
    expect(series.body.children.map((c) => [c.kind, c.title])).toEqual([['season', 'Сезон 1']]);
    expect(series.body.media).toBeNull();
    const season = await get<CatalogDetailResponse>(mama, `/api/catalog/items/${ID.season}`);
    expect(season.body.children.map((c) => [c.season, c.episode, c.title, c.seriesTitle])).toEqual([
      [1, 1, 'Первый день во дворе', 'Приключения кота Мурзика'],
      [1, 2, 'Дождливый вторник', 'Приключения кота Мурзика'],
    ]);
  });

  it('refuses ids that are not ids, and answers «not found» for an unknown one', async () => {
    await boot();
    for (const id of ['..%2F..%2FSystem%2FInfo', 'x', '0'.repeat(31), '%00']) {
      const res = await t.app.inject({ url: `/api/catalog/items/${id}`, headers: { cookie: mama } });
      expect([400, 404], id).toContain(res.statusCode);
    }
    expect((await get(mama, `/api/catalog/items/${'f'.repeat(32)}`)).status).toBe(404);
    // nothing but the expected paths ever reached Jellyfin
    expect(fake.requests.every((line) => /^GET \/(Items|Library|Genres|System)/.test(line))).toBe(true);
  });
});

describe('posters and the file itself', () => {
  it('passes a poster on as an image, with a cache hint, and never shows the key', async () => {
    await boot();
    const { res, status } = await get(mama, `/api/catalog/image/${ID.holidays}?w=240`);
    expect(status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(Buffer.from(res.rawPayload).subarray(1, 4).toString()).toBe('PNG');
    expect(JSON.stringify(res.headers)).not.toContain(FAKE_KEY);
    expect(fake.requests.some((line) => line.includes('/Images/Primary?maxWidth=240'))).toBe(true);
    expect((await get(mama, `/api/catalog/image/${ID.noCover}`)).status).toBe(404);
    expect((await get(mama, '/api/catalog/image/not-an-id')).status).toBe(404);
  });

  it('streams the file with Range, so a browser can seek; the key stays on the server', async () => {
    await boot();
    const whole = await get(mama, `/api/catalog/stream/${ID.holidays}`);
    expect(whole.status).toBe(200);
    expect(whole.res.headers['content-type']).toBe('video/mp4');
    expect(whole.res.headers['accept-ranges']).toBe('bytes');
    expect(String(whole.res.headers['content-security-policy'])).toContain('sandbox');
    const total = Number(whole.res.headers['content-length']);
    expect(total).toBeGreaterThan(1000);
    expect(Buffer.from(whole.res.rawPayload).subarray(4, 8).toString()).toBe('ftyp');

    const part = await get(mama, `/api/catalog/stream/${ID.holidays}`, { range: 'bytes=0-99' });
    expect(part.status).toBe(206);
    expect(part.res.headers['content-range']).toBe(`bytes 0-99/${total}`);
    expect(Buffer.from(part.res.rawPayload)).toHaveLength(100);
    const audio = await get(mama, `/api/catalog/stream/${ID.chapter}?as=audio`);
    expect(audio.res.headers['content-type']).toBe('audio/wav');
    for (const result of [whole, part, audio])
      expect(JSON.stringify(result.res.headers)).not.toContain(FAKE_KEY);
  });

  it('does not pass on a file that is not audio or video as anything but a download', async () => {
    await boot();
    // An unknown id never reaches Jellyfin's file endpoints.
    expect((await get(mama, '/api/catalog/stream/not-an-id')).status).toBe(404);
    expect((await get(mama, `/api/catalog/stream/${'e'.repeat(32)}`)).status).toBe(404);
  });
});

describe('where each person stopped', () => {
  const save = (cookie: string, id: string, positionSec: number, durationSec: number) =>
    t.app.inject({
      method: 'POST',
      url: '/api/catalog/progress',
      headers: { cookie },
      payload: { id, positionSec, durationSec },
    });

  it('remembers the place for one person only and shows it as «continue»', async () => {
    await boot();
    expect((await save(mama, ID.holidays, 1800, 5760)).statusCode).toBe(204);
    const home = await get<CatalogHomeResponse>(mama, '/api/catalog');
    expect(home.body.continueWatching.map((i) => [i.title, i.resumeSec])).toEqual([
      ['Весёлые каникулы', 1800],
    ]);
    const other = await get<CatalogHomeResponse>(papa, '/api/catalog');
    expect(other.body.continueWatching).toEqual([]);
    expect(other.body.latest.find((i) => i.title === 'Весёлые каникулы')?.resumeSec).toBeNull();
    const detail = await get<CatalogDetailResponse>(mama, `/api/catalog/items/${ID.holidays}`);
    expect(detail.body.item.resumeSec).toBe(1800);
  });

  it('forgets a finished film and ignores the first seconds; the newest is first', async () => {
    await boot();
    await save(mama, ID.holidays, 600, 5760);
    t.clock.advance(5000);
    await save(mama, ID.mkv, 900, 6720);
    let home = await get<CatalogHomeResponse>(mama, '/api/catalog');
    expect(home.body.continueWatching.map((i) => i.title)).toEqual([
      'Тайна старого маяка',
      'Весёлые каникулы',
    ]);
    await save(mama, ID.holidays, 5700, 5760); // the last minute: watched
    await save(mama, ID.mkv, 4, 6720); // the player has just started: the saved place stays
    home = await get<CatalogHomeResponse>(mama, '/api/catalog');
    expect(home.body.continueWatching.map((i) => [i.title, i.resumeSec])).toEqual([
      ['Тайна старого маяка', 900],
    ]);
  });

  it('checks what it is given', async () => {
    await boot();
    expect((await save(mama, 'nope', 10, 100)).statusCode).toBe(400);
    expect((await save(mama, ID.holidays, -5, 100)).statusCode).toBe(400);
    expect((await save(mama, ID.holidays, 5, 99_999_999)).statusCode).toBe(400);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/catalog/progress',
          headers: { cookie: mama, 'content-type': 'application/json' },
          payload: '{',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('keeps the place after a restart', async () => {
    await boot();
    await save(mama, ID.holidays, 1200, 5760);
    const { dataDir } = t;
    await t.app.close();
    t = await createTestApp({ dataDir, env: { JELLYFIN_URL: `http://127.0.0.1:${port}` } });
    mama = await cookieFor(t.app, FAMILY);
    const home = await get<CatalogHomeResponse>(mama, '/api/catalog');
    expect(home.body.continueWatching.map((i) => i.resumeSec)).toEqual([1200]);
  });
});

describe('when Jellyfin is not there', () => {
  it('says so without a key, without calling anything', async () => {
    await boot({ key: null });
    const { body } = await get<CatalogHomeResponse>(mama, '/api/catalog');
    expect(body).toMatchObject({ available: false, libraries: [], latest: [] });
    expect(body.reason).toContain('jellyfin-setup.cmd');
    expect(fake.requests).toEqual([]);
    expect((await get(mama, '/api/catalog/items')).status).toBe(503);
  });

  it('says so when Jellyfin does not accept the key', async () => {
    await boot({ key: 'f'.repeat(32) });
    const { body } = await get<CatalogHomeResponse>(mama, '/api/catalog');
    expect(body.available).toBe(false);
    expect(body.reason).toContain('не принял ключ');
  });

  it('says so when nothing answers, and the portal keeps working', async () => {
    await fake.close();
    await boot();
    const { body } = await get<CatalogHomeResponse>(mama, '/api/catalog');
    expect(body.available).toBe(false);
    expect(body.reason).toContain('не отвечает');
    expect((await t.app.inject({ url: '/api/session', headers: { cookie: mama } })).statusCode).toBe(200);
    fake = await startFakeJellyfin({ port, videoFile: VIDEO });
  });

  it('refuses an address that is not on this PC', async () => {
    await expect(createTestApp({ env: { JELLYFIN_URL: 'http://192.168.1.50:8096' } })).rejects.toThrow(
      /JELLYFIN_URL/,
    );
    await expect(createTestApp({ env: { JELLYFIN_URL: 'https://example.org' } })).rejects.toThrow(
      /JELLYFIN_URL/,
    );
  });
});

describe('judgePlayback', () => {
  const base = { media: 'video' as const };
  it.each([
    ['mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac', 'direct'],
    ['webm', 'vp9', 'opus', 'direct'],
    ['matroska,webm', 'h264', 'aac', 'maybe'],
    ['matroska,webm', 'hevc', 'aac', 'jellyfin'],
    ['avi', 'mpeg4', 'mp3', 'jellyfin'],
    ['mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'ac3', 'jellyfin'],
  ])('%s + %s + %s → %s', (container, videoCodec, audioCodec, expected) => {
    expect(judgePlayback({ ...base, container, videoCodec, audioCodec }).playback).toBe(expected);
  });
  it('plays plain audio files directly', () => {
    expect(
      judgePlayback({ media: 'audio', container: 'mp3', videoCodec: null, audioCodec: 'mp3' }).playback,
    ).toBe('direct');
    expect(
      judgePlayback({ media: 'audio', container: 'wma', videoCodec: null, audioCodec: 'wmav2' }).playback,
    ).toBe('jellyfin');
  });
});
