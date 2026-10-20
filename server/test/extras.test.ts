import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createFeatureStore } from '../src/features/features.ts';
import { createDiskHistory } from '../src/health/disk-history.ts';
import { buildFamilyStatus } from '../src/health/status.ts';
import { checkDeadline, createDeadlineStore, DeadlineError, deadlineBody } from '../src/planner/deadlines.ts';
import { createDecoys } from '../src/security/decoys.ts';
import { createNetworkWatcher, parseArp } from '../src/security/network.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createFakeClock,
  createTestApp,
  FAMILY,
  makeTempDir,
  removeDir,
} from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function tmp() {
  const dir = await makeTempDir('fd-extras-');
  cleanup.push(() => removeDir(dir));
  return dir;
}

describe('switches of functions', () => {
  it('everything is on by default, a switched-off function owns its API paths, and the file survives a restart', async () => {
    const dir = await tmp();
    const store = createFeatureStore(dir);
    await store.load();
    expect(store.states().tasks).toBe(true);
    expect(store.offFeatureFor('/api/tasks')).toBeNull();
    await store.set('tasks', false);
    expect(store.offFeatureFor('/api/tasks')).toBe('tasks');
    expect(store.offFeatureFor('/api/tasks/abc/delete')).toBe('tasks');
    expect(store.offFeatureFor('/api/tasksX')).toBeNull();
    expect(store.offFeatureFor('/api/admin/features')).toBeNull();
    const again = createFeatureStore(dir);
    await again.load();
    expect(again.states().tasks).toBe(false);
    await expect(again.set('nothing', false)).rejects.toThrow();
    await writeFile(path.join(dir, 'features.json'), '{ broken');
    const damaged = createFeatureStore(dir);
    await damaged.load();
    // a damaged file must not lock the family out
    expect(damaged.states().tasks).toBe(true);
  });

  it('the administrator switches a function off, the family gets 403, and only an administrator may switch', async () => {
    const t = await createTestApp();
    cleanup.push(async () => {
      await t.app.close();
      await removeDir(t.dataDir);
    });
    await addUser(t.dataDir, t.clock, ADMIN);
    await addUser(t.dataDir, t.clock, FAMILY);
    const admin = await cookieFor(t.app, ADMIN);
    const family = await cookieFor(t.app, FAMILY);
    const post = (cookie: string, payload: object) =>
      t.app.inject({ method: 'POST', url: '/api/admin/features', headers: { cookie }, payload });
    expect((await post(family, { id: 'tasks', enabled: false })).statusCode).toBe(403);
    expect((await t.app.inject({ url: '/api/tasks', headers: { cookie: family } })).statusCode).toBe(200);
    const off = await post(admin, { id: 'tasks', enabled: false });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { states: Record<string, boolean> }).states.tasks).toBe(false);
    const refused = await t.app.inject({ url: '/api/tasks', headers: { cookie: family } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'feature_off' });
    const states = await t.app.inject({ url: '/api/features', headers: { cookie: family } });
    expect((states.json() as { states: Record<string, boolean> }).states.tasks).toBe(false);
    expect((await post(admin, { id: 'unknown', enabled: false })).statusCode).toBe(400);
    expect((await post(admin, { id: 'tasks', enabled: true })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/tasks', headers: { cookie: family } })).statusCode).toBe(200);
  });
});

describe('size limits', () => {
  it('are off by default, and a number still limits', () => {
    const off = loadConfig({}, 'win32');
    for (const bytes of [off.uploadMaxFileBytes, off.downloadMaxFileBytes, off.chatMaxAttachmentBytes]) {
      expect(bytes).toBe(Number.MAX_SAFE_INTEGER);
    }
    expect(off.torrent.uploadLimitKb).toBe(0);
    const set = loadConfig({ UPLOAD_MAX_FILE_GB: '3' }, 'win32');
    expect(set.uploadMaxFileBytes).toBe(3 * 1024 ** 3);
  });
});

