import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '../../shared/api.ts';
import { REMOVED_OWNER } from '../src/planner/calendar.ts';
import {
  ALL_DAY_REMINDER_TIME,
  daysInMonth,
  LATE_GRACE_MS,
  localInstant,
  localMoment,
  nextOccurrence,
  occurrence,
  reminderWindow,
} from '../src/planner/task-dates.ts';
import { dueWords } from '../src/planner/task-reminders.ts';
import {
  checkListInput,
  checkManyTitles,
  checkTaskInput,
  createTasksStore,
  MAX_LISTS_PER_USER,
  MAX_MANY,
  MAX_TASKS,
  MAX_TASKS_PER_USER,
  searchTasks,
  TaskError,
  type TaskStore,
  type Writer,
} from '../src/planner/tasks.ts';
import { createFakeClock, type FakeClock, makeTempDir, removeDir } from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A clock set to a wall-clock moment of THIS computer, so the tests do not depend on its time zone. */
function clockAt(y: number, m: number, d: number, hh = 10, mm = 0): FakeClock {
  return createFakeClock(new Date(y, m - 1, d, hh, mm).toISOString());
}

const MAMA: Writer = { username: 'mama', displayName: 'Мама', isAdmin: false };
const SON: Writer = { username: 'son', displayName: 'Сын', isAdmin: false };
const PAPA: Writer = { username: 'papa', displayName: 'Папа', isAdmin: true };

const task = (over: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Купить хлеб',
  note: '',
  due: null,
  dueTime: null,
  repeat: 'none',
  assignee: null,
  remindBefore: null,
  private: false,
  listId: null,
  ...over,
});

async function setup(clock: FakeClock = clockAt(2026, 10, 16)) {
  const dir = await makeTempDir('fd-tasks-');
  cleanup.push(() => removeDir(dir));
  const store = createTasksStore(dir, { clock });
  return { dir, store, clock, file: path.join(dir, 'tasks.json') };
}

const titles = async (store: TaskStore, who: Writer) => (await store.list(who)).tasks.map((t) => t.title);

describe('dates of repeating tasks', () => {
  it('knows month lengths, including leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('keeps the day of the month: the 31st survives short months', () => {
    expect(occurrence('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(occurrence('2026-01-31', 'monthly', 2)).toBe('2026-03-31');
    expect(occurrence('2026-01-31', 'monthly', 3)).toBe('2026-04-30');
    expect(occurrence('2028-01-31', 'monthly', 1)).toBe('2028-02-29');
    expect(occurrence('2026-11-30', 'monthly', 3)).toBe('2027-02-28');
    expect(occurrence('2026-12-15', 'monthly', 1)).toBe('2027-01-15');
  });

  it('moves 29 February to 28 February in years that have no 29th, and back again', () => {
    expect(occurrence('2028-02-29', 'yearly', 1)).toBe('2029-02-28');
    expect(occurrence('2028-02-29', 'yearly', 4)).toBe('2032-02-29');
  });

  it('finds the next occurrence strictly after a day', () => {
    // daily and weekly
    expect(nextOccurrence('2026-10-16', 'daily', '2026-10-16')).toBe('2026-10-17');
    expect(nextOccurrence('2026-10-16', 'daily', '2026-12-31')).toBe('2027-01-01');
    expect(nextOccurrence('2026-10-16', 'weekly', '2026-10-16')).toBe('2026-10-23');
    expect(nextOccurrence('2026-10-16', 'weekly', '2026-10-30')).toBe('2026-11-06');
    expect(nextOccurrence('2026-10-16', 'weekly', '2026-10-25')).toBe('2026-10-30');
    // monthly at the end of months, going on from where the previous one ended
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-02-28')).toBe('2026-03-31');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-03-31')).toBe('2026-04-30');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-04-30')).toBe('2026-05-31');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-12-31')).toBe('2027-01-31');
    expect(nextOccurrence('2026-01-31', 'monthly', '2027-02-10')).toBe('2027-02-28');
    // yearly
    expect(nextOccurrence('2028-02-29', 'yearly', '2028-02-29')).toBe('2029-02-28');
    expect(nextOccurrence('2028-02-29', 'yearly', '2029-02-28')).toBe('2030-02-28');
    expect(nextOccurrence('2026-05-09', 'yearly', '2026-05-08')).toBe('2026-05-09');
    expect(nextOccurrence('2026-05-09', 'yearly', '2026-05-09')).toBe('2027-05-09');
    // before the first date the first date itself is the next one
    expect(nextOccurrence('2026-10-16', 'monthly', '2026-01-01')).toBe('2026-10-16');
  });

  it('ends a task whose next time would lie beyond the years the portal accepts', () => {
    expect(nextOccurrence('2200-12-31', 'yearly', '2200-12-31')).toBeNull();
    expect(nextOccurrence('2200-12-31', 'daily', '2200-12-31')).toBeNull();
  });

  it('works out when the reminder is due', () => {
    expect(reminderWindow({ due: null, dueTime: null, remindBefore: 10 })).toBeNull();
    expect(reminderWindow({ due: '2026-10-16', dueTime: '18:00', remindBefore: null })).toBeNull();
    const timed = reminderWindow({ due: '2026-10-16', dueTime: '18:00', remindBefore: 30 });
    expect(timed?.key).toBe('2026-10-16T18:00');
    expect(timed?.fireAt).toEqual(localInstant('2026-10-16', '17:30'));
    expect(timed?.until.getTime()).toBe(localInstant('2026-10-16', '18:00').getTime() + LATE_GRACE_MS);
    const allDay = reminderWindow({ due: '2026-10-16', dueTime: null, remindBefore: 60 });
    expect(allDay?.key).toBe('2026-10-16');
    expect(allDay?.fireAt).toEqual(localInstant('2026-10-16', '08:00')); // 09:00 minus an hour
    expect(ALL_DAY_REMINDER_TIME).toBe('09:00');
    expect(allDay?.until.getTime()).toBeGreaterThan(localInstant('2026-10-16', '23:59').getTime());
  });

  it('reads the wall clock of the house', () => {
    expect(localMoment(new Date(2026, 9, 16, 7, 5))).toEqual({ day: '2026-10-16', time: '07:05' });
  });

  it('says when something is due in plain words', () => {
    const now = new Date(2026, 9, 16, 10, 0);
    expect(dueWords({ due: '2026-10-16', dueTime: '18:30' }, now)).toBe('сегодня в 18:30');
    expect(dueWords({ due: '2026-10-17', dueTime: null }, now)).toBe('завтра');
    expect(dueWords({ due: '2026-10-20', dueTime: '09:00' }, now)).toBe('20 октября в 09:00');
  });
});

