import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CatalogHomeResponse,
  CatalogMarkState,
  CatalogShelvesResponse,
  CatalogSuggestion,
  CatalogSuggestionsResponse,
  NotificationsResponse,
} from '../../shared/api.ts';
import { FAKE_KEY, ITEMS, startFakeJellyfin } from '../../tests/e2e/fake-jellyfin.mjs';
import { readAria2Secret } from '../src/downloads/aria2.ts';
import { createJellyfinClient } from '../src/jellyfin/client.ts';
import { publicRouteAllowed } from '../src/lib/channel.ts';
import { startFakeAria2, type FakeAria2 } from './fixtures/fake-aria2.ts';
import { makeTorrent } from './fixtures/torrent-builder.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createFakeClock,
  createTestApp,
  FAMILY,
  removeDir,
  type TestApp,
  type TestAppOptions,
} from './helpers.ts';

const VIDEO = path.join(import.meta.dirname, '..', '..', 'tests', 'e2e', 'fixture-video.mp4');
const pad = (n: number) => n.toString(16).padStart(32, '0');
const ID = {
  holidays: pad(1),
  lighthouse: pad(2),
  courier: pad(3),
  noCover: pad(4),
  series: pad(0x0a),
  season: pad(0x0b),
  episode1: pad(0x0c),
  episode2: pad(0x0d),
  book: pad(0x14),
  chapter: pad(0x15),
  songs: pad(0x1e),
  movies: pad(0xa1),
  unknown: pad(0xffff),
};
const SASHA = { username: 'sasha', password: 'sasha-password-1', displayName: 'Саша', role: 'family' as const };

let fake: Awaited<ReturnType<typeof startFakeJellyfin>>;
let port: number;
let t: TestApp;
let mama: string;
let papa: string;
let sasha: string;

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

