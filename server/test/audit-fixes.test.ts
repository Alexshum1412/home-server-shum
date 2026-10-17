import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditResponse, CalendarEventView, CalendarResponse, UsersResponse } from '../../shared/api.ts';
import { removeStaleTempFiles } from '../src/files/cleanup.ts';
import { uniqueName } from '../src/files/names.ts';
import { createStorage, StorageError } from '../src/files/storage.ts';
import { importFolder } from '../src/files/transfer.ts';
import { MAX_EVENTS_PER_USER, MAX_OCCURRENCES } from '../src/planner/calendar.ts';
import { toIcs } from '../src/planner/ics.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createTestApp,
  FAMILY,
  login,
  makeTempDir,
  removeDir,
  type TestApp,
} from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup(extraUsers: Array<Parameters<typeof addUser>[2]> = []) {
  const t = await createTestApp({ freeBytes: async () => 500 * 1024 ** 3, env: { MIN_FREE_GB: '0' } });
  cleanup.push(async () => {
    await t.app.close();
    await removeDir(t.dataDir);
  });
  for (const user of [ADMIN, FAMILY, ...extraUsers]) await addUser(t.dataDir, t.clock, user);
  return { t, admin: await cookieFor(t.app, ADMIN), mama: await cookieFor(t.app, FAMILY) };
}

const post = (t: TestApp, cookie: string, url: string, payload: object = {}) =>
  t.app.inject({ method: 'POST', url, headers: { cookie }, payload });