describe('deadlines', () => {
  const me = { username: 'mama', displayName: 'Мама', isAdmin: false };
  const input = (over: Partial<ReturnType<typeof checkDeadline>> = {}) => ({
    ...checkDeadline(
      deadlineBody.parse({ title: 'Страховка', expires: '2026-10-30', remindDays: [30, 7, 1] }),
    ),
    ...over,
  });

  it('refuses nonsense in plain words', () => {
    expect(() => checkDeadline(deadlineBody.parse({ title: ' ', expires: '2026-10-30' }))).toThrow(
      DeadlineError,
    );
    expect(() => checkDeadline(deadlineBody.parse({ title: 'a', expires: '2026-02-31' }))).toThrow(/дату/);
  });

  it('a private deadline is its author’s alone, a shared one is the family’s, and only the author or an administrator changes it', async () => {
    const dir = await tmp();
    const clock = createFakeClock();
    const store = createDeadlineStore(dir, { clock });
    const mine = await store.create(me, input());
    const shared = await store.create(me, input({ title: 'Налог', shared: true }));
    expect((await store.list('papa')).map((d) => d.title)).toEqual(['Налог']);
    expect(await store.list('mama')).toHaveLength(2);
    await expect(store.update({ username: 'papa', isAdmin: false }, mine.id, input())).rejects.toMatchObject({
      status: 404,
    });
    await expect(store.remove({ username: 'papa', isAdmin: false }, shared.id)).rejects.toMatchObject({
      status: 403,
    });
    await store.remove({ username: 'papa', isAdmin: true }, shared.id);
    expect(await store.list('mama')).toHaveLength(1);
  });

  it('each reminder is told once, a PC that was off still gets it, and an old one is not told', async () => {
    const dir = await tmp();
    const clock = createFakeClock('2026-10-01T09:00:00.000Z');
    const store = createDeadlineStore(dir, { clock });
    await store.create(me, input({ expires: '2026-10-08' }));
    expect(await store.dueReminders()).toHaveLength(1); // 7 days left: «30» and «7» boundaries passed, told together
    expect(await store.dueReminders()).toHaveLength(0);
    clock.advance(6 * 86_400_000); // one day left
    const jobs = await store.dueReminders();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.daysLeft).toBe(1);
    clock.advance(30 * 86_400_000); // long over
    expect(await store.dueReminders()).toHaveLength(0);
  });
});

describe('forecast of the disk', () => {
  it('needs data, ignores a quiet disk, and tells how many days are left for a shrinking one', async () => {
    const dir = await tmp();
    const clock = createFakeClock('2026-10-01T00:00:00.000Z');
    let free = 500 * 1024 ** 3;
    const history = createDiskHistory(dir, {
      clock,
      probe: async () => [{ path: 'C:\\', freeBytes: free }],
      reserveBytes: 2 * 1024 ** 3,
    });
    await history.record();
    expect((await history.forecast())[0]?.daysLeft).toBeNull(); // one point
    for (let hour = 1; hour <= 72; hour += 1) {
      clock.advance(3_600_000);
      await history.record();
    }
    expect((await history.forecast())[0]?.daysLeft).toBeNull(); // not shrinking
    for (let hour = 1; hour <= 72; hour += 1) {
      clock.advance(3_600_000);
      free -= 5 * 1024 ** 3; // 120 GB a day
      await history.record();
    }
    const [f] = await history.forecast();
    expect(f?.perDayBytes).toBeGreaterThan(50 * 1024 ** 3);
    expect(f?.daysLeft).not.toBeNull();
    expect(f?.daysLeft ?? 0).toBeLessThan(30);
  });
});

