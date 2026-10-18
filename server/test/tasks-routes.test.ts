import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ApiError,
  AuditResponse,
  ClearDoneResponse,
  CreateManyTasksResponse,
  DeleteTaskListResponse,
  NotificationsResponse,
  TaskListView,
  TasksResponse,
  TaskView,
} from '../../shared/api.ts';
import { publicRouteAllowed } from '../src/lib/channel.ts';
import { REMOVED_OWNER } from '../src/planner/calendar.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createFakeClock,
  createTestApp,
  FAMILY,
  type FakeClock,
  makeTempDir,
  removeDir,
  type TestApp,
} from './helpers.ts';

const SON = { username: 'son', password: 'son-password-12', role: 'family' as const, displayName: 'Сын' };
const PUBLIC_HOST = 'family.example.org';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A clock set to a wall-clock moment of THIS computer, so the tests do not depend on its time zone. */
const clockAt = (y: number, m: number, d: number, hh = 10, mm = 0): FakeClock =>
  createFakeClock(new Date(y, m - 1, d, hh, mm).toISOString());

async function setup(options: { clock?: FakeClock; env?: Record<string, string> } = {}) {
  const t = await createTestApp({
    clock: options.clock ?? clockAt(2026, 10, 16, 17, 0),
    env: options.env,
  });
  const users: Record<string, string> = {};
  for (const u of [ADMIN, FAMILY, SON]) users[u.username] = (await addUser(t.dataDir, t.clock, u)).id;
  cleanup.push(async () => {
    await t.app.close();
    await removeDir(t.dataDir);
  });
  return {
    t,
    ids: users,
    admin: await cookieFor(t.app, ADMIN),
    mama: await cookieFor(t.app, FAMILY),
    son: await cookieFor(t.app, SON),
  };
}

const post = (t: TestApp, cookie: string, url: string, payload: object = {}, headers: object = {}) =>
  t.app.inject({ method: 'POST', url, headers: { cookie, ...headers }, payload });
const get = (t: TestApp, cookie: string, url: string, headers: object = {}) =>
  t.app.inject({ url, headers: { cookie, ...headers } });
const tasksOf = async (t: TestApp, cookie: string, query = '') =>
  (await get(t, cookie, `/api/tasks${query}`)).json<TasksResponse>();
const titlesOf = async (t: TestApp, cookie: string) => (await tasksOf(t, cookie)).tasks.map((x) => x.title);