const get = (t: TestApp, cookie: string, url: string) => t.app.inject({ url, headers: { cookie } });
const upload = (t: TestApp, cookie: string, q: Record<string, string>, body: Buffer) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/storage/${q.root ?? 'files'}/upload?${new URLSearchParams({ size: String(body.length), ...q })}`,
    headers: { cookie, 'content-type': 'application/octet-stream', 'x-upload': '1' },
    payload: body,
  });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 3)]);

describe('test app safety', () => {
  it('keeps every folder the portal writes to inside the throwaway data dir', async () => {
    const { t } = await setup();
    for (const dir of [t.config.filesDir, t.config.photosDir, t.config.mediaDir, ...t.config.backupTargets]) {
      expect(path.relative(t.dataDir, dir).startsWith('..'), dir).toBe(false);
    }
  });
});

describe('audit: sign-in journal and sessions', () => {
  it('never writes what was typed into the login box unless it is a real account', async () => {
    const { t, admin } = await setup();
    const typedPassword = 'nmhk5-yhqpv-hxvut-qnwqu'; // looks like a login name, is a password in the wrong box
    expect((await login(t.app, typedPassword, 'x')).res.statusCode).toBe(401);
    expect((await login(t.app, 'papa', 'wrong-password-1')).res.statusCode).toBe(401);
    const audit = (await get(t, admin, '/api/admin/audit?limit=50')).json() as AuditResponse;
    expect(JSON.stringify(audit)).not.toContain(typedPassword);
    const failures = audit.entries.filter((e) => e.action === 'login.failure');
    expect(failures.map((e) => e.actor).sort()).toEqual([null, 'papa']);
  });

  it('a session whose sign-in began before a password change does not survive it', async () => {
    const { t } = await setup();
    const started = t.clock().toISOString();
    t.clock.advance(1000);
    const user = await t.app.dashboard.users.findByUsername('mama');
    await t.app.dashboard.users.update(user?.id ?? '', { passwordChangedAt: t.clock().toISOString() });
    const { token } = await t.app.dashboard.sessions.create(user?.id ?? '', started);
    const res = await get(t, `fd_session=${token}`, '/api/session');
    expect(res.statusCode).toBe(401);
  });
});

describe('audit: the last administrator', () => {
  it('two administrators removing each other at once never leave the portal without one', async () => {
    const { t, admin } = await setup([
      { username: 'tata', password: 'second-admin-pw-1', role: 'admin', displayName: 'Тата' },
    ]);
    const tata = await cookieFor(t.app, { username: 'tata', password: 'second-admin-pw-1' });
    const results = await Promise.all([
      post(t, admin, '/api/admin/users/tata/remove', { confirm: true }),
      post(t, tata, '/api/admin/users/papa/remove', { confirm: true }),
    ]);
    expect(
      results
        .map((r) => r.statusCode)
        .sort()
        .filter((code) => code === 204).length,
    ).toBeLessThanOrEqual(1);
    const users = await t.app.dashboard.users.list();
    expect(users.filter((u) => u.role === 'admin').length).toBeGreaterThanOrEqual(1);
  });

  it('two administrators demoting each other at once keep one', async () => {
    const { t, admin } = await setup([
      { username: 'tata', password: 'second-admin-pw-1', role: 'admin', displayName: 'Тата' },
    ]);
    const tata = await cookieFor(t.app, { username: 'tata', password: 'second-admin-pw-1' });
    await Promise.all([
      post(t, admin, '/api/admin/users/tata/access', { role: 'family' }),
      post(t, tata, '/api/admin/users/papa/access', { role: 'family' }),
    ]);
    const users = await t.app.dashboard.users.list();
    expect(users.filter((u) => u.role === 'admin').length).toBeGreaterThanOrEqual(1);
  });
});

describe('audit: removing an account keeps the data and does not hand it to a namesake', () => {
  it('moves personal files to the trash folder, drops private events and disowns family events', async () => {
    const { t, admin } = await setup([
      { username: 'olya', password: 'olya-password-12', role: 'family', displayName: 'Оля' },
    ]);
    const olya = await cookieFor(t.app, { username: 'olya', password: 'olya-password-12' });
    await upload(t, olya, { space: 'personal', name: 'дневник.txt' }, Buffer.from('личное'));
    await upload(t, olya, { space: 'personal', root: 'photos', name: 'a.jpg', path: '' }, JPEG);
    await post(t, olya, '/api/calendar', { title: 'Тайна', date: '2026-11-03', private: true });
    await post(t, olya, '/api/calendar', { title: 'Школьный вечер', date: '2026-11-03' });

    expect((await post(t, admin, '/api/admin/users/olya/remove', { confirm: true })).statusCode).toBe(204);
    const home = path.join(t.config.filesDir, 'users', 'olya');
    await expect(stat(home)).rejects.toThrow();
    const archived = await readdir(path.join(t.config.filesDir, '.trash', 'removed-users'));
    expect(archived).toHaveLength(1);
    expect(
      await readFile(
        path.join(t.config.filesDir, '.trash', 'removed-users', archived[0] ?? '', 'дневник.txt'),
        'utf8',
      ),
    ).toBe('личное');
    expect(await readdir(path.join(t.config.photosDir, '.trash', 'removed-users'))).toHaveLength(1);

    // A different person gets the same login later: nothing of the old account is theirs.
    await post(t, admin, '/api/admin/users', { username: 'olya', displayName: 'Другая Оля', role: 'family' });
    const newcomer = await t.app.dashboard.users.findByUsername('olya');
    await t.app.dashboard.users.update(newcomer?.id ?? '', {
      mustChangePassword: false,
      passwordExpiresAt: null,
      passwordHash: (await t.app.dashboard.users.findByUsername('papa'))?.passwordHash ?? '',
    });
    const again = await cookieFor(t.app, { username: 'olya', password: ADMIN.password });
    const files = (await get(t, again, '/api/storage/files/list?space=personal')).json();
    expect(files.entries).toEqual([]);
    const events = (
      await get(t, again, '/api/calendar?from=2026-11-01&to=2026-11-30')
    ).json() as CalendarResponse;
    expect(events.occurrences.map((o) => o.event.title)).toEqual(['Школьный вечер']);
    expect(events.occurrences[0]?.event.canEdit).toBe(false);
    const audit = (await get(t, admin, '/api/admin/audit?limit=20')).json() as AuditResponse;
    expect(audit.entries.find((e) => e.action === 'user.remove')?.detail).toMatch(
      /файлы и фото перенесены в корзину/,
    );
    const users = (await get(t, admin, '/api/admin/users')).json() as UsersResponse;
    expect(users.users.map((u) => u.username)).toContain('olya');
  });
});

describe('audit: notes and uploads under concurrency', () => {
  it('two saves of one note at once never lose it: one wins, the other is told about the conflict', async () => {
    const { t, mama } = await setup();
    const created = (
      await post(t, mama, '/api/notes/save', { space: 'personal', name: 'Гонка', text: '0', revision: null })
    ).json();
    let current = created.revision as string;
    for (let round = 0; round < 15; round += 1) {
      const [a, b] = await Promise.all([
        post(t, mama, '/api/notes/save', {
          space: 'personal',
          name: 'Гонка',
          text: `a${round}`,
          revision: current,
        }),
        post(t, mama, '/api/notes/save', {
          space: 'personal',
          name: 'Гонка',
          text: `b${round}`,
          revision: current,
        }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes, `round ${round}`).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? a : b;
      current = winner.json().revision;
      const read = (
        await get(t, mama, '/api/notes/read?space=personal&name=%D0%93%D0%BE%D0%BD%D0%BA%D0%B0')
      ).json();
      expect(read.text).toBe(a.statusCode === 200 ? `a${round}` : `b${round}`);
      expect(read.revision).toBe(current);
    }
  });

  it('two notes created with one title at once give one 200 and one 409', async () => {
    const { t, mama } = await setup();
    const make = (text: string) =>
      post(t, mama, '/api/notes/save', { space: 'shared', name: 'Новая', text, revision: null });
    const [a, b] = await Promise.all([make('первая'), make('вторая')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const names = (await readdir(path.join(t.config.filesDir, 'shared', 'Заметки'))).filter(
      (n) => !n.startsWith('.'),
    );
    expect(names).toEqual(['Новая.txt']);
  });

  it('a note up to the documented size can be saved (the general body limit does not cut it)', async () => {
    const { t, mama } = await setup();
    const text = 'я'.repeat(90_000); // ~180 KB in UTF-8, ~180 KB in JSON
    const res = await post(t, mama, '/api/notes/save', {
      space: 'personal',
      name: 'Большая',
      text,
      revision: null,
    });
    expect(res.statusCode, res.body.slice(0, 120)).toBe(200);
  });

  it('two uploads of the same name at once both survive under different names', async () => {
    const { t, mama } = await setup();
    const results = await Promise.all(
      [Buffer.from('первый файл'), Buffer.from('второй файл')].map((body) =>
        upload(t, mama, { space: 'shared', name: 'IMG_1.txt' }, body),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results[0]?.json().name).not.toBe(results[1]?.json().name);
    const files = (await readdir(path.join(t.config.filesDir, 'shared')))
      .filter((n) => !n.startsWith('.'))
      .sort();
    expect(files).toHaveLength(2);
    const texts = await Promise.all(
      files.map((f) => readFile(path.join(t.config.filesDir, 'shared', f), 'utf8')),
    );
    expect(texts.sort()).toEqual(['второй файл', 'первый файл']);
  });

  it('a duplicate of a very long name still fits the limit and stays reachable', async () => {
    const { t, mama } = await setup();
    const long = `${'д'.repeat(146)}.txt`;
    await upload(t, mama, { space: 'personal', name: long }, Buffer.from('1'));
    const second = await upload(t, mama, { space: 'personal', name: long }, Buffer.from('2'));
    expect(second.statusCode).toBe(200);
    expect(Array.from(second.json().name as string).length).toBeLessThanOrEqual(150);
    const read = await get(
      t,
      mama,
      `/api/storage/files/file?space=personal&path=${encodeURIComponent(second.json().name)}`,
    );
    expect(read.statusCode).toBe(200);
    expect(await uniqueName(path.join(t.config.filesDir, 'users', 'mama'), long)).not.toBe(long);
  });
});

describe('audit: thumbnails', () => {
  it('refuses a thumbnail without a declared size and one over the limit', async () => {
    const { t } = await setup();
    const storage = createStorage({
      filesRoot: t.config.filesDir,
      photosRoot: t.config.photosDir,
      minFreeBytes: 0,
      maxUploadBytes: 1024 ** 3,
      freeBytes: async () => 1024 ** 4,
    });
    await mkdir(path.join(t.config.photosDir, 'users', 'mama'), { recursive: true });
    await writeFile(path.join(t.config.photosDir, 'users', 'mama', 'a.jpg'), JPEG);
    const loc = { root: 'photos' as const, space: 'personal' as const, path: '' };
    await expect(
      storage.saveThumb(loc, 'mama', 'a.jpg', Readable.from([JPEG]), Number.NaN),
    ).rejects.toMatchObject({ status: 411 });
    await expect(
      storage.saveThumb(loc, 'mama', 'a.jpg', Readable.from([JPEG]), 600 * 1024),
    ).rejects.toBeInstanceOf(StorageError);
    await storage.saveThumb(loc, 'mama', 'a.jpg', Readable.from([JPEG]), JPEG.length);
  });

  it('a trashed photo takes its thumbnail with it, a new file of that name starts without one', async () => {
    const { t, mama } = await setup();
    await post(t, mama, '/api/storage/photos/mkdir', { space: 'personal', path: '', name: '2026-10' });
    await upload(t, mama, { root: 'photos', space: 'personal', path: '2026-10', name: 'IMG_1.jpg' }, JPEG);
    const thumbPut = await t.app.inject({
      method: 'PUT',
      url: '/api/storage/photos/thumb?space=personal&path=2026-10&name=IMG_1.jpg',
      headers: { cookie: mama, 'content-type': 'application/octet-stream', 'x-upload': '1' },
      payload: JPEG,
    });
    expect(thumbPut.statusCode).toBe(204);
    const list = async () =>
      (await get(t, mama, '/api/storage/photos/list?space=personal&path=2026-10')).json();
    expect((await list()).entries[0].hasThumb).toBe(true);
    await post(t, mama, '/api/storage/photos/trash', { space: 'personal', path: '2026-10/IMG_1.jpg' });
    await upload(
      t,
      mama,
      { root: 'photos', space: 'personal', path: '2026-10', name: 'IMG_1.jpg' },
      Buffer.concat([JPEG, Buffer.from([1])]),
    );
    expect((await list()).entries[0].hasThumb).toBe(false);
  });
});

describe('audit: calendar limits and files of the calendar', () => {
  it('one person cannot fill the calendar', async () => {
    const { t, mama, admin } = await setup();
    const events = Array.from({ length: MAX_EVENTS_PER_USER }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      owner: 'mama',
      ownerName: 'Мама',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      title: `Событие ${i}`,
      date: '2026-11-03',
      endDate: null,
      time: null,
      endTime: null,
      repeat: 'none',
      note: '',
      private: true,
    }));
    await writeFile(path.join(t.dataDir, 'calendar.json'), JSON.stringify({ version: 1, events }));
    const refused = await post(t, mama, '/api/calendar', { title: 'Ещё одно', date: '2026-11-04' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('too_many_own');
    expect((await post(t, admin, '/api/calendar', { title: 'Своё', date: '2026-11-04' })).statusCode).toBe(
      201,
    );
  });

  it('a huge calendar answers fast and says the answer was cut', async () => {
    const { t, mama } = await setup();
    const events = Array.from({ length: 2000 }, (_, i) => ({
      id: `10000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      owner: `u${i % 7}`,
      ownerName: 'Кто-то',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      title: `Еженедельное ${i}`,
      date: '2026-01-05',
      endDate: null,
      time: null,
      endTime: null,
      repeat: 'weekly',
      note: 'заметка'.repeat(20),
      private: false,
    }));
    await writeFile(path.join(t.dataDir, 'calendar.json'), JSON.stringify({ version: 1, events }));
    const started = Date.now();
    const res = await get(t, mama, '/api/calendar?from=2026-11-01&to=2027-02-27');
    const body = res.json() as CalendarResponse;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(body.truncated).toBe(true);
    expect(body.occurrences.length).toBe(MAX_OCCURRENCES);
    const small = (
      await get(t, mama, '/api/calendar?from=2026-11-01&to=2026-11-07')
    ).json() as CalendarResponse;
    expect(small.truncated).toBe(false);
  });

  it('a line break or control character in a title cannot start a new property in the .ics file', () => {
    const view = (title: string): CalendarEventView => ({
      id: 'a1',
      owner: 'mama',
      ownerName: 'Мама',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      title,
      date: '2026-11-03',
      endDate: null,
      time: null,
      endTime: null,
      repeat: 'none',
      note: 'строка\rBEGIN:VALARM ACTION:DISPLAY',
      private: false,
      canEdit: true,
    });
    const ics = toIcs([view('Врач\rBEGIN:VALARM\u0000\u000bX')]);
    expect(ics).not.toMatch(/\r(?!\n)/);
    expect(ics.split('\r\n').filter((line) => line.startsWith('BEGIN:VALARM'))).toEqual([]);
    expect(ics).toContain('SUMMARY:Врач\\nBEGIN:VALARM');
  });
});