describe('what a request may say', () => {
  const raw = (over: Partial<TaskInput> = {}): TaskInput => task(over);

  it('cleans the title and explains problems in plain words', () => {
    expect(checkTaskInput(raw({ title: '  Купить \n  хлеб  ' })).title).toBe('Купить хлеб');
    const bad = (over: Partial<TaskInput>) => {
      try {
        checkTaskInput(raw(over));
      } catch (error) {
        expect(error).toBeInstanceOf(TaskError);
        expect((error as TaskError).status).toBe(400);
        return (error as TaskError).message;
      }
      throw new Error('accepted');
    };
    expect(bad({ title: '   ' })).toContain('Напишите');
    expect(bad({ title: 'я'.repeat(121) })).toContain('120');
    expect(bad({ note: 'я'.repeat(1001) })).toContain('1000');
    expect(bad({ due: '2026-02-30' })).toContain('настоящую дату');
    expect(bad({ dueTime: '18:30' })).toContain('вместе с датой');
    expect(bad({ due: '2026-10-16', dueTime: '25:00' })).toContain('18:30');
    expect(bad({ repeat: 'weekly' })).toContain('укажите дату');
    expect(bad({ remindBefore: 10 })).toContain('укажите дату');
    expect(bad({ due: '2026-10-16', remindBefore: -5 })).toContain('за неделю');
    expect(bad({ due: '2026-10-16', remindBefore: 8 * 24 * 60 })).toContain('за неделю');
    expect(bad({ due: '2026-10-16', remindBefore: 1.5 })).toContain('за неделю');
  });

  it('turns empty strings into «nothing» and normalises the login of the assignee', () => {
    const clean = checkTaskInput(raw({ due: '', dueTime: '', assignee: ' Son ', listId: '' }));
    expect(clean).toMatchObject({ due: null, dueTime: null, assignee: 'son', listId: null });
  });

  it('checks lists and the items added in one go', () => {
    expect(checkListInput({ name: '  Покупки ', kind: 'shopping', private: false }).name).toBe('Покупки');
    expect(() => checkListInput({ name: ' ', kind: 'todo', private: false })).toThrow(/название/);
    expect(() => checkListInput({ name: 'я'.repeat(61), kind: 'todo', private: false })).toThrow(/60/);
    expect(checkManyTitles(['молоко', '  ', 'хлеб\t'])).toEqual(['молоко', 'хлеб']);
    expect(() => checkManyTitles(['', ' '])).toThrow(/Напишите/);
    expect(() => checkManyTitles(Array.from({ length: MAX_MANY + 1 }, (_, i) => `п${i}`))).toThrow(
      /не больше/,
    );
    expect(() => checkManyTitles(['я'.repeat(121)])).toThrow(/длиннее/);
  });
});