async function boot(options: { key?: string | null; env?: Record<string, string>; extra?: Partial<TestAppOptions> } = {}) {
  // The fake Jellyfin dates its titles from the real now, so the portal's clock starts at the real now too.
  t = await createTestApp({
    clock: createFakeClock(new Date().toISOString()),
    env: { JELLYFIN_URL: `http://127.0.0.1:${port}`, ...options.env },
    ...options.extra,
  });
  if (options.key !== null) {
    await writeFile(path.join(t.dataDir, 'jellyfin-api.json'), JSON.stringify({ apiKey: options.key ?? FAKE_KEY }));
  }
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
  await addUser(t.dataDir, t.clock, SASHA);
  mama = await cookieFor(t.app, FAMILY);
  papa = await cookieFor(t.app, ADMIN);
  sasha = await cookieFor(t.app, SASHA);
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

const call = async <T = unknown>(
  method: 'GET' | 'POST',
  cookie: string,
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
) => {
  const res = await t.app.inject({ method, url, headers: { cookie, ...headers }, payload });
  const isJson = (res.headers['content-type'] ?? '').toString().includes('json');
  return { res, status: res.statusCode, body: (isJson ? res.json() : null) as T };
};
const get = <T = unknown>(cookie: string, url: string) => call<T>('GET', cookie, url);
const post = <T = unknown>(cookie: string, url: string, payload: object = {}) =>
  call<T>('POST', cookie, url, payload);
const shelves = async (cookie: string) => (await get<CatalogShelvesResponse>(cookie, '/api/catalog/shelves')).body;
const mark = (cookie: string, id: string, flags: { favourite?: boolean; later?: boolean; watched?: boolean }) =>
  post<CatalogMarkState>(cookie, '/api/catalog/marks', { id, ...flags });
const progress = (cookie: string, id: string, positionSec: number, durationSec: number) =>
  post(cookie, '/api/catalog/progress', { id, positionSec, durationSec });
const titles = (rows: Array<{ item: { title: string } }>) => rows.map((row) => row.item.title);

describe('the rows of the start page', () => {
  it('a person who has marked nothing sees what is new and a hint, not invented lists', async () => {
    await boot();
    const body = await shelves(mama);
    expect(body.reason).toBeNull();
    expect(body.marks).toEqual({ favourites: [], later: [], watched: [] });
    expect(titles(body.news)).toEqual(['Звёздный курьер', 'Семейные песни']);
    expect(body.news[0]?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(body.forYou).toEqual([]);
    expect(body.forYouHint).toContain('Отметьте сердечком');
    expect([body.later, body.favourites, body.history]).toEqual([[], [], []]);
    expect(body.openSuggestions).toBe(0);
    // a card carries what the page shows, not the library's bookkeeping
    expect(Object.keys(body.news[0]?.item ?? {}).sort()).toEqual(
      [
        'durationSec',
        'episode',
        'genres',
        'hasPoster',
        'id',
        'kind',
        'rating',
        'resumeSec',
        'runtimeMin',
        'season',
        'seriesTitle',
        'title',
        'year',
      ].sort(),
    );
  });

  it('needs a signed-in person; the lists are never somebody else\'s', async () => {
    await boot();
    expect((await t.app.inject({ url: '/api/catalog/shelves' })).statusCode).toBe(401);
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/catalog/marks', payload: { id: ID.holidays, favourite: true } }))
        .statusCode,
    ).toBe(401);
    expect((await t.app.inject({ url: '/api/catalog/suggestions' })).statusCode).toBe(401);
  });

  it('favourites and «later» are kept per person and shown newest first', async () => {
    await boot();
    expect((await mark(mama, ID.holidays, { favourite: true })).body).toEqual({
      id: ID.holidays,
      favourite: true,
      later: false,
      watched: false,
    });
    t.clock.advance(1000);
    await mark(mama, ID.lighthouse, { favourite: true, later: true });
    const body = await shelves(mama);
    expect(titles(body.favourites)).toEqual(['Тайна старого маяка', 'Весёлые каникулы']);
    expect(titles(body.later)).toEqual(['Тайна старого маяка']);
    expect(body.marks.favourites).toEqual([ID.lighthouse, ID.holidays]);

    await mark(mama, ID.lighthouse, { favourite: false });
    expect(titles((await shelves(mama)).favourites)).toEqual(['Весёлые каникулы']);

    // somebody else sees none of it
    for (const cookie of [papa, sasha]) {
      const other = await shelves(cookie);
      expect(other.marks).toEqual({ favourites: [], later: [], watched: [] });
      expect([other.favourites, other.later, other.history]).toEqual([[], [], []]);
    }
  });

  it('«Для вас» follows the genres of what I like, explains each pick, and leaves out what I have', async () => {
    await boot();
    await mark(mama, ID.lighthouse, { favourite: true });
    const body = await shelves(mama);
    expect(body.forYouHint).toBeNull();
    expect(body.forYou[0]?.item.title).toBe('Звёздный курьер');
    expect(body.forYou[0]?.note).toBe('В избранном есть „Тайна старого маяка“ в жанре „Приключения“');
    expect(titles(body.forYou)).not.toContain('Тайна старого маяка');
    // what I put on my list is not offered again either
    await mark(mama, ID.courier, { later: true });
    expect(titles((await shelves(mama)).forYou)).not.toContain('Звёздный курьер');
    // and a title I watched is "seen"
    await mark(mama, ID.noCover, { watched: true });
    expect(titles((await shelves(mama)).forYou)).not.toContain('Фильм без обложки');
  });

  it('other people lift a title by number only: their names never appear', async () => {
    await boot();
    await mark(sasha, ID.holidays, { favourite: true });
    await mark(papa, ID.holidays, { watched: true });
    const body = await shelves(mama);
    const row = body.forYou.find((entry) => entry.item.title === 'Весёлые каникулы');
    expect(row?.note).toBe('Уже смотрели или отметили: 2 человека из семьи');
    const text = JSON.stringify(body);
    for (const name of ['Саша', 'sasha', 'Папа', 'papa', 'Тестовая']) expect(text).not.toContain(name);
    // the administrator sees nobody's list through the portal
    expect((await shelves(papa)).marks).toEqual({ favourites: [], later: [], watched: [ID.holidays] });
    expect((await shelves(sasha)).marks.watched).toEqual([]);
  });

  it('«Что я смотрел»: a started film is «Смотрю», a finished one is «Просмотрено», newest first', async () => {
    await boot();
    await progress(mama, ID.holidays, 600, 5760);
    t.clock.advance(60_000);
    await progress(mama, ID.lighthouse, 1200, 6720);
    let body = await shelves(mama);
    expect(body.history.map((row) => [row.item.title, row.note])).toEqual([
      ['Тайна старого маяка', 'Смотрю'],
      ['Весёлые каникулы', 'Смотрю'],
    ]);
    expect(body.history[0]?.item.resumeSec).toBe(1200);

    // 92 % is «watched» (the saved place stays until the very end), and it moves to the top
    t.clock.advance(60_000);
    await progress(mama, ID.holidays, 5300, 5760);
    body = await shelves(mama);
    expect(body.history.map((row) => [row.item.title, row.note])).toEqual([
      ['Весёлые каникулы', 'Просмотрено'],
      ['Тайна старого маяка', 'Смотрю'],
    ]);
    expect(body.marks.watched).toEqual([ID.holidays]);
    expect(Date.parse(body.history[0]?.at ?? '')).toBe(t.clock().getTime());
    // someone else's history is empty
    expect((await shelves(sasha)).history).toEqual([]);
  });

  it('marking by hand works both ways, and a finished film is no longer «Продолжить»', async () => {
    await boot();
    await progress(mama, ID.holidays, 1800, 5760);
    let home = (await get<CatalogHomeResponse>(mama, '/api/catalog')).body;
    expect(home.continueWatching.map((item) => item.title)).toEqual(['Весёлые каникулы']);

    expect((await mark(mama, ID.holidays, { watched: true })).body.watched).toBe(true);
    home = (await get<CatalogHomeResponse>(mama, '/api/catalog')).body;
    expect(home.continueWatching).toEqual([]);
    let body = await shelves(mama);
    expect(body.history.map((row) => [row.item.title, row.note])).toEqual([['Весёлые каникулы', 'Просмотрено']]);

    expect((await mark(mama, ID.holidays, { watched: false })).body.watched).toBe(false);
    body = await shelves(mama);
    expect(body.history).toEqual([]);
    expect(body.marks.watched).toEqual([]);
  });

  it('an episode counts for its series: the series is seen, and the history says which', async () => {
    await boot();
    await progress(mama, ID.episode2, 1250, 1320); // 94.7 %: watched
    const body = await shelves(mama);
    expect(body.history).toHaveLength(1);
    expect(body.history[0]).toMatchObject({ note: 'Просмотрено' });
    expect(body.history[0]?.item).toMatchObject({
      title: 'Дождливый вторник',
      seriesTitle: 'Приключения кота Мурзика',
      kind: 'episode',
    });
    // the series stands for its episode: its genres steer the picks, and it is not offered back
    const offered = body.forYou.find((row) => row.item.title === 'Весёлые каникулы');
    expect(offered?.note).toBe('Вы смотрели ещё „Приключения кота Мурзика“ в жанре „Семейный“');
    expect(titles(body.forYou)).not.toContain('Приключения кота Мурзика');
    // somebody else, who has not seen it, is offered the series by the count of the family
    expect(
      (await shelves(sasha)).forYou.find((row) => row.item.title === 'Приключения кота Мурзика')?.note,
    ).toBe('Уже смотрели или отметили: 1 человек из семьи');
  });

  it('checks what it is given', async () => {
    await boot();
    expect((await post(mama, '/api/catalog/marks', { id: 'nope', favourite: true })).status).toBe(400);
    expect((await post(mama, '/api/catalog/marks', { id: ID.holidays })).status).toBe(400);
    expect((await post(mama, '/api/catalog/marks', { id: ID.holidays, favourite: 'yes' })).status).toBe(400);
    const missing = await mark(mama, ID.unknown, { favourite: true });
    expect(missing.status).toBe(404);
    expect((missing.body as unknown as { message: string }).message).toContain('нет');
    // taking a mark off needs nothing from Jellyfin
    expect((await mark(mama, ID.unknown, { favourite: false })).status).toBe(200);
    const wrongType = await t.app.inject({
      method: 'POST',
      url: '/api/catalog/marks',
      headers: { cookie: mama, 'content-type': 'text/plain' },
      payload: 'id',
    });
    expect(wrongType.statusCode).toBe(415);
  });

  it('works honestly when Jellyfin is not there: the marks stay, the rows say why they are empty', async () => {
    await boot();
    await mark(mama, ID.holidays, { favourite: true });
    await fake.close();
    const body = await shelves(mama);
    expect(body.reason).toContain('не отвечает');
    expect(body.marks.favourites).toEqual([ID.holidays]);
    expect([body.news, body.forYou, body.favourites, body.later, body.history]).toEqual([[], [], [], [], []]);
    // a new mark cannot be checked now: plain words, not a crash
    const refused = await mark(mama, ID.courier, { favourite: true });
    expect(refused.status).toBe(502);
    fake = await startFakeJellyfin({ port, videoFile: VIDEO });
  });

  it('keeps the marks after a restart', async () => {
    await boot();
    await mark(mama, ID.holidays, { favourite: true });
    await mark(mama, ID.courier, { later: true });
    const { dataDir } = t;
    await t.app.close();
    t = await createTestApp({
      dataDir,
      clock: createFakeClock(new Date().toISOString()),
      env: { JELLYFIN_URL: `http://127.0.0.1:${port}` },
    });
    mama = await cookieFor(t.app, FAMILY);
    const body = await shelves(mama);
    expect(body.marks).toEqual({ favourites: [ID.holidays], later: [ID.courier], watched: [] });
  });
});

describe('news appear without a restart', () => {
  it('the library is read once a minute, and a refresh after a download shows the new file at once', async () => {
    await boot();
    const before = await shelves(mama);
    expect(titles(before.news)).not.toContain('Скачанный фильм');
    fake.stage({
      Id: pad(0x40),
      Name: 'Скачанный фильм',
      Type: 'Movie',
      Genres: ['Драма'],
      ProductionYear: 2026,
      parent: ID.movies,
    });
    // Jellyfin has not looked yet: nothing changes, and nothing is asked again
    const asked = fake.requests.length;
    expect(titles((await shelves(mama)).news)).not.toContain('Скачанный фильм');
    expect(fake.requests.slice(asked).some((line) => line.includes('Recursive=true'))).toBe(false);
  });

  it('a finished download into the media library refreshes Jellyfin, and «Новое» shows the film', async () => {
    const aria2Port = await freePort();
    await boot({
      env: { TORRENT_RPC_URL: `http://127.0.0.1:${aria2Port}/jsonrpc` },
      extra: {
        torrentClientInstalled: () => true,
        freeBytes: async () => 5 * 1024 ** 4,
        resolveTrackerHost: async () => ['93.184.216.34'],
      },
    });
    const owner = await t.app.dashboard.users.findByUsername(FAMILY.username);
    await t.app.dashboard.users.update(owner?.id ?? '', { permissions: ['downloads'] });
    const engine: FakeAria2 = await startFakeAria2({
      secret: (await readAria2Secret(t.dataDir)) as string,
      port: aria2Port,
    });
    try {
      // the film's file lies in the media folder, but Jellyfin has not looked yet
      fake.stage({
        Id: pad(0x41),
        Name: 'Каникулы у бабушки',
        Type: 'Movie',
        Genres: ['Комедия'],
        ProductionYear: 2026,
        parent: ID.movies,
      });
      expect(titles((await shelves(mama)).news)).toEqual(['Звёздный курьер', 'Семейные песни']);

      const sample = makeTorrent({
        name: 'Каникулы',
        files: [{ path: ['серия 1.mkv'], length: 4000 }],
        announce: 'udp://tracker.example.org:6969/announce',
      });
      const check = await t.app.inject({
        method: 'PUT',
        url: '/api/downloads/torrent-file?name=test.torrent',
        headers: { cookie: mama, 'content-type': 'application/octet-stream', 'x-upload': '1' },
        payload: sample.bytes,
      });
      const added = await post(mama, '/api/downloads', {
        checkId: (check.json() as { checkId: string }).checkId,
        destination: 'movies',
      });
      expect(added.status).toBe(200);
      engine.finish(sample.infoHash);
      await t.app.dashboard.torrents.poll();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const after = await shelves(mama);
      expect(titles(after.news)).toEqual(['Каникулы у бабушки', 'Звёздный курьер', 'Семейные песни']);
      expect(fake.requests.some((line) => line.startsWith('POST /Library/Refresh'))).toBe(true);
    } finally {
      await engine.close().catch(() => undefined);
    }
  });
});

describe('the kept library scan', () => {
  const settings = (now: () => number, fetchImpl?: typeof fetch) => ({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: () => FAKE_KEY,
    now,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const scans = () => fake.requests.filter((line) => line.includes('Recursive=true&IncludeItemTypes=Movie')).length;
  // the app is not needed here, but afterEach closes it
  beforeEach(async () => {
    await boot();
  });

  it('reads the whole library once and keeps it for a minute', async () => {
    let now = 1_000_000;
    const client = createJellyfinClient(settings(() => now));
    const first = await client.scan();
    expect(first.map((entry) => entry.title).sort()).toEqual(
      [
        'Весёлые каникулы',
        'Звёздный курьер',
        'Приключения кота Мурзика',
        'Семейные песни',
        'Сказки на ночь',
        'Тайна старого маяка',
        'Фильм без обложки',
      ].sort(),
    );
    expect(scans()).toBe(1);
    now += 59_000;
    await client.scan();
    expect(scans()).toBe(1);
    now += 2_000;
    await client.scan();
    expect(scans()).toBe(2);
  });

  it('knows when each title came in and what an episode or a chapter belongs to', async () => {
    const client = createJellyfinClient(settings(() => 1));
    const found = await client.entriesByIds([ID.episode1, ID.chapter, ID.holidays, 'not-an-id', ID.episode1]);
    const byId = Object.fromEntries(found.map((entry) => [entry.id, entry]));
    expect(Object.keys(byId).sort()).toEqual([ID.chapter, ID.episode1, ID.holidays].sort());
    expect(byId[ID.episode1]).toMatchObject({ parentId: ID.series, kind: 'episode' });
    expect(byId[ID.chapter]).toMatchObject({ parentId: ID.book, kind: 'audiobook' });
    expect(byId[ID.holidays]).toMatchObject({ parentId: null, kind: 'movie' });
    expect(byId[ID.holidays]?.addedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const library = await client.scan();
    const courier = library.find((entry) => entry.id === ID.courier);
    expect(Date.now() - Date.parse(courier?.addedAt ?? '')).toBeLessThan(3 * 24 * 3600 * 1000);
  });

  it('a library refresh forgets what was kept and asks again soon, for a while', async () => {
    let now = 5_000_000;
    const client = createJellyfinClient(settings(() => now));
    await client.scan();
    fake.stage({ Id: pad(0x50), Name: 'Новинка', Type: 'Movie', parent: ID.movies });
    now += 10_000;
    expect((await client.scan()).some((entry) => entry.title === 'Новинка')).toBe(false); // still kept
    await client.refreshLibrary();
    expect((await client.scan()).some((entry) => entry.title === 'Новинка')).toBe(true); // at once
    expect(scans()).toBe(2);
    // the next minutes: a short memory, because Jellyfin scans on its own time
    now += 6_000;
    await client.scan();
    expect(scans()).toBe(3);
    now += 4_000;
    await client.scan();
    expect(scans()).toBe(3);
    // ten minutes after the refresh: back to a minute
    now += 11 * 60_000;
    await client.scan();
    expect(scans()).toBe(4);
    now += 30_000;
    await client.scan();
    expect(scans()).toBe(4);
  });

  it('a scan that was running while a refresh happened is not kept as if it were fresh', async () => {
    let now = 9_000_000;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: typeof fetch = async (input, init) => {
      if (String(input).includes('/Items?')) await gate;
      return fetch(input, init);
    };
    const client = createJellyfinClient(settings(() => now, slow));
    const running = client.scan();
    const same = client.scan();
    await client.refreshLibrary();
    release();
    await Promise.all([running, same]);
    const before = scans();
    now += 1000;
    await client.scan();
    expect(scans()).toBe(before + 1);
  });

  it('shares one scan between callers that ask at the same time', async () => {
    const client = createJellyfinClient(settings(() => 1));
    await Promise.all([client.scan(), client.scan(), client.scan()]);
    expect(scans()).toBe(1);
  });
});

describe('film suggestions', () => {
  const suggest = (cookie: string, title: string, note?: string) =>
    post<CatalogSuggestion & { message?: string; error?: string }>(cookie, '/api/catalog/suggestions', {
      title,
      ...(note === undefined ? {} : { note }),
    });
  const list = async (cookie: string) =>
    (await get<CatalogSuggestionsResponse>(cookie, '/api/catalog/suggestions')).body;
  const notices = async (cookie: string) =>
    (await get<NotificationsResponse>(cookie, '/api/notifications')).body.notifications;

  it('anybody suggests; everybody sees the list; only administrators can decide', async () => {
    await boot();
    const made = await suggest(mama, 'Кот в сапогах', 'Хочется посмотреть всем вместе');
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      title: 'Кот в сапогах',
      note: 'Хочется посмотреть всем вместе',
      byName: 'Мама',
      mine: true,
      status: 'open',
    });
    const seen = await list(sasha);
    expect(seen.canModerate).toBe(false);
    expect(seen.suggestions).toHaveLength(1);
    expect(seen.suggestions[0]).toMatchObject({ title: 'Кот в сапогах', byName: 'Мама', mine: false });
    expect((await list(papa)).canModerate).toBe(true);
    expect((await shelves(sasha)).openSuggestions).toBe(1);

    const id = made.body.id;
    expect((await post(mama, `/api/admin/catalog/suggestions/${id}`, { status: 'added' })).status).toBe(403);
    expect((await post(sasha, `/api/admin/catalog/suggestions/${id}`, { status: 'added' })).status).toBe(403);
    expect((await list(mama)).suggestions[0]?.status).toBe('open');

    const decided = await post<CatalogSuggestion>(papa, `/api/admin/catalog/suggestions/${id}`, { status: 'added' });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ status: 'added', mine: false });
    expect((await list(mama)).suggestions[0]).toMatchObject({ status: 'added', mine: true });
    expect((await shelves(sasha)).openSuggestions).toBe(0);
    expect((await post(papa, `/api/admin/catalog/suggestions/${id}`, { status: 'weird' })).status).toBe(400);
    expect((await post(papa, `/api/admin/catalog/suggestions/${'f'.repeat(36)}`, { status: 'declined' })).status).toBe(404);

    const trail = await t.app.dashboard.audit.readLatest(5);
    expect(trail[0]).toMatchObject({ action: 'catalog.suggestion', actor: 'papa' });
    expect(trail[0]?.detail).toContain('добавлено');
    expect(trail[0]?.detail).not.toContain('Кот в сапогах');
  });

  it('administrators get a notification of a new suggestion; the author and the family do not', async () => {
    await boot();
    await suggest(mama, 'Шрек');
    const admin = await notices(papa);
    expect(admin).toHaveLength(1);
    expect(admin[0]).toMatchObject({
      kind: 'system',
      title: 'Предложен фильм',
      url: '/cinema?suggest=1',
      read: false,
    });
    expect(admin[0]?.body).toContain('Шрек');
    expect(admin[0]?.body).toContain('Мама');
    expect(await notices(mama)).toEqual([]);
    expect(await notices(sasha)).toEqual([]);
    // an administrator's own suggestion tells no one but the other administrators
    await suggest(papa, 'Мадагаскар');
    expect(await notices(papa)).toHaveLength(1);
  });

  it('checks the title, refuses a repeat and a film that is already in the library', async () => {
    await boot();
    expect((await suggest(mama, '   ')).status).toBe(400);
    expect((await post(mama, '/api/catalog/suggestions', {})).status).toBe(400);
    expect((await suggest(mama, 'я'.repeat(200))).status).toBe(400);
    expect((await suggest(mama, 'Шрек', 'я'.repeat(400))).status).toBe(400);
    expect((await suggest(mama, 'Шрек')).status).toBe(201);
    const again = await suggest(sasha, '«шрек»');
    expect(again.status).toBe(409);
    expect(again.body.message).toContain('уже есть в списке');
    const present = await suggest(sasha, 'звёздный курьер');
    expect(present.status).toBe(409);
    expect(present.body.error).toBe('in_library');
    expect(present.body.message).toContain('уже есть в медиатеке');
    expect((await list(papa)).suggestions).toHaveLength(1);
  });

  it('without Jellyfin the family can still suggest', async () => {
    await boot({ key: null });
    expect((await suggest(mama, 'Шрек')).status).toBe(201);
  });

  it('the author takes back an open suggestion; nobody else can', async () => {
    await boot();
    const made = await suggest(mama, 'Шрек');
    const id = made.body.id;
    expect((await post(sasha, `/api/catalog/suggestions/${id}/withdraw`)).status).toBe(403);
    expect((await post(mama, `/api/catalog/suggestions/${id}/withdraw`)).status).toBe(204);
    expect((await list(papa)).suggestions).toEqual([]);
    expect((await post(mama, `/api/catalog/suggestions/${id}/withdraw`)).status).toBe(404);
    expect((await post(mama, '/api/catalog/suggestions/..%2Fx/withdraw')).status).toBe(404);
  });
});

