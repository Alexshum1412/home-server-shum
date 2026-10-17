import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CalendarEventView,
  CalendarResponse,
  NoteResponse,
  NotesResponse,
  SaveNoteResponse,
} from '../../shared/api.ts';
import { eachDay, isRealDate, occursOn } from '../src/planner/dates.ts';
import { foldLine, toIcs } from '../src/planner/ics.ts';
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

const SON = { username: 'son', password: 'son-password-12', role: 'family' as const, displayName: 'Сын' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup() {
  const filesDir = await makeTempDir('fd-pfiles-');
  const photosDir = await makeTempDir('fd-pphotos-');
  const t = await createTestApp({
    env: { FAMILY_FILES_DIR: filesDir, FAMILY_PHOTOS_DIR: photosDir, MIN_FREE_GB: '0' },
    freeBytes: async () => 500 * 1024 ** 3,
  });
  for (const u of [ADMIN, FAMILY, SON]) await addUser(t.dataDir, t.clock, u);
  cleanup.push(async () => {
    await t.app.close();
    for (const d of [t.dataDir, filesDir, photosDir]) await removeDir(d);
  });
  return {
    t,
    filesDir,
    admin: await cookieFor(t.app, ADMIN),
    mama: await cookieFor(t.app, FAMILY),
    son: await cookieFor(t.app, SON),
  };
}

const post = (t: TestApp, cookie: string, url: string, payload: object = {}) =>
  t.app.inject({ method: 'POST', url, headers: { cookie }, payload });
const get = (t: TestApp, cookie: string, url: string) => t.app.inject({ url, headers: { cookie } });

const EVENT = {
  title: 'Приём у врача',
  date: '2026-11-03',
  time: '10:30',
  endTime: '11:15',
  note: 'Взять карту',
};

describe('calendar dates', () => {
  it('knows real dates and where repeats fall; days that do not exist are skipped', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(occursOn('2026-10-17', 'weekly', '2026-10-24')).toBe(true);
    expect(occursOn('2026-10-17', 'weekly', '2026-10-23')).toBe(false);
    expect(occursOn('2026-10-17', 'weekly', '2026-10-10')).toBe(false); // not before the start
    expect(occursOn('2026-01-31', 'monthly', '2026-02-28')).toBe(false);
    expect(occursOn('2026-01-31', 'monthly', '2026-03-31')).toBe(true);
    expect(occursOn('2024-02-29', 'yearly', '2026-02-28')).toBe(false);
    expect(occursOn('2024-02-29', 'yearly', '2028-02-29')).toBe(true);
    expect(occursOn('1990-05-09', 'yearly', '2027-05-09')).toBe(true);
    expect(eachDay('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });
});

describe('family calendar', { timeout: 30_000 }, () => {
  it('needs a signed-in user', async () => {
    const { t } = await setup();
    expect((await t.app.inject({ url: '/api/calendar?from=2026-11-01&to=2026-11-30' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/notes' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/calendar/export.ics' })).statusCode).toBe(401);
  });

  it('adds an event for the whole family and shows it on its day, in order', async () => {
    const { t, mama, son } = await setup();
    const created = await post(t, mama, '/api/calendar', EVENT);
    expect(created.statusCode, created.body).toBe(201);
    const event = created.json() as CalendarEventView;
    expect(event).toMatchObject({
      title: 'Приём у врача',
      owner: 'mama',
      ownerName: 'Мама',
      canEdit: true,
      private: false,
    });
    await post(t, son, '/api/calendar', { title: 'Школа', date: '2026-11-03', time: '08:00' });
    await post(t, son, '/api/calendar', { title: 'Контрольная', date: '2026-11-03' });

    const asSon = (
      await get(t, son, '/api/calendar?from=2026-11-01&to=2026-11-30')
    ).json() as CalendarResponse;
    expect(asSon.occurrences.map((o) => [o.day, o.event.title])).toEqual([
      ['2026-11-03', 'Контрольная'], // all day first
      ['2026-11-03', 'Школа'],
      ['2026-11-03', 'Приём у врача'],
    ]);
    expect(asSon.occurrences.find((o) => o.event.id === event.id)?.event.canEdit).toBe(false);
    expect((await readdir(t.dataDir)).includes('calendar.json')).toBe(true);
  });

  it('repeats weekly, monthly and yearly, and spreads a multi-day event over its days', async () => {
    const { t, mama } = await setup();
    await post(t, mama, '/api/calendar', { title: 'Мусор', date: '2026-11-02', repeat: 'weekly' });
    await post(t, mama, '/api/calendar', { title: 'Платёж', date: '2026-01-31', repeat: 'monthly' });
    await post(t, mama, '/api/calendar', { title: 'День рождения', date: '1990-11-09', repeat: 'yearly' });
    await post(t, mama, '/api/calendar', { title: 'Поездка', date: '2026-11-20', endDate: '2026-11-23' });
    const days = async (title: string) =>
      (
        (await get(t, mama, '/api/calendar?from=2026-11-01&to=2026-12-31')).json() as CalendarResponse
      ).occurrences
        .filter((o) => o.event.title === title)
        .map((o) => o.day);
    expect(await days('Мусор')).toEqual([
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
      '2026-11-30',
      '2026-12-07',
      '2026-12-14',
      '2026-12-21',
      '2026-12-28',
    ]);
    expect(await days('Платёж')).toEqual(['2026-12-31']); // November has no 31st
    expect(await days('День рождения')).toEqual(['2026-11-09']);
    expect(await days('Поездка')).toEqual(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']);
  });

  it('keeps private events private, in the calendar and in the exported file', async () => {
    const { t, mama, son, admin } = await setup();
    await post(t, mama, '/api/calendar', { title: 'Сюрприз для папы', date: '2026-11-05', private: true });
    await post(t, mama, '/api/calendar', { title: 'Ужин', date: '2026-11-05' });
    const range = '/api/calendar?from=2026-11-01&to=2026-11-30';
    const titles = async (cookie: string) =>
      ((await get(t, cookie, range)).json() as CalendarResponse).occurrences.map((o) => o.event.title);
    expect(await titles(mama)).toEqual(['Сюрприз для папы', 'Ужин']);
    expect(await titles(son)).toEqual(['Ужин']);
    expect(await titles(admin)).toEqual(['Ужин']); // not even an administrator reads private plans
    const ics = (await get(t, son, '/api/calendar/export.ics')).body;
    expect(ics).toContain('SUMMARY:Ужин');
    expect(ics).not.toContain('Сюрприз');
    const own = (await get(t, mama, '/api/calendar/export.ics')).body;
    expect(own).toContain('CLASS:PRIVATE');
  });

  it('lets only the author or an administrator change or delete an event', async () => {
    const { t, mama, son, admin } = await setup();
    const event = (await post(t, mama, '/api/calendar', EVENT)).json() as CalendarEventView;
    expect(
      (await post(t, son, `/api/calendar/${event.id}/update`, { ...EVENT, title: 'Взлом' })).statusCode,
    ).toBe(403);
    expect((await post(t, son, `/api/calendar/${event.id}/delete`)).statusCode).toBe(403);
    expect(
      (await post(t, mama, `/api/calendar/${event.id}/update`, { ...EVENT, title: 'Приём у стоматолога' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await post(t, admin, `/api/calendar/${event.id}/update`, { ...EVENT, title: 'Приём (перенесён)' }))
        .statusCode,
    ).toBe(200);
    expect((await post(t, mama, `/api/calendar/${event.id}/delete`)).statusCode).toBe(204);
    expect((await post(t, mama, `/api/calendar/${event.id}/delete`)).statusCode).toBe(404);
    // A private event of somebody else does not even reveal that it exists.
    const secret = (
      await post(t, mama, '/api/calendar', { ...EVENT, private: true })
    ).json() as CalendarEventView;
    expect((await post(t, son, `/api/calendar/${secret.id}/update`, EVENT)).statusCode).toBe(404);
    expect((await post(t, admin, `/api/calendar/${secret.id}/delete`)).statusCode).toBe(404);
  });

  it('explains what is wrong with an event in words', async () => {
    const { t, mama } = await setup();
    const bad = async (patch: object) =>
      (await post(t, mama, '/api/calendar', { ...EVENT, ...patch })).json();
    expect((await bad({ date: '2026-02-30' })).message).toMatch(/настоящую дату/);
    expect((await bad({ endDate: '2026-11-01' })).message).toMatch(/раньше/);
    expect((await bad({ endDate: '2026-11-05', repeat: 'weekly' })).message).toMatch(/один день/);
    expect((await bad({ time: null, endTime: '12:00' })).message).toMatch(/вместе с временем/);
    expect((await bad({ endTime: '09:00' })).message).toMatch(/позже начала/);
    expect((await bad({ time: '25:00' })).message).toMatch(/Время/);
    expect((await bad({ title: '   ' })).error).toBe('bad_event');
    expect((await bad({ title: 'я'.repeat(121) })).error).toBe('bad_event');
    expect((await get(t, mama, '/api/calendar?from=2026-01-01&to=2026-12-31')).json().error).toBe(
      'bad_range',
    );
    expect((await get(t, mama, '/api/calendar?from=2026-11-10&to=2026-11-01')).json().error).toBe(
      'bad_range',
    );
  });

  it('writes a calendar file a phone can import (escaping, folding, repeats, all-day end)', async () => {
    const { t, mama } = await setup();
    await post(t, mama, '/api/calendar', {
      title: 'Купить: хлеб, молоко; сыр',
      date: '2026-11-03',
      endDate: '2026-11-04',
      note: 'Строка 1\nСтрока 2 \\ слэш',
      repeat: 'none',
    });
    await post(t, mama, '/api/calendar', {
      title: 'Йога',
      date: '2026-11-02',
      time: '19:00',
      endTime: '20:00',
      repeat: 'weekly',
    });
    const res = await get(t, mama, '/api/calendar/export.ics');
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="family-calendar-\d{4}-\d{2}-\d{2}\.ics"/,
    );
    const ics = res.body;
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics).toContain('SUMMARY:Купить: хлеб\\, молоко\\; сыр');
    expect(ics).toContain('DESCRIPTION:Строка 1\\nСтрока 2 \\\\ слэш');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261103');
    expect(ics).toContain('DTEND;VALUE=DATE:20261105'); // exclusive end
    expect(ics).toContain('DTSTART:20261102T190000');
    expect(ics).toContain('DTEND:20261102T200000');
    expect(ics).toContain('RRULE:FREQ=WEEKLY');
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n /g, '')).toContain('Купить: хлеб');
  });

  it('refuses to guess when the calendar file is damaged and does not overwrite it', async () => {
    const { t, mama } = await setup();
    await writeFile(path.join(t.dataDir, 'calendar.json'), '{ not json');
    const res = await get(t, mama, '/api/calendar?from=2026-11-01&to=2026-11-30');
    expect(res.statusCode).toBe(503);
    expect((await post(t, mama, '/api/calendar', EVENT)).statusCode).toBe(503);
    expect(await readFile(path.join(t.dataDir, 'calendar.json'), 'utf8')).toBe('{ not json');
  });

  it('folds long lines without cutting a character in half', () => {
    const folded = foldLine(`SUMMARY:${'Ж'.repeat(80)}`);
    for (const line of folded.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'Ж'.repeat(80)}`);
    expect(toIcs([])).toContain('END:VCALENDAR');
  });
});

describe('family notes', { timeout: 30_000 }, () => {
  it('writes a note as a plain text file in «Заметки» and reads it back', async () => {
    const { t, filesDir, mama } = await setup();
    const saved = (
      await post(t, mama, '/api/notes/save', {
        space: 'personal',
        name: 'Список покупок',
        text: 'молоко\nхлеб',
        revision: null,
      })
    ).json() as SaveNoteResponse;
    expect(saved.name).toBe('Список покупок');
    const file = path.join(filesDir, 'users', 'mama', 'Заметки', 'Список покупок.txt');
    expect(await readFile(file, 'utf8')).toBe('молоко\nхлеб');

    const list = (await get(t, mama, '/api/notes?space=personal')).json() as NotesResponse;
    expect(list.notes).toMatchObject([{ name: 'Список покупок', preview: 'молоко хлеб' }]);
    const read = (
      await get(t, mama, `/api/notes/read?space=personal&name=${encodeURIComponent('Список покупок')}`)
    ).json() as NoteResponse;
    expect(read.text).toBe('молоко\nхлеб');
    expect(read.revision).toBe(saved.revision);

    // The same note is an ordinary file in «Файлы».
    const files = await get(
      t,
      mama,
      `/api/storage/files/list?space=personal&path=${encodeURIComponent('Заметки')}`,
    );
    expect(files.json().entries.map((e: { name: string }) => e.name)).toEqual(['Список покупок.txt']);
  });

  it('saves changes only on top of the version that was opened', async () => {
    const { t, mama } = await setup();
    const first = (
      await post(t, mama, '/api/notes/save', { space: 'shared', name: 'Дела', text: 'раз', revision: null })
    ).json() as SaveNoteResponse;
    const body = (text: string, revision: string | null) => ({
      space: 'shared',
      name: 'Дела',
      text,
      revision,
    });
    const second = await post(t, mama, '/api/notes/save', body('раз\nдва', first.revision));
    expect(second.statusCode, second.body).toBe(200);
    // Somebody else still has the old version open: their save is refused, nothing is lost.
    const stale = await post(t, mama, '/api/notes/save', body('чужое', first.revision));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('conflict');
    const now = (
      await get(t, mama, '/api/notes/read?space=shared&name=%D0%94%D0%B5%D0%BB%D0%B0')
    ).json() as NoteResponse;
    expect(now.text).toBe('раз\nдва');
    // A new note may not take the name of an existing one.
    const dup = await post(t, mama, '/api/notes/save', body('новое', null));
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('exists');
  });

  it('keeps personal notes personal and shows shared notes to everybody', async () => {
    const { t, mama, son, admin } = await setup();
    await post(t, mama, '/api/notes/save', {
      space: 'personal',
      name: 'Пароли роутера',
      text: 'секрет',
      revision: null,
    });
    await post(t, mama, '/api/notes/save', {
      space: 'shared',
      name: 'Расписание',
      text: 'вт и чт',
      revision: null,
    });
    expect(((await get(t, son, '/api/notes?space=personal')).json() as NotesResponse).notes).toEqual([]);
    expect(((await get(t, admin, '/api/notes?space=personal')).json() as NotesResponse).notes).toEqual([]);
    expect(
      (
        await get(
          t,
          son,
          '/api/notes/read?space=personal&name=%D0%9F%D0%B0%D1%80%D0%BE%D0%BB%D0%B8%20%D1%80%D0%BE%D1%83%D1%82%D0%B5%D1%80%D0%B0',
        )
      ).statusCode,
    ).toBe(404);
    expect(
      ((await get(t, son, '/api/notes?space=shared')).json() as NotesResponse).notes.map((n) => n.name),
    ).toEqual(['Расписание']);
  });

  it('refuses names that are not safe, huge texts and links out of the space', async () => {
    const { t, filesDir, mama } = await setup();
    const save = (name: string, text = 'x') =>
      post(t, mama, '/api/notes/save', { space: 'personal', name, text, revision: null });
    for (const bad of ['../x', 'a/b', 'a\\b', '.скрытая', 'CON', 'a:b', '']) {
      expect((await save(bad)).json().error, bad).toBe('bad_name');
    }
    expect((await save('Большая', 'я'.repeat(120_000))).statusCode).toBe(413);

    // «Заметки» replaced by a link to some other folder: nothing is read or written through it.
    const outside = await makeTempDir('fd-outside-');
    cleanup.push(() => removeDir(outside));
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await mkdir(path.join(filesDir, 'users', 'son'), { recursive: true });
    await symlink(outside, path.join(filesDir, 'users', 'son', 'Заметки'), 'junction');
    const son = await cookieFor(t.app, SON);
    expect((await get(t, son, '/api/notes/read?space=personal&name=secret')).statusCode).toBe(403);
    expect(
      (await post(t, son, '/api/notes/save', { space: 'personal', name: 'Новая', text: 'x', revision: null }))
        .statusCode,
    ).toBe(403);
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  it('moves a deleted note to the trash instead of destroying it', async () => {
    const { t, filesDir, mama } = await setup();
    await post(t, mama, '/api/notes/save', { space: 'personal', name: 'Лишняя', text: 'x', revision: null });
    expect((await post(t, mama, '/api/notes/delete', { space: 'personal', name: 'Лишняя' })).statusCode).toBe(
      204,
    );
    expect(((await get(t, mama, '/api/notes?space=personal')).json() as NotesResponse).notes).toEqual([]);
    const trash = await readdir(path.join(filesDir, '.trash', 'users', 'mama'));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toContain('Лишняя.txt');
  });
});