describe('privacy: a private task or list is the author’s alone', () => {
  it('hides it from everybody else, an administrator included, and calls it «not found»', async () => {
    const { store } = await setup();
    const secret = await store.create(MAMA, task({ title: 'Подарок папе', private: true }), null);
    await store.create(MAMA, task({ title: 'Купить хлеб' }), null);
    const secretList = await store.createList(MAMA, { name: 'Тайный список', kind: 'todo', private: true });
    const inList = await store.create(MAMA, task({ title: 'Билеты', listId: secretList.id }), null);
    expect(inList.private).toBe(true); // a task of a private list is private

    expect(await titles(store, MAMA)).toEqual(['Подарок папе', 'Купить хлеб', 'Билеты']);
    expect(await titles(store, SON)).toEqual(['Купить хлеб']);
    expect(await titles(store, PAPA)).toEqual(['Купить хлеб']);
    expect((await store.list(PAPA)).lists).toEqual([]);
    expect((await store.list(MAMA)).lists.map((l) => l.name)).toEqual(['Тайный список']);

    for (const other of [SON, PAPA]) {
      const rejected = async (run: Promise<unknown>) =>
        run.then(
          () => 'allowed',
          (error: TaskError) => `${error.status}`,
        );
      expect(await rejected(store.update(other, secret.id, task({ title: 'x' }), null))).toBe('404');
      expect(await rejected(store.setDone(other, secret.id, true))).toBe('404');
      expect(await rejected(store.remove(other, secret.id))).toBe('404');
      expect(await rejected(store.renameList(other, secretList.id, 'Мой'))).toBe('404');
      expect(await rejected(store.removeList(other, secretList.id))).toBe('404');
      expect(await rejected(store.clearDone(other, secretList.id))).toBe('404');
      expect(await rejected(store.createMany(other, secretList.id, ['x']))).toBe('404');
      // putting something into somebody else’s private list is refused as well
      expect(await rejected(store.create(other, task({ listId: secretList.id }), null))).toBe('400');
    }
    expect(await store.searchTasks(PAPA, 'подарок')).toEqual([]);
    expect(await store.searchTasks(SON, 'билеты')).toEqual([]);
    expect((await store.searchTasks(MAMA, 'подарок')).map((hit) => hit.title)).toEqual(['Подарок папе']);
    expect(await titles(store, MAMA)).toHaveLength(3); // nothing was changed by the attempts
  });

  it('lets only the author decide whether a task is private', async () => {
    const { store } = await setup();
    const shared = await store.create(MAMA, task({ title: 'Общее' }), null);
    // An administrator changing a shared task cannot make it private: the author decides that.
    const changed = await store.update(
      PAPA,
      shared.id,
      task({ title: 'Общее (правка)', private: true }),
      null,
    );
    expect(changed).toMatchObject({ title: 'Общее (правка)', private: false, owner: 'mama', canEdit: true });
    // The author can.
    expect((await store.update(MAMA, shared.id, task({ title: 'Общее', private: true }), null)).private).toBe(
      true,
    );
    expect(await titles(store, PAPA)).toEqual([]);
  });

  it('keeps private tasks out of the search for the portal, whoever asks', async () => {
    const { store } = await setup();
    await store.create(MAMA, task({ title: 'Дача: купить семена', private: true }), null);
    await store.create(SON, task({ title: 'Дача: починить забор', note: 'взять гвозди' }), null);
    expect((await searchTasks(store, PAPA, 'дача')).map((h) => h.title)).toEqual(['Дача: починить забор']);
    expect((await searchTasks(store, MAMA, 'дача')).map((h) => h.title).sort()).toEqual([
      'Дача: купить семена',
      'Дача: починить забор',
    ]);
    expect((await searchTasks(store, MAMA, 'гвозди')).map((h) => h.title)).toEqual(['Дача: починить забор']);
  });
});