describe('family status', () => {
  it('says what works in plain lines and the worst level wins', () => {
    const system = {
      programs: {
        value: [{ name: 'jellyfin', title: 'Кинотеатр', state: 'running', restarts: 0, startedAt: null }],
      },
      backup: { state: 'ok', lastSuccessAt: '2026-10-20T00:00:00.000Z', message: '' },
      volumes: [{ path: 'C:\\', lowSpace: false }],
    } as never;
    const ok = buildFamilyStatus({
      system,
      internet: { up: true, dnsUp: true, checkedAt: null },
      forecast: [],
      now: new Date('2026-10-20T05:00:00Z'),
    });
    expect(ok.level).toBe('ok');
    const bad = buildFamilyStatus({
      system,
      internet: { up: false, dnsUp: false, checkedAt: null },
      forecast: [],
      now: new Date('2026-10-20T05:00:00Z'),
    });
    expect(bad.level).toBe('bad');
    expect(bad.items.find((i) => i.id === 'internet')?.text).toMatch(/нет выхода/);
    const dns = buildFamilyStatus({
      system,
      internet: { up: true, dnsUp: false, checkedAt: null },
      forecast: [],
      now: new Date('2026-10-20T05:00:00Z'),
    });
    expect(dns.level).toBe('warn');
  });
});

describe('decoys', () => {
  it('are made without replacing a real file, alert once an hour, and only untouched ones are taken away', async () => {
    const dir = await tmp();
    const shared = path.join(dir, 'shared');
    await mkdir(shared, { recursive: true });
    await writeFile(path.join(shared, 'Банк и карты.txt'), 'настоящий файл');
    const clock = createFakeClock();
    const decoys = createDecoys({ dataDir: dir, sharedDir: () => shared, clock });
    expect(await decoys.install()).toBe(2); // one name was taken by a real file
    expect(await readFile(path.join(shared, 'Банк и карты.txt'), 'utf8')).toBe('настоящий файл');
    expect(await decoys.touched('Пароли от всего.txt')).toBe('Пароли от всего.txt');
    expect(await decoys.touched('пароли от всего.txt')).toBeNull(); // the same hour
    expect(await decoys.touched('обычный файл.txt')).toBeNull();
    clock.advance(3_700_000);
    expect(await decoys.touched('Пароли от всего.txt')).not.toBeNull();
    expect((await decoys.list()).find((d) => d.path === 'Пароли от всего.txt')?.touched).toBe(3);
    await writeFile(path.join(shared, 'Паспорта и документы.txt'), 'здесь записали настоящее');
    expect(await decoys.remove()).toBe(1);
    expect(await readFile(path.join(shared, 'Паспорта и документы.txt'), 'utf8')).toBe(
      'здесь записали настоящее',
    );
  });
});

describe('devices of the network', () => {
  it('reads the neighbour table without multicast, makes a list on the first scan and reports only new devices after it', async () => {
    const text = [
      'Интерфейс: 192.168.1.20 --- 0x7',
      '  Адрес в Интернете     Физический адрес      Тип',
      '  192.168.1.1           AA-BB-CC-00-00-01     динамический',
      '  192.168.1.255         ff-ff-ff-ff-ff-ff     статический',
      '  224.0.0.22            01-00-5e-00-00-16     статический',
      '  192.168.1.30          aa-bb-cc-00-00-02     dynamic',
    ].join('\n');
    expect(parseArp(text)).toEqual([
      { ip: '192.168.1.1', mac: 'aa-bb-cc-00-00-01' },
      { ip: '192.168.1.30', mac: 'aa-bb-cc-00-00-02' },
    ]);
    const dir = await tmp();
    const clock = createFakeClock();
    let seen = parseArp(text);
    const told: string[] = [];
    const watcher = createNetworkWatcher({
      dataDir: dir,
      clock,
      read: async () => seen,
      onNewDevice: async (d) => void told.push(d.mac),
    });
    expect(await watcher.scan()).toHaveLength(2);
    expect(told).toEqual([]); // the first scan only makes the list
    seen = [...seen, { ip: '192.168.1.44', mac: 'aa-bb-cc-00-00-03' }];
    await watcher.scan();
    await watcher.scan();
    expect(told).toEqual(['aa-bb-cc-00-00-03']); // once
    expect(await watcher.name('aa-bb-cc-00-00-03', 'Телевизор', true)).toBe(true);
    expect((await watcher.list()).find((d) => d.mac === 'aa-bb-cc-00-00-03')).toMatchObject({
      name: 'Телевизор',
      known: true,
    });
    expect(await watcher.name('00-00-00-00-00-00', 'x', true)).toBe(false);
  });
});