describe('audit: import and housekeeping', () => {
  it('a file of the same name and size but other content is imported, not skipped', async () => {
    const filesDir = await makeTempDir('fd-tf-');
    const source = await makeTempDir('fd-ts-');
    cleanup.push(async () => {
      await removeDir(filesDir);
      await removeDir(source);
    });
    const storage = createStorage({
      filesRoot: filesDir,
      photosRoot: filesDir,
      minFreeBytes: 0,
      maxUploadBytes: 1024 ** 3,
      freeBytes: async () => 1024 ** 4,
    });
    await mkdir(path.join(filesDir, 'users', 'mama'), { recursive: true });
    await writeFile(path.join(filesDir, 'users', 'mama', 'a.txt'), 'AAAA');
    await writeFile(path.join(source, 'a.txt'), 'BBBB'); // same length, other content
    await writeFile(path.join(source, 'b.txt'), 'CCCC');
    await writeFile(path.join(filesDir, 'users', 'mama', 'b.txt'), 'CCCC'); // truly the same
    const report = await importFolder({
      storage,
      username: 'mama',
      root: 'files',
      space: 'personal',
      source,
    });
    expect(report.imported).toBe(1);
    expect(report.existing).toBe(1);
    expect((await readdir(path.join(filesDir, 'users', 'mama'))).sort()).toEqual([
      'a (2).txt',
      'a.txt',
      'b.txt',
    ]);
  });

  it('removes only old temp files from the family folders and never touches the trash', async () => {
    const root = await makeTempDir('fd-tmp-');
    cleanup.push(() => removeDir(root));
    await mkdir(path.join(root, 'users', 'mama'), { recursive: true });
    await mkdir(path.join(root, '.trash', 'users', 'mama'), { recursive: true });
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const fresh = path.join(root, 'users', 'mama', '.upload-fresh');
    const stale = path.join(root, 'users', 'mama', '.upload-stale');
    const keep = path.join(root, 'users', 'mama', 'документ.txt');
    const trashed = path.join(root, '.trash', 'users', 'mama', '.upload-in-trash');
    for (const file of [fresh, stale, keep, trashed]) await writeFile(file, 'x');
    for (const file of [stale, keep, trashed]) await utimes(file, old, old);
    const removed = await removeStaleTempFiles(root);
    expect(removed).toEqual([stale]);
    await expect(stat(keep)).resolves.toBeDefined();
    await expect(stat(trashed)).resolves.toBeDefined();
    await expect(stat(fresh)).resolves.toBeDefined();
  });
});