describe('who may change what', () => {
  it('lets everybody tick a shared task; the author and administrators change and delete it', async () => {
    const { store } = await setup();
    const t = await store.create(MAMA, task({ title: 'Вынести мусор' }), null);

    const ticked = await store.setDone(SON, t.id, true);
    expect(ticked).toMatchObject({ done: true, doneBy: 'son', doneByName: 'Сын', canEdit: false });
    expect(ticked.doneAt).toBe(new Date(2026, 9, 16, 10, 0).toISOString());
    const unticked = await store.setDone(PAPA, t.id, false);
    expect(unticked).toMatchObject({
      done: false,
      doneAt: null,
      doneBy: null,
      doneByName: null,
      canEdit: true,
    });

    const forbidden = (run: Promise<unknown>) =>
      run.then(
        () => 'allowed',
        (error: TaskError) => `${error.status}:${error.code}`,
      );
    expect(await forbidden(store.update(SON, t.id, task({ title: 'Чужое' }), null))).toBe('403:forbidden');
    expect(await forbidden(store.remove(SON, t.id))).toBe('403:forbidden');
    expect(await titles(store, MAMA)).toEqual(['Вынести мусор']);

    expect((await store.update(PAPA, t.id, task({ title: 'Вынести мусор до 20:00' }), null)).title).toBe(
      'Вынести мусор до 20:00',
    );
    await store.remove(PAPA, t.id);
    expect(await titles(store, MAMA)).toEqual([]);
    expect(await forbidden(store.remove(MAMA, t.id))).toBe('404:not_found');
  });

  it('gives a shared task to a person, who may only tick it', async () => {
    const { store } = await setup();
    const t = await store.create(MAMA, task({ title: 'Забрать посылку', assignee: 'son' }), 'Сын');
    expect(t).toMatchObject({ assignee: 'son', assigneeName: 'Сын' });
    expect((await store.setDone(SON, t.id, true)).done).toBe(true);
    await expect(
      store.update(SON, t.id, task({ title: 'Забрать посылку позже' }), 'Сын'),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(store.remove(SON, t.id)).rejects.toMatchObject({ status: 403 });
    // the author takes the task back
    expect((await store.update(MAMA, t.id, task({ title: t.title }), null)).assignee).toBeNull();
  });

  it('never gives a private task or a task of a private list to somebody else', async () => {
    const { store } = await setup();
    await expect(store.create(MAMA, task({ private: true, assignee: 'son' }), 'Сын')).rejects.toMatchObject({
      status: 400,
      code: 'private_assignee',
    });
    const secret = await store.createList(MAMA, { name: 'Тайна', kind: 'todo', private: true });
    await expect(
      store.create(MAMA, task({ listId: secret.id, assignee: 'son' }), 'Сын'),
    ).rejects.toMatchObject({
      code: 'private_assignee',
    });
    const t = await store.create(MAMA, task({ assignee: 'son' }), 'Сын');
    await expect(
      store.update(MAMA, t.id, task({ private: true, assignee: 'son' }), 'Сын'),
    ).rejects.toMatchObject({
      code: 'private_assignee',
    });
  });
});

describe('repeating tasks', () => {
  it('stay open with the next date and remember who did them and when', async () => {
    const { store, clock } = await setup(clockAt(2026, 1, 31, 9, 0));
    const t = await store.create(
      MAMA,
      task({ title: 'Оплатить счета', due: '2026-01-31', repeat: 'monthly' }),
      null,
    );
    const first = await store.setDone(SON, t.id, true, '2026-01-31');
    expect(first).toMatchObject({
      done: false,
      due: '2026-02-28',
      lastDoneByName: 'Сын',
      canUndo: true,
      repeat: 'monthly',
    });
    expect(first.lastDoneAt).toBe(clock().toISOString());

    clock.advance(28 * 24 * 3600 * 1000); // 28 February
    const second = await store.setDone(MAMA, t.id, true, '2026-02-28');
    expect(second).toMatchObject({ due: '2026-03-31', lastDoneByName: 'Мама' });
    clock.advance(31 * 24 * 3600 * 1000); // 31 March
    expect((await store.setDone(MAMA, t.id, true)).due).toBe('2026-04-30');
  });

  it('do not happen twice when two people tick the same occurrence', async () => {
    const { store } = await setup(clockAt(2026, 10, 16));
    const t = await store.create(
      MAMA,
      task({ title: 'Полить цветы', due: '2026-10-16', repeat: 'weekly' }),
      null,
    );
    expect((await store.setDone(MAMA, t.id, true, '2026-10-16')).due).toBe('2026-10-23');
    // the second person still saw the old date on their screen
    expect((await store.setDone(SON, t.id, true, '2026-10-16')).due).toBe('2026-10-23');
  });

  it('can take the last tick back', async () => {
    const { store } = await setup(clockAt(2026, 10, 16));
    const t = await store.create(MAMA, task({ title: 'Зарядка', due: '2026-10-16', repeat: 'daily' }), null);
    const done = await store.setDone(MAMA, t.id, true);
    expect(done).toMatchObject({ due: '2026-10-17', canUndo: true });
    const back = await store.setDone(MAMA, t.id, false);
    expect(back).toMatchObject({ due: '2026-10-16', canUndo: false, lastDoneAt: null, lastDoneByName: null });
    // nothing to take back any more
    expect((await store.setDone(MAMA, t.id, false)).due).toBe('2026-10-16');
  });

  it('continue from today when they were late, and from their own date when they were early', async () => {
    const { store } = await setup(clockAt(2026, 10, 16));
    const late = await store.create(
      MAMA,
      task({ title: 'Позавчера', due: '2026-10-14', repeat: 'daily' }),
      null,
    );
    expect((await store.setDone(MAMA, late.id, true)).due).toBe('2026-10-17');
    const early = await store.create(
      MAMA,
      task({ title: 'Через неделю', due: '2026-10-23', repeat: 'weekly' }),
      null,
    );
    expect((await store.setDone(MAMA, early.id, true)).due).toBe('2026-10-30');
    const lateMonthly = await store.create(
      MAMA,
      task({ title: 'Счета', due: '2026-07-31', repeat: 'monthly' }),
      null,
    );
    expect((await store.setDone(MAMA, lateMonthly.id, true)).due).toBe('2026-10-31');
  });

  it('end when there is no next time within the years the portal accepts', async () => {
    const { store } = await setup(clockAt(2200, 12, 31));
    const t = await store.create(
      MAMA,
      task({ title: 'Последнее', due: '2200-12-31', repeat: 'yearly' }),
      null,
    );
    expect(await store.setDone(MAMA, t.id, true)).toMatchObject({
      done: true,
      repeat: 'none',
      doneByName: 'Мама',
    });
  });

  it('are never «done» after an edit, and the day of the month is taken from the first date', async () => {
    const { store, clock } = await setup(clockAt(2026, 1, 31));
    const t = await store.create(MAMA, task({ title: 'Счета', due: '2026-01-31', repeat: 'monthly' }), null);
    await store.setDone(MAMA, t.id, true); // → 28 February
    clock.advance(28 * 24 * 3600 * 1000);
    // an edit that does not touch the schedule keeps the 31st as the anchor …
    await store.update(
      MAMA,
      t.id,
      task({ title: 'Счета за месяц', due: '2026-02-28', repeat: 'monthly' }),
      null,
    );
    expect((await store.setDone(MAMA, t.id, true)).due).toBe('2026-03-31');
    // … a new date starts a new series
    await store.update(MAMA, t.id, task({ title: 'Счета', due: '2026-03-15', repeat: 'monthly' }), null);
    clock.advance(31 * 24 * 3600 * 1000);
    expect((await store.setDone(MAMA, t.id, true)).due).toBe('2026-04-15');
  });

  it('are ordinary tasks again when the repeat is switched off', async () => {
    const { store } = await setup(clockAt(2026, 10, 16));
    const t = await store.create(
      MAMA,
      task({ title: 'Было повторяющимся', due: '2026-10-16', repeat: 'daily' }),
      null,
    );
    await store.update(MAMA, t.id, task({ title: t.title, due: '2026-10-16' }), null);
    expect(await store.setDone(MAMA, t.id, true)).toMatchObject({
      done: true,
      due: '2026-10-16',
      repeat: 'none',
    });
  });
});

describe('done state', () => {
  it('records who ticked an ordinary task and when, and clears it when unticked', async () => {
    const { store, clock } = await setup();
    const t = await store.create(MAMA, task({ title: 'Позвонить бабушке' }), null);
    clock.advance(5 * 60_000);
    const done = await store.setDone(SON, t.id, true);
    expect(done).toMatchObject({ done: true, doneBy: 'son', doneByName: 'Сын' });
    expect(done.doneAt).toBe(clock().toISOString());
    // ticking twice changes nothing — in particular not who and when
    clock.advance(60_000);
    expect(await store.setDone(MAMA, t.id, true)).toMatchObject({ doneBy: 'son', doneAt: done.doneAt });
    expect(await store.setDone(MAMA, t.id, false)).toMatchObject({ done: false, doneBy: null, doneAt: null });
  });
});

describe('lists', () => {
  it('makes shared and private lists of both kinds and puts tasks into them', async () => {
    const { store } = await setup();
    const shop = await store.createList(MAMA, { name: 'Покупки', kind: 'shopping', private: false });
    expect(shop).toMatchObject({
      name: 'Покупки',
      kind: 'shopping',
      private: false,
      owner: 'mama',
      canEdit: true,
    });
    const added = await store.createMany(SON, shop.id, ['молоко', 'хлеб', 'яйца']);
    expect(added.map((t) => [t.title, t.listId, t.owner, t.private])).toEqual([
      ['молоко', shop.id, 'son', false],
      ['хлеб', shop.id, 'son', false],
      ['яйца', shop.id, 'son', false],
    ]);
    const seen = await store.list(PAPA);
    expect(seen.lists).toMatchObject([{ id: shop.id, canEdit: true }]);
    expect((await store.list(SON)).lists[0]?.canEdit).toBe(false);
    // an unknown list
    await expect(store.create(MAMA, task({ listId: 'nope' }), null)).rejects.toMatchObject({ status: 400 });
    await expect(store.createMany(MAMA, 'nope', ['x'])).rejects.toMatchObject({ status: 404 });
  });

  it('clears the ticked items: everybody their own, the author of the list and administrators all of them', async () => {
    const { store } = await setup();
    const shop = await store.createList(MAMA, { name: 'Покупки', kind: 'shopping', private: false });
    const [milk, bread, eggs, tea] = [
      ...(await store.createMany(MAMA, shop.id, ['молоко'])),
      ...(await store.createMany(SON, shop.id, ['хлеб', 'яйца', 'чай'])),
    ];
    for (const item of [milk, bread, eggs]) await store.setDone(PAPA, item?.id ?? '', true);

    // the son clears: his bread and eggs go, mama’s milk stays; the tea is not bought
    expect(await store.clearDone(SON, shop.id)).toEqual({ removed: 2, kept: 1 });
    expect(await titles(store, SON)).toEqual(['молоко', 'чай']);
    // the author of the list clears what is left
    expect(await store.clearDone(MAMA, shop.id)).toEqual({ removed: 1, kept: 0 });
    expect(await titles(store, SON)).toEqual(['чай']);
    expect(tea?.title).toBe('чай');
    expect(await store.clearDone(MAMA, shop.id)).toEqual({ removed: 0, kept: 0 });

    // an administrator removes everybody’s
    const [a] = await store.createMany(SON, shop.id, ['сыр']);
    await store.setDone(MAMA, a?.id ?? '', true);
    expect(await store.clearDone(PAPA, shop.id)).toEqual({ removed: 1, kept: 0 });
    await expect(store.clearDone(MAMA, 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('clears the ticked tasks that are in no list', async () => {
    const { store } = await setup();
    const [one, two] = [
      await store.create(MAMA, task({ title: 'раз' }), null),
      await store.create(MAMA, task({ title: 'два' }), null),
    ];
    await store.create(MAMA, task({ title: 'три' }), null);
    await store.setDone(MAMA, one.id, true);
    await store.setDone(MAMA, two.id, true);
    const shop = await store.createList(MAMA, { name: 'Покупки', kind: 'shopping', private: false });
    const [milk] = await store.createMany(MAMA, shop.id, ['молоко']);
    await store.setDone(MAMA, milk?.id ?? '', true);
    expect(await store.clearDone(MAMA, null)).toEqual({ removed: 2, kept: 0 });
    expect(await titles(store, MAMA)).toEqual(['три', 'молоко']);
  });

  it('refuses a second list with the same name where the person sees both', async () => {
    const { store } = await setup();
    await store.createList(MAMA, { name: 'Покупки', kind: 'shopping', private: false });
    await expect(
      store.createList(SON, { name: 'покупки', kind: 'todo', private: false }),
    ).rejects.toMatchObject({ status: 409, code: 'name_taken' });
    // a private list may share a shared list’s name; two private lists of one person may not
    await store.createList(SON, { name: 'Покупки', kind: 'shopping', private: true });
    await expect(
      store.createList(SON, { name: 'покупки', kind: 'todo', private: true }),
    ).rejects.toMatchObject({ code: 'name_taken' });
    await store.createList(MAMA, { name: 'Покупки', kind: 'todo', private: true });
    const other = await store.createList(MAMA, { name: 'Ёлка', kind: 'todo', private: false });
    await expect(store.renameList(MAMA, other.id, 'елка')).resolves.toMatchObject({ name: 'елка' });
    const shared = (await store.list(MAMA)).lists.find((l) => l.name === 'Покупки' && !l.private);
    await expect(store.renameList(MAMA, shared?.id ?? '', 'Елка')).rejects.toMatchObject({
      code: 'name_taken',
    });
  });

  it('is renamed and deleted by its author or an administrator, deleting its items with it', async () => {
    const { store } = await setup();
    const shop = await store.createList(MAMA, { name: 'Покупки', kind: 'shopping', private: false });
    await store.createMany(MAMA, shop.id, ['молоко', 'хлеб']);
    await store.create(MAMA, task({ title: 'вне списка' }), null);
    await expect(store.renameList(SON, shop.id, 'Магазин')).rejects.toMatchObject({ status: 403 });
    await expect(store.removeList(SON, shop.id)).rejects.toMatchObject({ status: 403 });
    expect((await store.renameList(PAPA, shop.id, 'Магазин')).name).toBe('Магазин');
    expect(await store.removeList(MAMA, shop.id)).toEqual({ removedTasks: 2 });
    expect(await titles(store, MAMA)).toEqual(['вне списка']);
    await expect(store.removeList(MAMA, shop.id)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps a task private or shared with its list, however it is asked', async () => {
    const { store } = await setup();
    const shared = await store.createList(MAMA, { name: 'Общий', kind: 'todo', private: false });
    const t = await store.create(MAMA, task({ listId: shared.id, private: true }), null);
    expect(t.private).toBe(false);
    const mine = await store.createList(MAMA, { name: 'Мой', kind: 'todo', private: true });
    const moved = await store.update(MAMA, t.id, task({ title: t.title, listId: mine.id }), null);
    expect(moved.private).toBe(true);
    expect(await titles(store, SON)).toEqual([]);
  });
});

describe('limits', () => {
  it('stops one person from filling the file for everybody', async () => {
    const { store } = await setup();
    const shop = await store.createList(MAMA, { name: 'Покупки', kind: 'shopping', private: false });
    for (let batch = 0; batch < MAX_TASKS_PER_USER / MAX_MANY; batch += 1) {
      await store.createMany(
        MAMA,
        shop.id,
        Array.from({ length: MAX_MANY }, (_, i) => `товар ${batch}-${i}`),
      );
    }
    await expect(store.create(MAMA, task({ title: 'ещё одно' }), null)).rejects.toMatchObject({
      status: 409,
      code: 'too_many_own',
    });
    await expect(store.createMany(MAMA, shop.id, ['ещё'])).rejects.toMatchObject({ code: 'too_many_own' });
    // somebody else is not affected, and clearing makes room again
    await expect(store.create(SON, task({ title: 'сыну можно' }), null)).resolves.toMatchObject({
      owner: 'son',
    });
    const all = (await store.list(MAMA)).tasks;
    await store.setDone(MAMA, all[0]?.id ?? '', true);
    await store.clearDone(MAMA, shop.id);
    await expect(store.create(MAMA, task({ title: 'теперь можно' }), null)).resolves.toMatchObject({
      owner: 'mama',
    });
  });

  it('says how many more fit when a batch is too big', async () => {
    const { store } = await setup();
    const shop = await store.createList(MAMA, { name: 'Покупки', kind: 'shopping', private: false });
    for (let batch = 0; batch < 9; batch += 1) {
      await store.createMany(
        MAMA,
        shop.id,
        Array.from({ length: MAX_MANY }, (_, i) => `п ${batch}-${i}`),
      );
    }
    await store.createMany(
      MAMA,
      shop.id,
      Array.from({ length: 40 }, (_, i) => `ещё ${i}`),
    );
    await expect(
      store.createMany(
        MAMA,
        shop.id,
        Array.from({ length: 11 }, (_, i) => `лишнее ${i}`),
      ),
    ).rejects.toThrow(/ещё 10/);
    expect((await store.list(MAMA)).tasks).toHaveLength(490); // all or none
  });

  it('limits the lists of one person and the whole file', async () => {
    const { store, dir } = await setup();
    for (let i = 0; i < MAX_LISTS_PER_USER; i += 1) {
      await store.createList(MAMA, { name: `Список ${i}`, kind: 'todo', private: false });
    }
    await expect(
      store.createList(MAMA, { name: 'Лишний', kind: 'todo', private: false }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'too_many_own',
    });
    await expect(
      store.createList(SON, { name: 'Свой', kind: 'todo', private: false }),
    ).resolves.toMatchObject({
      owner: 'son',
    });

    // the whole file: 5000 tasks of ten different people
    const crowd = Array.from({ length: MAX_TASKS }, (_, i) => stored(i, `user${i % 10}`, `дело ${i}`));
    await writeFile(path.join(dir, 'tasks.json'), JSON.stringify({ version: 1, tasks: crowd, lists: [] }));
    await expect(store.create(SON, task({ title: 'последнее' }), null)).rejects.toMatchObject({
      status: 409,
      code: 'too_many',
    });
  });
});

/** A task as an older or hand-made file would hold it. */
function stored(index: number, owner: string, title: string) {
  return {
    id: `t${index}`,
    owner,
    ownerName: owner,
    assigneeName: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    title,
    note: '',
    due: null,
    dueTime: null,
    repeat: 'none',
    repeatFrom: null,
    assignee: null,
    remindBefore: null,
    remindedFor: null,
    private: false,
    listId: null,
    done: false,
    doneAt: null,
    doneBy: null,
    doneByName: null,
    lastDoneAt: null,
    lastDoneBy: null,
    lastDoneByName: null,
    undo: null,
  };
}

describe('the file', () => {
  it('is created on the first change and survives a restart', async () => {
    const { store, dir, clock } = await setup();
    await store.create(MAMA, task({ title: 'Переживёт перезапуск', due: '2026-10-20' }), null);
    const again = createTasksStore(dir, { clock });
    expect((await again.list(MAMA)).tasks).toMatchObject([
      { title: 'Переживёт перезапуск', due: '2026-10-20' },
    ]);
  });

  it('is refused with plain words when it is damaged, and never overwritten', async () => {
    const { store, file } = await setup();
    await writeFile(file, '{ not json');
    for (const run of [
      () => store.list(MAMA),
      () => store.create(MAMA, task(), null),
      () => store.createList(MAMA, { name: 'Список', kind: 'todo', private: false }),
      () => store.searchTasks(MAMA, 'хлеб'),
      () => store.dueReminders(new Date()),
      () => store.retireOwner('mama'),
    ]) {
      await expect(run()).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    }
    await expect(store.list(MAMA)).rejects.toThrow(/Файл с делами/);
    expect(await readFile(file, 'utf8')).toBe('{ not json');

    // valid JSON in a format the portal does not know is refused in the same way
    await writeFile(file, JSON.stringify({ version: 2, tasks: [] }));
    await expect(store.list(MAMA)).rejects.toMatchObject({ status: 503 });
    await writeFile(file, JSON.stringify({ version: 1, tasks: [{ id: 'x' }], lists: [] }));
    await expect(store.create(MAMA, task(), null)).rejects.toMatchObject({ status: 503 });
    expect(JSON.parse(await readFile(file, 'utf8')).tasks).toEqual([{ id: 'x' }]);
  });

  it('serialises writes: many at once all arrive', async () => {
    const { store } = await setup();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.create(MAMA, task({ title: `дело ${i}` }), null)),
    );
    expect((await store.list(MAMA)).tasks).toHaveLength(20);
  });
});

describe('search for the portal', () => {
  it('finds words in titles and notes whatever their ending, open tasks first, nearest date first', async () => {
    const { store } = await setup();
    const done = await store.create(MAMA, task({ title: 'Записаться к врачу', due: '2026-10-10' }), null);
    await store.setDone(MAMA, done.id, true);
    await store.create(MAMA, task({ title: 'Врач для сына', due: '2026-10-25' }), null);
    await store.create(MAMA, task({ title: 'Сходить к врачу', due: '2026-10-18' }), null);
    await store.create(MAMA, task({ title: 'Купить хлеб', note: 'и позвонить врачу' }), null);
    const hits = await store.searchTasks(MAMA, 'врача');
    expect(hits.map((h) => h.title)).toEqual([
      'Сходить к врачу',
      'Врач для сына',
      'Купить хлеб',
      'Записаться к врачу',
    ]);
    expect(hits.at(-1)?.done).toBe(true);
    expect(await store.searchTasks(MAMA, 'врача', 2)).toHaveLength(2);
    expect(await store.searchTasks(MAMA, '')).toEqual([]);
    expect(await store.searchTasks(MAMA, 'а')).toEqual([]);
    expect(await store.searchTasks(MAMA, 'несуществующее')).toEqual([]);
  });

  it('names the list a hit belongs to', async () => {
    const { store } = await setup();
    const shop = await store.createList(MAMA, { name: 'Покупки', kind: 'shopping', private: false });
    await store.createMany(MAMA, shop.id, ['молоко']);
    expect(await store.searchTasks(SON, 'молоко')).toMatchObject([{ title: 'молоко', listName: 'Покупки' }]);
  });
});

describe('reminders', () => {
  it('are due once per occurrence, also after a restart', async () => {
    const { store, dir, clock } = await setup(clockAt(2026, 10, 16, 17, 0));
    const t = await store.create(
      MAMA,
      task({ title: 'Забрать из школы', due: '2026-10-16', dueTime: '18:00', remindBefore: 30 }),
      null,
    );
    expect(await store.dueReminders(clock())).toEqual([]); // 17:00 — half an hour is not yet there
    clock.advance(31 * 60_000); // 17:31
    const jobs = await store.dueReminders(clock());
    expect(jobs).toMatchObject([
      { taskId: t.id, key: '2026-10-16T18:00', title: 'Забрать из школы', owner: 'mama', assignee: null },
    ]);
    expect(await store.dueReminders(clock())).toEqual([]); // the next minute: nothing new
    clock.advance(60_000);
    expect(await store.dueReminders(clock())).toEqual([]);

    const restarted = createTasksStore(dir, { clock });
    expect(await restarted.dueReminders(clock())).toEqual([]);
    expect(JSON.parse(await readFile(path.join(dir, 'tasks.json'), 'utf8')).tasks[0].remindedFor).toBe(
      '2026-10-16T18:00',
    );
  });

  it('are not told for done tasks, for tasks without a reminder, or when they are hopelessly late', async () => {
    const { store, clock } = await setup(clockAt(2026, 10, 16, 8, 0));
    const done = await store.create(
      MAMA,
      task({ title: 'Сделано', due: '2026-10-16', dueTime: '09:00', remindBefore: 0 }),
      null,
    );
    await store.setDone(MAMA, done.id, true);
    await store.create(MAMA, task({ title: 'Без напоминания', due: '2026-10-16', dueTime: '09:00' }), null);
    await store.create(MAMA, task({ title: 'Без срока', remindBefore: null }), null);
    await store.create(
      MAMA,
      task({ title: 'Вовремя', due: '2026-10-16', dueTime: '09:00', remindBefore: 0 }),
      null,
    );
    clock.advance(60 * 60_000); // 09:00
    // the one with «0 minutes» fires; the done one, the one without a reminder and without a date do not
    expect((await store.dueReminders(clock())).map((j) => j.title)).toEqual(['Вовремя']);

    const { store: lateStore, clock: lateClock } = await setup(clockAt(2026, 10, 16, 8, 0));
    await lateStore.create(
      MAMA,
      task({ title: 'Проспали', due: '2026-10-16', dueTime: '09:00', remindBefore: 0 }),
      null,
    );
    lateClock.advance(4 * 60 * 60_000); // 12:00 — more than the grace period after 09:00
    expect(await lateStore.dueReminders(lateClock())).toEqual([]);
    lateClock.advance(-150 * 60_000); // 09:30 — still within the grace period
    expect((await lateStore.dueReminders(lateClock())).map((j) => j.title)).toEqual(['Проспали']);
  });

  it('tell an all-day task at nine in the morning minus the reminder time, until the day is over', async () => {
    const { store, clock } = await setup(clockAt(2026, 10, 16, 7, 0));
    await store.create(MAMA, task({ title: 'День рождения', due: '2026-10-16', remindBefore: 60 }), null);
    expect(await store.dueReminders(clock())).toEqual([]);
    clock.advance(61 * 60_000); // 08:01
    expect((await store.dueReminders(clock())).map((j) => j.key)).toEqual(['2026-10-16']);
    clock.advance(5 * 3600_000);
    expect(await store.dueReminders(clock())).toEqual([]); // told already

    // a server that was off all day still tells it in the evening, but not on the next day
    const evening = await setup(clockAt(2026, 10, 16, 7, 0));
    await evening.store.create(
      MAMA,
      task({ title: 'Поздравить', due: '2026-10-16', remindBefore: 60 }),
      null,
    );
    evening.clock.advance(14 * 3600_000); // 21:00
    expect((await evening.store.dueReminders(evening.clock())).map((j) => j.title)).toEqual(['Поздравить']);
    const nextDay = await setup(clockAt(2026, 10, 16, 7, 0));
    await nextDay.store.create(
      MAMA,
      task({ title: 'Поздравить', due: '2026-10-16', remindBefore: 60 }),
      null,
    );
    nextDay.clock.advance(17 * 3600_000 + 30 * 60_000); // 00:30 the day after
    expect(await nextDay.store.dueReminders(nextDay.clock())).toEqual([]);
  });

  it('are told again for the next occurrence of a repeating task, and after a changed date or person', async () => {
    const { store, clock } = await setup(clockAt(2026, 10, 16, 9, 0));
    const t = await store.create(
      MAMA,
      task({ title: 'Таблетки', due: '2026-10-16', dueTime: '09:00', repeat: 'daily', remindBefore: 0 }),
      null,
    );
    expect((await store.dueReminders(clock())).map((j) => j.key)).toEqual(['2026-10-16T09:00']);
    await store.setDone(MAMA, t.id, true); // next: 17 October
    clock.advance(24 * 3600_000);
    expect((await store.dueReminders(clock())).map((j) => j.key)).toEqual(['2026-10-17T09:00']);
    expect(await store.dueReminders(clock())).toEqual([]);

    // a changed date is a new occurrence
    await store.update(
      MAMA,
      t.id,
      task({ title: 'Таблетки', due: '2026-10-17', dueTime: '09:15', repeat: 'daily', remindBefore: 0 }),
      null,
    );
    clock.advance(15 * 60_000);
    expect((await store.dueReminders(clock())).map((j) => j.key)).toEqual(['2026-10-17T09:15']);
    // another person gets the same occurrence again
    await store.update(
      MAMA,
      t.id,
      task({
        title: 'Таблетки',
        due: '2026-10-17',
        dueTime: '09:15',
        repeat: 'daily',
        remindBefore: 0,
        assignee: 'son',
      }),
      'Сын',
    );
    expect(await store.dueReminders(clock())).toMatchObject([{ assignee: 'son', key: '2026-10-17T09:15' }]);
  });
});

describe('a removed account', () => {
  it('takes its private tasks and lists along; shared ones stay but belong to nobody', async () => {
    const { store } = await setup();
    const secret = await store.createList(MAMA, { name: 'Тайна', kind: 'todo', private: true });
    await store.create(MAMA, task({ title: 'Личное', private: true }), null);
    await store.create(MAMA, task({ title: 'В тайном списке', listId: secret.id }), null);
    const shared = await store.create(MAMA, task({ title: 'Общее' }), null);
    await store.createList(MAMA, { name: 'Общий список', kind: 'todo', private: false });
    const given = await store.create(SON, task({ title: 'Сыну поручили', assignee: 'mama' }), 'Мама');
    expect(given.assignee).toBe('mama');

    expect(await store.retireOwner('mama')).toEqual({ deleted: 3, kept: 2 });
    expect(await store.retireOwner('mama')).toEqual({ deleted: 0, kept: 0 });
    const left = await store.list(PAPA);
    expect(left.tasks.map((t) => [t.title, t.owner, t.assignee])).toEqual([
      ['Общее', REMOVED_OWNER, null],
      ['Сыну поручили', 'son', null], // no longer given to a person who is gone
    ]);
    expect(left.lists.map((l) => [l.name, l.owner])).toEqual([['Общий список', REMOVED_OWNER]]);
    // somebody who gets the login «mama» later inherits nothing
    expect(await titles(store, MAMA)).toEqual(['Общее', 'Сыну поручили']);
    expect((await store.list(MAMA)).tasks.find((t) => t.id === shared.id)?.canEdit).toBe(false);
    expect((await store.list(PAPA)).tasks.find((t) => t.id === shared.id)?.canEdit).toBe(true);
  });
});
