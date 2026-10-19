import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatConversation } from '../../shared/api.ts';
import type { SearchGroup, SearchKind, SearchResponse } from '../../shared/search.ts';
import { publicRouteAllowed } from '../src/lib/channel.ts';
import { fileHref, russianDate, significant, snippet } from '../src/search/unified.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, makeTempDir, removeDir } from './helpers.ts';

const SON = { username: 'son', password: 'son-password-12', role: 'family' as const, displayName: 'Сын' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup() {
  const filesDir = await makeTempDir('fd-sfiles-');
  const photosDir = await makeTempDir('fd-sphotos-');
  const t = await createTestApp({
    env: { FAMILY_FILES_DIR: filesDir, FAMILY_PHOTOS_DIR: photosDir, MIN_FREE_GB: '0' },
    freeBytes: async () => 500 * 1024 ** 3,
  });
  const ids: Record<string, string> = {};
  for (const user of [ADMIN, FAMILY, SON]) ids[user.username] = (await addUser(t.dataDir, t.clock, user)).id;
  cleanup.push(async () => {
    await t.app.close();
    for (const dir of [t.dataDir, filesDir, photosDir]) await removeDir(dir);
  });
  return {
    t,
    ids,
    filesDir,
    photosDir,
    admin: await cookieFor(t.app, ADMIN),
    mama: await cookieFor(t.app, FAMILY),
    son: await cookieFor(t.app, SON),
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const post = (s: Setup, cookie: string, url: string, payload: object = {}) =>
  s.t.app.inject({ method: 'POST', url, headers: { cookie }, payload });

async function find(s: Setup, cookie: string, q: string, kinds?: SearchKind[]): Promise<SearchResponse> {
  const url = `/api/search?q=${encodeURIComponent(q)}${kinds ? `&kinds=${kinds.join(',')}` : ''}`;
  const res = await s.t.app.inject({ url, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SearchResponse;
}

const group = (answer: SearchResponse, kind: SearchKind): SearchGroup => {
  const found = answer.groups.find((item) => item.kind === kind);
  if (!found) throw new Error(`no group ${kind}`);
  return found;
};
const titles = (answer: SearchResponse, kind: SearchKind): string[] =>
  group(answer, kind).hits.map((hit) => hit.title);
const everything = (answer: SearchResponse): string => JSON.stringify(answer);

async function put(file: string, text = 'x') {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe('helpers of the unified search', () => {
  it('writes dates in Russian and cuts a readable piece of text around the match', () => {
    expect(russianDate('2026-03-05')).toBe('5 марта 2026');
    expect(russianDate('nonsense')).toBe('nonsense');
    const text = `${'начало '.repeat(20)}билеты на поезд до дачи${' конец'.repeat(20)}`;
    const piece = snippet(text, ['билет']);
    expect(piece).toContain('билеты');
    expect(piece.startsWith('…')).toBe(true);
    expect(piece.endsWith('…')).toBe(true);
    expect(snippet('короткий текст', ['нет'])).toBe('короткий текст');
  });

  it('drops the little words of a sentence but keeps a query made only of them', () => {
    expect(significant('фото на даче')).toBe('фото даче');
    expect(significant('найди  мой договор')).toBe('договор');
    expect(significant('на')).toBe('на');
    expect(significant('я')).toBe('');
  });

  it('builds the links the pages understand', () => {
    const file = {
      root: 'files',
      space: 'shared' as const,
      folder: 'Договоры/2026',
      name: 'аренда.pdf',
      isFolder: false,
      sizeBytes: 1,
    };
    expect(fileHref('files', file)).toBe(`/files?space=shared&path=${encodeURIComponent('Договоры/2026')}`);
    expect(fileHref('files', { ...file, folder: 'Договоры', name: '2026', isFolder: true })).toBe(
      `/files?space=shared&path=${encodeURIComponent('Договоры/2026')}`,
    );
    expect(fileHref('photos', { ...file, root: 'photos', folder: '2026-05/пляж', name: 'a.jpg' })).toBe(
      '/photos?space=shared&month=2026-05',
    );
  });

  it('is open on the public address too, like the other ways of looking things up', () => {
    expect(publicRouteAllowed('GET', '/api/search', { publicAllowMediaStream: false })).toBe(true);
  });
});

describe('unified search', { timeout: 30_000 }, () => {
  it('needs a signed-in user', async () => {
    const s = await setup();
    expect((await s.t.app.inject({ url: '/api/search?q=дача' })).statusCode).toBe(401);
  });

  it('finds by the beginning of a word, so that endings do not matter', async () => {
    const s = await setup();
    await put(path.join(s.filesDir, 'shared', 'Дача', 'план участка.txt'));
    const answer = await find(s, s.mama, 'на даче');
    expect(titles(answer, 'files')).toContain('Дача');
    expect(group(answer, 'files').hits[0]?.href).toContain('/files?');
  });

  it('ignores a query that is too short to mean anything', async () => {
    const s = await setup();
    await put(path.join(s.filesDir, 'shared', 'я.txt'));
    const answer = await find(s, s.mama, 'я');
    expect(answer.groups.every((item) => item.hits.length === 0)).toBe(true);
  });

  it('searches files and photos by name in the own and the shared folders, never in another person’s', async () => {
    const s = await setup();
    await put(path.join(s.filesDir, 'users', 'mama', 'Бумаги', 'паспорт мамы.pdf'));
    await put(path.join(s.filesDir, 'users', 'son', 'паспорт сына.pdf'));
    await put(path.join(s.filesDir, 'shared', 'паспорт-образец.txt'));
    await put(path.join(s.photosDir, 'users', 'son', '2026-05', 'паспорт.jpg'));
    await put(path.join(s.photosDir, 'shared', '2026-06', 'паспорт-семейный.jpg'));

    const mama = await find(s, s.mama, 'паспорт');
    expect(titles(mama, 'files').sort()).toEqual(['паспорт мамы.pdf', 'паспорт-образец.txt']);
    expect(titles(mama, 'photos')).toEqual(['паспорт-семейный.jpg']);

    // The administrator is a person like the others here: the son's own files stay his.
    const admin = await find(s, s.admin, 'паспорт');
    expect(titles(admin, 'files')).toEqual(['паспорт-образец.txt']);
    expect(titles(admin, 'photos')).toEqual(['паспорт-семейный.jpg']);
    expect(everything(admin)).not.toContain('сына');
    expect(everything(admin)).not.toContain('паспорт мамы');
  });

  it('searches notes by title and text, and a private note is only for its author', async () => {
    const s = await setup();
    const save = (cookie: string, space: string, name: string, text: string) =>
      post(s, cookie, '/api/notes/save', { space, name, text, revision: null });
    expect((await save(s.mama, 'personal', 'Подарки', 'купить велосипед для Саши')).statusCode).toBe(200);
    expect((await save(s.mama, 'shared', 'Поездка', 'взять велосипеды и насос')).statusCode).toBe(200);

    const mama = await find(s, s.mama, 'велосипед');
    expect(titles(mama, 'notes').sort()).toEqual(['Подарки', 'Поездка']);
    expect(group(mama, 'notes').hits.find((hit) => hit.title === 'Подарки')?.href).toBe(
      `/notes?space=personal&note=${encodeURIComponent('Подарки')}`,
    );

    const admin = await find(s, s.admin, 'велосипед');
    expect(titles(admin, 'notes')).toEqual(['Поездка']);
    const son = await find(s, s.son, 'велосипед');
    expect(everything(son)).not.toContain('Саши');
    // The note files also lie in «Файлы»: they must not be listed twice.
    expect(titles(await find(s, s.mama, 'Подарки'), 'files')).toEqual([]);
  });

  it('shows calendar events the person may see: family ones for everybody, private ones for their author only', async () => {
    const s = await setup();
    await post(s, s.mama, '/api/calendar', { title: 'Сюрприз для Саши', date: '2026-12-01', private: true });
    await post(s, s.mama, '/api/calendar', { title: 'Сюрприз-вечеринка', date: '2026-12-05', time: '18:00' });
    await post(s, s.mama, '/api/calendar', {
      title: 'Сюрприз бабушке',
      date: '2024-02-29',
      repeat: 'yearly',
    });

    const mama = await find(s, s.mama, 'сюрприз');
    expect(titles(mama, 'events')).toHaveLength(3);
    const party = group(mama, 'events').hits.find((hit) => hit.title === 'Сюрприз-вечеринка');
    expect(party?.detail).toBe('5 декабря 2026, 18:00');
    expect(party?.href).toBe('/calendar?day=2026-12-05&month=2026-12');
    // A yearly event shows its next day, not the first one.
    const yearly = group(mama, 'events').hits.find((hit) => hit.title === 'Сюрприз бабушке');
    expect(yearly?.detail).toBe('29 февраля 2028, каждый год');

    for (const cookie of [s.admin, s.son]) {
      const other = await find(s, cookie, 'сюрприз');
      expect(titles(other, 'events').sort()).toEqual(['Сюрприз бабушке', 'Сюрприз-вечеринка']);
      expect(everything(other)).not.toContain('для Саши');
    }
  });

  it('finds tasks the person may see: shared ones for everybody, private ones for their author only', async () => {
    const s = await setup();
    await post(s, s.mama, '/api/tasks', { title: 'Купить подарок бабушке', private: true });
    await post(s, s.mama, '/api/tasks', { title: 'Купить продукты к празднику' });
    const shopping = (
      await post(s, s.mama, '/api/tasks/lists', { name: 'Покупки', kind: 'shopping' })
    ).json() as {
      id: string;
    };
    await post(s, s.mama, '/api/tasks', { title: 'Купить хлеб', listId: shopping.id });

    const mama = await find(s, s.mama, 'купить');
    expect(titles(mama, 'tasks').sort()).toEqual([
      'Купить подарок бабушке',
      'Купить продукты к празднику',
      'Купить хлеб',
    ]);
    expect(group(mama, 'tasks').hits.find((hit) => hit.title === 'Купить хлеб')?.detail).toContain('Покупки');
    for (const cookie of [s.admin, s.son]) {
      const other = await find(s, cookie, 'купить');
      expect(titles(other, 'tasks').sort()).toEqual(['Купить продукты к празднику', 'Купить хлеб']);
      expect(everything(other)).not.toContain('подарок');
    }
  });

  it('searches chats only where the person is a member; the administrator gets no way into other rooms', async () => {
    const s = await setup();
    const direct = (
      await s.t.app.inject({
        method: 'POST',
        url: '/api/chat/conversations/direct',
        headers: { cookie: s.mama },
        payload: { userId: s.ids.son },
      })
    ).json() as ChatConversation;
    await post(s, s.mama, `/api/chat/conversations/${direct.id}/messages`, {
      text: 'Не говори папе: торт заказан на субботу',
    });
    await post(s, s.mama, '/api/chat/conversations/family/messages', { text: 'Торт на субботу в пять' });

    const son = await find(s, s.son, 'торт');
    expect(group(son, 'chats').hits).toHaveLength(2);
    expect(group(son, 'chats').hits.map((hit) => hit.title)).toContain('Мама');
    expect(group(son, 'chats').hits[0]?.href).toMatch(/^\/chat\?c=/);

    const admin = await find(s, s.admin, 'торт');
    expect(group(admin, 'chats').hits.map((hit) => hit.title)).toEqual(['Семейный чат']);
    expect(everything(admin)).not.toContain('Не говори папе');

    // A deleted message is gone from the search as well.
    const sent = (
      await post(s, s.mama, '/api/chat/conversations/family/messages', { text: 'пирог с вишней' })
    ).json() as { id: string };
    expect(titles(await find(s, s.son, 'вишн'), 'chats')).toEqual(['Семейный чат']);
    await post(s, s.mama, `/api/chat/conversations/family/messages/${sent.id}/delete`, {});
    expect(titles(await find(s, s.son, 'вишн'), 'chats')).toEqual([]);
  });

  it('says that the cinema is unavailable instead of pretending there are no films', async () => {
    const s = await setup();
    const answer = await find(s, s.mama, 'кино');
    const media = group(answer, 'media');
    expect(media.hits).toEqual([]);
    expect(media.unavailable).not.toBeNull();
    // The other places still answer.
    expect(group(answer, 'files').unavailable).toBeNull();
  });

  it('limits the answer, honours the list of places and refuses nonsense', async () => {
    const s = await setup();
    for (let n = 0; n < 12; n += 1) await put(path.join(s.filesDir, 'shared', `отчёт ${n}.txt`));
    const some = await find(s, s.mama, 'отчёт', ['files']);
    expect(some.groups.map((item) => item.kind)).toEqual(['files']);
    expect(group(some, 'files').hits).toHaveLength(6);
    expect(group(some, 'files').more).toBe(true);
    const res = await s.t.app.inject({
      url: `/api/search?q=${encodeURIComponent('отчёт')}&kinds=files&limit=20`,
      headers: { cookie: s.mama },
    });
    expect((res.json() as SearchResponse).groups[0]?.hits).toHaveLength(12);
    expect(
      (await s.t.app.inject({ url: '/api/search?q=отчёт&limit=500', headers: { cookie: s.mama } }))
        .statusCode,
    ).toBe(400);
    expect((await find(s, s.mama, 'x'.repeat(300))).query).toHaveLength(80);
  });
});