describe('family tasks: access', () => {
  it('needs a signed-in user for everything', async () => {
    const { t } = await setup();
    for (const [method, url] of [
      ['GET', '/api/tasks'],
      ['POST', '/api/tasks'],
      ['POST', '/api/tasks/many'],
      ['POST', '/api/tasks/clear-done'],
      ['POST', '/api/tasks/lists'],
      ['POST', '/api/tasks/00000000-0000-4000-8000-000000000001/done'],
      ['POST', '/api/tasks/lists/00000000-0000-4000-8000-000000000001/clear-done'],
    ] as const) {
      const res = await t.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('accepts changes only as JSON from the portal’s own pages', async () => {
    const { t, mama } = await setup();
    const form = await t.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: mama, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'title=%D0%A5%D0%BB%D0%B5%D0%B1',
    });
    expect(form.statusCode).toBe(415);
    const crossSite = await post(t, mama, '/api/tasks', { title: 'Хлеб' }, { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.statusCode).toBe(403);
    expect(await titlesOf(t, mama)).toEqual([]);
  });

  it('is open on the protected public address like the other family features, and nothing else is', async () => {
    const { t, mama } = await setup({ env: { PUBLIC_HTTPS_URL: `https://${PUBLIC_HOST}` } });
    const outside = { host: PUBLIC_HOST };
    const created = await post(t, mama, '/api/tasks', { title: 'Из отпуска' }, outside);
    expect(created.statusCode).toBe(201);
    expect((await get(t, mama, '/api/tasks', outside)).statusCode).toBe(200);
    const id = created.json<TaskView>().id;
    expect((await post(t, mama, `/api/tasks/${id}/done`, { done: true }, outside)).statusCode).toBe(200);
    expect((await post(t, mama, `/api/tasks/${id}/delete`, {}, outside)).statusCode).toBe(204);
    const config = { publicAllowMediaStream: false };
    expect(publicRouteAllowed('GET', '/api/tasks', config)).toBe(true);
    expect(publicRouteAllowed('POST', '/api/tasks/:id/done', config)).toBe(true);
    expect(publicRouteAllowed('POST', '/api/tasks/lists/:id/clear-done', config)).toBe(true);
    expect(publicRouteAllowed('GET', '/api/tasksplus', config)).toBe(false);
  });
});

describe('family tasks: adding and showing', () => {
  it('adds a task with everything a task has and shows it to the others', async () => {
    const { t, mama, son } = await setup();
    const res = await post(t, mama, '/api/tasks', {
      title: '  Записать сына к врачу ',
      note: 'Взять полис',
      due: '2026-10-20',
      dueTime: '09:30',
      repeat: 'yearly',
      assignee: 'Son',
      remindBefore: 60,
      private: false,
    });
    expect(res.statusCode, res.body).toBe(201);
    const made = res.json<TaskView>();
    expect(made).toMatchObject({
      title: 'Записать сына к врачу',
      note: 'Взять полис',
      due: '2026-10-20',
      dueTime: '09:30',
      repeat: 'yearly',
      assignee: 'son',
      assigneeName: 'Сын',
      remindBefore: 60,
      private: false,
      listId: null,
      owner: 'mama',
      ownerName: 'Мама',
      done: false,
      canEdit: true,
      canUndo: false,
    });
    const seen = (await tasksOf(t, son)).tasks[0];
    expect(seen).toMatchObject({ id: made.id, canEdit: false, assigneeName: 'Сын' });
    // the file is in the data folder, so every backup has it
    expect(JSON.parse(await readFile(path.join(t.dataDir, 'tasks.json'), 'utf8')).tasks).toHaveLength(1);
  });

  it('lists the family members a task can be given to, without the ones switched off', async () => {
    const { t, mama, ids } = await setup();
    expect((await tasksOf(t, mama)).people).toEqual([
      { username: 'mama', displayName: 'Мама' },
      { username: 'papa', displayName: 'Папа' },
      { username: 'son', displayName: 'Сын' },
    ]);
    await t.app.dashboard.users.update(ids.son ?? '', { disabled: true });
    expect((await tasksOf(t, mama)).people.map((p) => p.username)).toEqual(['mama', 'papa']);
    const toSwitchedOff = await post(t, mama, '/api/tasks', { title: 'Сыну', assignee: 'son' });
    expect(toSwitchedOff.statusCode).toBe(400);
    expect(toSwitchedOff.json<ApiError>().error).toBe('bad_assignee');
  });

  it('explains problems in plain words and stores nothing', async () => {
    const { t, mama } = await setup();
    const bad = async (payload: object) => {
      const res = await post(t, mama, '/api/tasks', payload);
      expect(res.statusCode).toBe(400);
      return res.json<ApiError>().message;
    };
    expect(await bad({ title: '  ' })).toContain('Напишите');
    expect(await bad({})).toContain('Напишите');
    expect(await bad({ title: 'x', due: '2026-02-30' })).toContain('настоящую дату');
    expect(await bad({ title: 'x', dueTime: '10:00' })).toContain('вместе с датой');
    expect(await bad({ title: 'x', repeat: 'weekly' })).toContain('укажите дату');
    expect(await bad({ title: 'x', repeat: 'hourly' })).toContain('Проверьте');
    expect(await bad({ title: 'x', remindBefore: 5 })).toContain('укажите дату');
    expect(await bad({ title: 'x', due: '2026-10-20', remindBefore: 99999 })).toContain('за неделю');
    expect(await bad({ title: 'x', assignee: 'nobody' })).toContain('Такого человека');
    expect(await bad({ title: 'x', private: true, assignee: 'son' })).toContain('Личное дело');
    expect(await bad({ title: 'x', listId: '00000000-0000-4000-8000-000000000009' })).toContain('Такого списка');
    expect(await bad({ title: 'я'.repeat(121) })).toContain('120');
    expect(await titlesOf(t, mama)).toEqual([]);
    expect((await post(t, mama, '/api/tasks/not-an-id/update', { title: 'x' })).statusCode).toBe(404);
  });

  it('can give only the open tasks that are due by a day, for the home page', async () => {
    const { t, mama } = await setup();
    await post(t, mama, '/api/tasks', { title: 'Вчера', due: '2026-10-15' });
    await post(t, mama, '/api/tasks', { title: 'Сегодня', due: '2026-10-16', dueTime: '18:00' });
    await post(t, mama, '/api/tasks', { title: 'Завтра', due: '2026-10-17' });
    await post(t, mama, '/api/tasks', { title: 'Без срока' });
    const done = (await post(t, mama, '/api/tasks', { title: 'Сделано', due: '2026-10-16' })).json<TaskView>();
    await post(t, mama, `/api/tasks/${done.id}/done`, { done: true });
    const today = await tasksOf(t, mama, '?until=2026-10-16');
    expect(today.tasks.map((x) => x.title)).toEqual(['Вчера', 'Сегодня']);
    expect((await tasksOf(t, mama)).tasks).toHaveLength(5);
    expect((await get(t, mama, '/api/tasks?until=yesterday')).statusCode).toBe(400);
    expect((await get(t, mama, '/api/tasks?until=2026-02-30')).statusCode).toBe(400);
  });

  it('keeps the journal free of what the tasks say', async () => {
    const { t, mama, admin } = await setup();
    await post(t, mama, '/api/tasks', { title: 'СЕКРЕТНЫЙ-ПОДАРОК', private: true });
    const list = (await post(t, mama, '/api/tasks/lists', { name: 'СЕКРЕТНЫЙ-СПИСОК', private: true })).json<TaskListView>();
    await post(t, mama, `/api/tasks/lists/${list.id}/rename`, { name: 'СЕКРЕТНЫЙ-СПИСОК-2' });
    await t.app.dashboard.audit.idle();
    const entries = (await get(t, admin, '/api/admin/audit?limit=50')).json<AuditResponse>().entries;
    const planner = entries.filter((e) => e.action === 'planner.change');
    expect(planner.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(entries)).not.toContain('СЕКРЕТНЫЙ');
  });
});

describe('family tasks: privacy', () => {
  it('shows a private task and a private list to their author only — an administrator is no exception', async () => {
    const { t, mama, son, admin } = await setup();
    const secret = (await post(t, mama, '/api/tasks', { title: 'Подарок папе', private: true })).json<TaskView>();
    const list = (
      await post(t, mama, '/api/tasks/lists', { name: 'Тайный список', kind: 'todo', private: true })
    ).json<TaskListView>();
    const inList = (
      await post(t, mama, '/api/tasks', { title: 'Билеты', listId: list.id, private: false })
    ).json<TaskView>();
    expect(inList.private).toBe(true);
    await post(t, mama, '/api/tasks', { title: 'Общее дело' });

    expect(await titlesOf(t, mama)).toEqual(['Подарок папе', 'Билеты', 'Общее дело']);
    for (const other of [son, admin]) {
      const seen = await tasksOf(t, other);
      expect(seen.tasks.map((x) => x.title)).toEqual(['Общее дело']);
      expect(seen.lists).toEqual([]);
      expect(JSON.stringify(seen)).not.toContain('Подарок');
      expect(JSON.stringify(seen)).not.toContain('Тайный');
      for (const [url, body] of [
        [`/api/tasks/${secret.id}/update`, { title: 'Взломано' }],
        [`/api/tasks/${secret.id}/done`, { done: true }],
        [`/api/tasks/${secret.id}/delete`, {}],
        [`/api/tasks/${inList.id}/done`, { done: true }],
        [`/api/tasks/lists/${list.id}/rename`, { name: 'Взломано' }],
        [`/api/tasks/lists/${list.id}/clear-done`, {}],
        [`/api/tasks/lists/${list.id}/delete`, {}],
        ['/api/tasks/many', { listId: list.id, titles: ['чужое'] }],
      ] as const) {
        const res = await post(t, other, url, body);
        expect(res.statusCode, url).toBe(404);
      }
      // adding something to somebody else’s private list is refused
      expect((await post(t, other, '/api/tasks', { title: 'Чужое', listId: list.id })).statusCode).toBe(400);
    }
    expect(await titlesOf(t, mama)).toEqual(['Подарок папе', 'Билеты', 'Общее дело']);
    expect((await tasksOf(t, mama)).tasks.find((x) => x.id === secret.id)?.title).toBe('Подарок папе');
  });

  it('does not let a private task be given to somebody else', async () => {
    const { t, mama } = await setup();
    const res = await post(t, mama, '/api/tasks', { title: 'Личное', private: true, assignee: 'son' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiError>().error).toBe('private_assignee');
  });
});

describe('family tasks: who may change what', () => {
  it('lets everybody tick a shared task; changing and deleting is for the author and administrators', async () => {
    const { t, mama, son, admin } = await setup();
    const made = (await post(t, mama, '/api/tasks', { title: 'Вынести мусор' })).json<TaskView>();

    const ticked = await post(t, son, `/api/tasks/${made.id}/done`, { done: true });
    expect(ticked.statusCode).toBe(200);
    expect(ticked.json<TaskView>()).toMatchObject({ done: true, doneBy: 'son', doneByName: 'Сын', canEdit: false });
    expect(ticked.json<TaskView>().doneAt).toBe(t.clock().toISOString());
    const unticked = await post(t, admin, `/api/tasks/${made.id}/done`, { done: false });
    expect(unticked.json<TaskView>()).toMatchObject({ done: false, doneBy: null, doneAt: null });

    expect((await post(t, son, `/api/tasks/${made.id}/update`, { title: 'Чужое' })).statusCode).toBe(403);
    expect((await post(t, son, `/api/tasks/${made.id}/delete`)).statusCode).toBe(403);
    const edited = await post(t, admin, `/api/tasks/${made.id}/update`, { title: 'Вынести мусор до восьми' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<TaskView>()).toMatchObject({ title: 'Вынести мусор до восьми', owner: 'mama', canEdit: true });
    expect((await post(t, admin, `/api/tasks/${made.id}/delete`)).statusCode).toBe(204);
    expect(await titlesOf(t, mama)).toEqual([]);
    expect((await post(t, mama, `/api/tasks/${made.id}/delete`)).statusCode).toBe(404);
  });

  it('lets the person a task is given to change its done state only', async () => {
    const { t, mama, son } = await setup();
    const made = (await post(t, mama, '/api/tasks', { title: 'Забрать посылку', assignee: 'son' })).json<TaskView>();
    expect((await post(t, son, `/api/tasks/${made.id}/update`, { title: 'Забрать позже', assignee: 'son' })).statusCode).toBe(403);
    expect((await post(t, son, `/api/tasks/${made.id}/done`, { done: true })).statusCode).toBe(200);
  });

  it('moves a repeating task to its next date and tells when it was done', async () => {
    const { t, mama, son } = await setup(); // 16 October 2026
    const made = (
      await post(t, mama, '/api/tasks', { title: 'Оплатить счета', due: '2026-10-31', repeat: 'monthly' })
    ).json<TaskView>();
    const first = (await post(t, son, `/api/tasks/${made.id}/done`, { done: true, occurrence: '2026-10-31' })).json<TaskView>();
    expect(first).toMatchObject({ done: false, due: '2026-11-30', lastDoneByName: 'Сын', canUndo: true });
    expect(first.lastDoneAt).toBe(t.clock().toISOString());
    // a second person who still saw the old date does not skip another month
    const slow = (await post(t, mama, `/api/tasks/${made.id}/done`, { done: true, occurrence: '2026-10-31' })).json<TaskView>();
    expect(slow.due).toBe('2026-11-30');
    const back = (await post(t, mama, `/api/tasks/${made.id}/done`, { done: false })).json<TaskView>();
    expect(back).toMatchObject({ due: '2026-10-31', canUndo: false, lastDoneAt: null });
  });
});

describe('family tasks: lists', () => {
  it('makes a shopping list, adds many items at once, ticks them off and clears the bought ones', async () => {
    const { t, mama, son, admin } = await setup();
    const shop = (
      await post(t, mama, '/api/tasks/lists', { name: ' Покупки ', kind: 'shopping' })
    ).json<TaskListView>();
    expect(shop).toMatchObject({ name: 'Покупки', kind: 'shopping', private: false, canEdit: true });

    const many = await post(t, son, '/api/tasks/many', { listId: shop.id, titles: ['молоко', '', ' хлеб ', 'яйца'] });
    expect(many.statusCode, many.body).toBe(201);
    const items = many.json<CreateManyTasksResponse>().tasks;
    expect(items.map((x) => [x.title, x.listId, x.owner])).toEqual([
      ['молоко', shop.id, 'son'],
      ['хлеб', shop.id, 'son'],
      ['яйца', shop.id, 'son'],
    ]);
    expect((await tasksOf(t, admin)).lists.map((x) => x.name)).toEqual(['Покупки']);

    for (const item of items.slice(0, 2)) await post(t, mama, `/api/tasks/${item.id}/done`, { done: true });
    // the author of the list clears everything bought, also what her son added
    const cleared = await post(t, mama, `/api/tasks/lists/${shop.id}/clear-done`);
    expect(cleared.json<ClearDoneResponse>()).toEqual({ removed: 2, kept: 0 });
    expect(await titlesOf(t, son)).toEqual(['яйца']);

    expect((await post(t, son, `/api/tasks/lists/${shop.id}/rename`, { name: 'Магазин' })).statusCode).toBe(403);
    const renamed = await post(t, admin, `/api/tasks/lists/${shop.id}/rename`, { name: 'Магазин' });
    expect(renamed.json<TaskListView>().name).toBe('Магазин');
    expect((await post(t, son, `/api/tasks/lists/${shop.id}/delete`)).statusCode).toBe(403);
    const removed = await post(t, mama, `/api/tasks/lists/${shop.id}/delete`);
    expect(removed.json<DeleteTaskListResponse>()).toEqual({ removedTasks: 1 });
    expect(await titlesOf(t, mama)).toEqual([]);
    expect((await tasksOf(t, mama)).lists).toEqual([]);
  });

  it('clears the ticked tasks that are in no list', async () => {
    const { t, mama } = await setup();
    const one = (await post(t, mama, '/api/tasks', { title: 'раз' })).json<TaskView>();
    await post(t, mama, '/api/tasks', { title: 'два' });
    await post(t, mama, `/api/tasks/${one.id}/done`, { done: true });
    expect((await post(t, mama, '/api/tasks/clear-done')).json<ClearDoneResponse>()).toEqual({ removed: 1, kept: 0 });
    expect(await titlesOf(t, mama)).toEqual(['два']);
  });

  it('refuses nonsense and duplicates with plain words', async () => {
    const { t, mama, son } = await setup();
    const empty = await post(t, mama, '/api/tasks/lists', { name: '   ' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<ApiError>().message).toContain('название');
    const shop = (await post(t, mama, '/api/tasks/lists', { name: 'Покупки', kind: 'shopping' })).json<TaskListView>();
    const twice = await post(t, son, '/api/tasks/lists', { name: 'покупки' });
    expect(twice.statusCode).toBe(409);
    expect(twice.json<ApiError>().message).toContain('уже есть');

    expect((await post(t, mama, '/api/tasks/many', { listId: shop.id, titles: [' ', ''] })).statusCode).toBe(400);
    const tooMany = await post(t, mama, '/api/tasks/many', {
      listId: shop.id,
      titles: Array.from({ length: 51 }, (_, i) => `п ${i}`),
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json<ApiError>().message).toContain('50');
    expect((await post(t, mama, '/api/tasks/many', { listId: '00000000-0000-4000-8000-000000000009', titles: ['x'] })).statusCode).toBe(404);
    expect((await post(t, mama, '/api/tasks/lists/not-an-id/rename', { name: 'x' })).statusCode).toBe(404);
    expect(await titlesOf(t, mama)).toEqual([]);
  });

  it('keeps a private shopping list to its author', async () => {
    const { t, mama, admin } = await setup();
    const list = (
      await post(t, mama, '/api/tasks/lists', { name: 'Сюрприз', kind: 'shopping', private: true })
    ).json<TaskListView>();
    await post(t, mama, '/api/tasks/many', { listId: list.id, titles: ['торт', 'свечи'] });
    expect(await titlesOf(t, mama)).toEqual(['торт', 'свечи']);
    expect(await tasksOf(t, admin)).toMatchObject({ tasks: [], lists: [] });
  });
});

describe('family tasks: reminders', () => {
  const remind = (payload: object = {}) => ({
    title: 'Забрать из школы',
    due: '2026-10-16',
    dueTime: '18:00',
    remindBefore: 30,
    ...payload,
  });
  const feed = async (t: TestApp, cookie: string) =>
    (await get(t, cookie, '/api/notifications')).json<NotificationsResponse>();

  it('tells the person the task is for, once, and the author when nobody is named', async () => {
    const { t, mama, son, admin } = await setup(); // 17:00
    await post(t, mama, '/api/tasks', remind({ assignee: 'son' }));
    await post(t, mama, '/api/tasks', remind({ title: 'Свой звонок', remindBefore: 0 }));
    expect(await t.app.dashboard.taskReminders.tick()).toBe(0); // 17:00: not yet

    t.clock.advance(31 * 60_000); // 17:31: the first one is due
    expect(await t.app.dashboard.taskReminders.tick()).toBe(1);
    const sonFeed = await feed(t, son);
    expect(sonFeed.unread).toBe(1);
    expect(sonFeed.notifications[0]).toMatchObject({
      kind: 'reminder',
      title: 'Напоминание о деле',
      url: '/tasks',
      read: false,
    });
    expect(sonFeed.notifications[0]?.body).toBe('«Забрать из школы» — сегодня в 18:00 (поручил(а): Мама)');
    expect((await feed(t, mama)).unread).toBe(0); // given to the son: the author is not told
    expect((await feed(t, admin)).unread).toBe(0);
    expect(await t.app.dashboard.taskReminders.tick()).toBe(0); // the next minute: once only

    t.clock.advance(29 * 60_000); // 18:00: the second one (0 minutes before)
    expect(await t.app.dashboard.taskReminders.tick()).toBe(1);
    expect((await feed(t, mama)).notifications[0]?.body).toBe('«Свой звонок» — сегодня в 18:00');
    expect((await feed(t, son)).unread).toBe(1);
  });

  it('does not tell it again after a restart', async () => {
    const { t, mama } = await setup();
    await post(t, mama, '/api/tasks', remind({ assignee: 'son' }));
    t.clock.advance(31 * 60_000);
    expect(await t.app.dashboard.taskReminders.tick()).toBe(1);
    await t.app.dashboard.notify.idle();

    await t.app.close();
    const again = await createTestApp({ dataDir: t.dataDir, clock: t.clock });
    cleanup.push(() => again.app.close());
    expect(await again.app.dashboard.taskReminders.tick()).toBe(0);
    const cookie = await cookieFor(again.app, SON);
    expect((await feed(again, cookie)).unread).toBe(1);
  });

  it('keeps a private task’s reminder to its author', async () => {
    const { t, mama, son, admin } = await setup();
    await post(t, mama, '/api/tasks', remind({ title: 'Подарок', private: true }));
    t.clock.advance(31 * 60_000);
    expect(await t.app.dashboard.taskReminders.tick()).toBe(1);
    expect((await feed(t, mama)).notifications[0]?.body).toContain('Подарок');
    expect((await feed(t, son)).unread).toBe(0);
    expect((await feed(t, admin)).unread).toBe(0);
  });

  it('respects the preference «Напоминания о делах»', async () => {
    const { t, mama, son } = await setup();
    expect((await feed(t, son)).prefs.reminders).toBe(true); // on until the person decides otherwise
    const off = await post(t, son, '/api/notifications/prefs', { reminders: false });
    expect(off.json<{ reminders: boolean }>().reminders).toBe(false);
    await post(t, mama, '/api/tasks', remind({ assignee: 'son' }));
    t.clock.advance(31 * 60_000);
    await t.app.dashboard.taskReminders.tick();
    expect((await feed(t, son)).unread).toBe(0);
    expect((await feed(t, son)).prefs).toMatchObject({ reminders: false, messages: true });
  });

  it('keeps old stored preferences valid and counts reminders as switched on in them', async () => {
    const dataDir = await makeTempDir();
    cleanup.push(() => removeDir(dataDir));
    const clock = clockAt(2026, 10, 16, 17, 0);
    const mamaUser = await addUser(dataDir, clock, FAMILY);
    await addUser(dataDir, clock, ADMIN);
    // a notifications.json written before the preference «reminders» existed
    await writeFile(
      path.join(dataDir, 'notifications.json'),
      JSON.stringify({
        version: 1,
        prefs: {
          [mamaUser.id]: { messages: false, calls: true, downloads: true, alerts: false, print: true, previews: true },
        },
        feed: {},
        subs: {},
      }),
    );
    const t = await createTestApp({ dataDir, clock });
    cleanup.push(() => t.app.close());
    const mama = await cookieFor(t.app, FAMILY);
    expect((await feed(t, mama)).prefs).toEqual({
      reminders: true,
      messages: false,
      calls: true,
      downloads: true,
      alerts: false,
      print: true,
      previews: true,
    });
    await post(t, mama, '/api/tasks', remind({ remindBefore: 0 }));
    t.clock.advance(61 * 60_000);
    expect(await t.app.dashboard.taskReminders.tick()).toBe(1);
    expect((await feed(t, mama)).unread).toBe(1);
  });

  it('does not tell a person whose account is off, but falls back to the author', async () => {
    const { t, mama, ids } = await setup();
    await post(t, mama, '/api/tasks', remind({ assignee: 'son' }));
    await t.app.dashboard.users.update(ids.son ?? '', { disabled: true });
    t.clock.advance(31 * 60_000);
    expect(await t.app.dashboard.taskReminders.tick()).toBe(1);
    expect((await feed(t, mama)).unread).toBe(1);
  });

  it('survives a damaged file without a crash, and says so to the people who open the page', async () => {
    const { t, mama } = await setup();
    await writeFile(path.join(t.dataDir, 'tasks.json'), '{ not json');
    expect(await t.app.dashboard.taskReminders.tick()).toBe(0);
    const res = await get(t, mama, '/api/tasks');
    expect(res.statusCode).toBe(503);
    expect(res.json<ApiError>().message).toContain('Файл с делами');
    expect((await post(t, mama, '/api/tasks', { title: 'x' })).statusCode).toBe(503);
    expect(await readFile(path.join(t.dataDir, 'tasks.json'), 'utf8')).toBe('{ not json');
  });
});

describe('family tasks: a removed account', () => {
  it('takes the private tasks along and leaves the shared ones to the family', async () => {
    const { t, mama, son, admin } = await setup();
    await post(t, mama, '/api/tasks', { title: 'Личное', private: true });
    await post(t, mama, '/api/tasks', { title: 'Общее' });
    await post(t, mama, '/api/tasks/lists', { name: 'Мой список', private: true });
    const removed = await post(t, admin, '/api/admin/users/mama/remove', { confirm: true });
    expect(removed.statusCode, removed.body).toBe(204);
    const left = await tasksOf(t, son);
    expect(left.tasks.map((x) => [x.title, x.owner])).toEqual([['Общее', REMOVED_OWNER]]);
    expect(left.lists).toEqual([]);
    // a new person with the same login inherits nothing
    await addUser(t.dataDir, t.clock, FAMILY);
    const newMama = await cookieFor(t.app, FAMILY);
    expect((await tasksOf(t, newMama)).tasks.map((x) => [x.title, x.canEdit])).toEqual([['Общее', false]]);
  });
});