describe('the public way (a tunnel) reaches the everyday part only', () => {
  const config = { publicAllowMediaStream: false };
  it('lets the family look at the rows, mark, and suggest; the decision stays closed', () => {
    expect(publicRouteAllowed('GET', '/api/catalog/shelves', config)).toBe(true);
    expect(publicRouteAllowed('GET', '/api/catalog/suggestions', config)).toBe(true);
    expect(publicRouteAllowed('POST', '/api/catalog/marks', config)).toBe(true);
    expect(publicRouteAllowed('POST', '/api/catalog/suggestions', config)).toBe(true);
    expect(publicRouteAllowed('POST', '/api/catalog/suggestions/:id/withdraw', config)).toBe(true);
    expect(publicRouteAllowed('POST', '/api/admin/catalog/suggestions/:id', config)).toBe(false);
  });

  it('is enforced on a real request that comes through the tunnel', async () => {
    await boot();
    const tunnel = { 'cf-ray': 'abc' };
    expect((await call('GET', mama, '/api/catalog/shelves', undefined, tunnel)).status).toBe(200);
    expect((await call('POST', mama, '/api/catalog/marks', { id: ID.holidays, favourite: true }, tunnel)).status).toBe(200);
    const closed = await call('POST', papa, `/api/admin/catalog/suggestions/${'a'.repeat(36)}`, { status: 'added' }, tunnel);
    expect(closed.status).toBe(403);
    expect((closed.body as unknown as { error: string }).error).toBe('channel_restricted');
  });
});

describe('the fake library is what the tests assume', () => {
  it('has the titles used above', () => {
    const names = ITEMS.map((item) => item.Name);
    for (const name of ['Весёлые каникулы', 'Тайна старого маяка', 'Звёздный курьер', 'Дождливый вторник']) {
      expect(names).toContain(name);
    }
  });
});
