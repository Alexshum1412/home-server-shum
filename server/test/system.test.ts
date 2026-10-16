import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemResponse, TailscaleInfo } from '../../shared/api.ts';
import { alertsForRole, buildAlerts } from '../src/system/alerts.ts';
import { BACKUP_STALE_MS, readBackupStatus } from '../src/system/backup.ts';
import { parsePhysicalDisks } from '../src/system/disks.ts';
import { ProbeError } from '../src/system/powershell.ts';
import { parsePrinters } from '../src/system/printer.ts';
import { parseTailscaleStatus, TAILSCALE_REASON } from '../src/system/tailscale.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createFakeClock,
  createTestApp,
  FAMILY,
  fakeCpus,
  fakeProbes,
  makeTempDir,
  readFixture,
  removeDir,
  type TestApp,
  type TestAppOptions,
} from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const NEVER = () => new Promise<never>(() => {});

const apps: TestApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const t of apps.splice(0)) {
    await t.app.close();
    dirs.push(t.dataDir);
  }
  for (const dir of dirs.splice(0)) await removeDir(dir);
});

/** App with both test users; probes are collected once unless `collect: false`. */
async function systemApp(options: TestAppOptions & { collect?: boolean } = {}): Promise<TestApp> {
  const { collect = true, ...rest } = options;
  const t = await createTestApp(rest);
  apps.push(t);
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
  if (collect) await t.app.dashboard.collector.collectAll();
  return t;
}

async function systemAs(t: TestApp, user: { username: string; password: string }): Promise<SystemResponse> {
  const cookie = await cookieFor(t.app, user);
  const res = await t.app.inject({ url: '/api/system', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as SystemResponse;
}

const alertIds = (body: SystemResponse) => body.alerts.map((alert) => alert.id);

function tailscaleInfo(overrides: Partial<TailscaleInfo>): TailscaleInfo {
  return {
    state: 'running',
    dnsName: null,
    peersOnline: null,
    version: null,
    collectedAt: '2026-10-16T10:00:00.000Z',
    reason: null,
    ...overrides,
  };
}

describe('physical disk parser', () => {
  const disks = parsePhysicalDisks(readFixture('physical-disks.json'));

  it('flags the ST_M13FQBL firmware identity as a warning and says not to initialise or format it', () => {
    const suspicious = disks.find((disk) => disk.model === 'ST_M13FQBL');
    expect(suspicious).toBeDefined();
    expect(suspicious?.health).toBe('warning');
    expect(suspicious?.rawHealth).toBe('Healthy');
    expect(suspicious?.sizeBytes).toBe(4_142_054_400);
    expect(suspicious?.note).toContain('Не инициализируйте и не форматируйте');
    expect(suspicious?.note).toContain('3,9 ГБ');
  });

  it('reports the main 2 TB disk as healthy without a note', () => {
    const main = disks.find((disk) => disk.model.startsWith('ST2000NC001'));
    expect(main).toMatchObject({ health: 'healthy', note: null, busType: 'SATA', mediaType: 'HDD' });
  });

  it('marks a USB stick as removable', () => {
    const usb = disks.find((disk) => disk.busType === 'USB');
    expect(usb).toMatchObject({ health: 'healthy', note: 'Съёмный USB-накопитель' });
  });

  it('maps Windows health strings and tolerates odd input', () => {
    const [single] = parsePhysicalDisks({ model: 'X', health: 'Unhealthy', sizeBytes: '' });
    expect(single).toMatchObject({ model: 'X', health: 'unhealthy', sizeBytes: null });
    expect(parsePhysicalDisks([{ health: 'Something' }])[0]?.health).toBe('unknown');
    expect(parsePhysicalDisks('garbage')).toEqual([]);
    expect(parsePhysicalDisks(null)).toEqual([]);
  });
});

describe('printer parser', () => {
  const printers = readFixture('printers.json');

  it('reports the Windows default printer as ready, from Windows only, with no ink levels', () => {
    const info = parsePrinters(printers, null);
    expect(info.name).toBe('HP Color LaserJet MFP M283fdw (D6ECE2)');
    expect(info.state).toBe('ready');
    expect(info.message).toContain('по данным Windows');
    expect(Object.keys(info).sort()).toEqual(['message', 'name', 'state']);
    expect(JSON.stringify(info)).not.toMatch(/ink|toner|paperLevel|чернил/i);
  });

  it('selects PRINTER_NAME case-insensitively', () => {
    const info = parsePrinters(printers, 'microsoft print to pdf');
    expect(info).toMatchObject({ name: 'Microsoft Print to PDF', state: 'ready' });
  });

  it('says when the configured printer does not exist', () => {
    const info = parsePrinters(printers, 'Canon Missing');
    expect(info.state).toBe('not_found');
    expect(info.message).toContain('«Canon Missing» не найден');
  });

  it('maps offline and error states and handles a missing default printer', () => {
    const base = { name: 'P', isDefault: true, printerStatus: 3, detectedErrorState: 0, workOffline: false };
    expect(parsePrinters([{ ...base, workOffline: true }], null).state).toBe('offline');
    expect(parsePrinters([{ ...base, detectedErrorState: 4 }], null)).toMatchObject({
      state: 'error',
      message: 'Нет бумаги (по данным Windows)',
    });
    expect(parsePrinters([{ ...base, isDefault: false }], null).state).toBe('not_configured');
    expect(parsePrinters([], null).state).toBe('not_configured');
  });
});

describe('tailscale parser', () => {
  it('reads a running node: state, version and online peers', () => {
    const info = parseTailscaleStatus(readFixture('tailscale-status.json'));
    expect(info).toEqual({
      state: 'running',
      dnsName: 'test-server.example-tailnet.ts.net',
      peersOnline: 2,
      version: '1.104.1',
      reason: null,
    });
  });

  it('treats NoState (Tailscale app not started after a reboot) as stopped with a next step', () => {
    const info = parseTailscaleStatus(readFixture('tailscale-nostate.json'));
    expect(info.state).toBe('stopped');
    expect(info.reason).toBe(
      'Tailscale на сервере не подключён к сети. Откройте приложение Tailscale на сервере (или включите режим Unattended).',
    );
    expect(info.version).toBe('1.104.1');
    expect(info.peersOnline).toBeNull();
    expect(info.dnsName).toBeNull();
  });

  it('maps the other backend states', () => {
    expect(parseTailscaleStatus({ BackendState: 'Starting' })).toMatchObject({
      state: 'unknown',
      reason: 'Tailscale подключается…',
    });
    expect(parseTailscaleStatus({ BackendState: 'Stopped' })).toMatchObject({
      state: 'stopped',
      reason: TAILSCALE_REASON.stopped,
    });
    expect(parseTailscaleStatus({ BackendState: 'NeedsLogin' }).state).toBe('needs_login');
    expect(parseTailscaleStatus({ BackendState: 'NeedsMachineAuth' }).state).toBe('needs_login');
    expect(parseTailscaleStatus({ BackendState: 'SomethingNew' }).state).toBe('unknown');
  });

  it('returns unknown with a reason for garbage', () => {
    for (const raw of [null, 'not json', 42, [], {}]) {
      const info = parseTailscaleStatus(raw);
      expect(info.state, JSON.stringify(raw)).toBe('unknown');
      expect(info.reason, JSON.stringify(raw)).toEqual(expect.any(String));
      expect(info.peersOnline).toBeNull();
    }
  });
});

describe('backup status (backup-status.json)', () => {
  const clock = createFakeClock('2026-10-16T10:00:00.000Z');
  const now = clock().getTime();
  const iso = (ms: number) => new Date(ms).toISOString();

  async function statusFor(content: unknown | undefined) {
    const dir = await makeTempDir();
    dirs.push(dir);
    if (content !== undefined) {
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      await writeFile(path.join(dir, 'backup-status.json'), text);
    }
    return readBackupStatus(dir, clock);
  }

  it('is not_configured while no backup job has reported', async () => {
    expect(await statusFor(undefined)).toMatchObject({
      state: 'not_configured',
      lastSuccessAt: null,
      restoreTested: false,
    });
  });

  it('is ok after a recent successful run, but restore is not assumed tested', async () => {
    const lastSuccessAt = iso(now - DAY);
    const info = await statusFor({ lastRunAt: lastSuccessAt, lastResult: 'ok', lastSuccessAt });
    expect(info).toMatchObject({ state: 'ok', lastSuccessAt, restoreTested: false });
    expect(info.message).toContain('Восстановление из копии ещё не проверялось');
  });

  it('is failed when the last run failed', async () => {
    const info = await statusFor({
      lastRunAt: iso(now - 1000),
      lastResult: 'failed',
      lastSuccessAt: iso(now - 2 * DAY),
    });
    expect(info.state).toBe('failed');
    expect(info.lastSuccessAt).toBe(iso(now - 2 * DAY));
  });

  it('is stale when the last success is older than 8 days', async () => {
    const lastSuccessAt = iso(now - BACKUP_STALE_MS - 60_000);
    expect(BACKUP_STALE_MS).toBe(8 * DAY);
    const info = await statusFor({ lastResult: 'ok', lastSuccessAt });
    expect(info.state).toBe('stale');
  });

  it('reports restoreTested only after a recorded restore test', async () => {
    const info = await statusFor({
      lastResult: 'ok',
      lastSuccessAt: iso(now - DAY),
      restoreTestedAt: iso(now - DAY / 2),
    });
    expect(info).toMatchObject({ state: 'ok', restoreTested: true });
    expect(info.message).not.toContain('не проверялось');
  });

  it('is unknown (never ok) when the file is broken or has the wrong shape', async () => {
    expect((await statusFor('{ not json')).state).toBe('unknown');
    expect((await statusFor({ lastResult: 'maybe' })).state).toBe('unknown');
    expect((await statusFor({ lastSuccessAt: 'yesterday' })).state).toBe('unknown');
  });
});

describe('alerts', () => {
  const backup = { state: 'ok', lastSuccessAt: null, restoreTested: false, message: '' } as const;
  const inputs = { backup, volumes: [], disks: null, servicesConfigError: null };

  it('raises the remote-access alert for everyone when Tailscale is stopped or needs login', () => {
    for (const state of ['stopped', 'needs_login', 'not_installed'] as const) {
      const alerts = buildAlerts({ ...inputs, tailscale: tailscaleInfo({ state, reason: 'Причина' }) });
      const alert = alerts.find((a) => a.id === 'tailscale-not-running');
      expect(alert, state).toMatchObject({ audience: 'all', level: 'warning' });
      expect(alertsForRole(alerts, 'family').map((a) => a.id)).toContain('tailscale-not-running');
    }
  });

  it('writes the NoState reason into the alert without doubled punctuation', () => {
    const tailscale = tailscaleInfo({ state: 'stopped', reason: TAILSCALE_REASON.noState });
    const [alert] = buildAlerts({ ...inputs, tailscale });
    expect(alert?.text).toContain('Откройте приложение Tailscale на сервере');
    expect(alert?.text).toContain('из других стран');
    expect(alert?.text).not.toContain('..');
  });

  it('does not raise it for running, starting or a failed probe (unknown)', () => {
    for (const tailscale of [
      tailscaleInfo({ state: 'running' }),
      tailscaleInfo({ state: 'unknown', reason: TAILSCALE_REASON.starting }),
      tailscaleInfo({ state: 'unknown', reason: 'Проверка не завершилась за 7 с', collectedAt: null }),
    ]) {
      expect(buildAlerts({ ...inputs, tailscale }).map((a) => a.id)).not.toContain('tailscale-not-running');
    }
  });

  it('removes the audience field before sending alerts to the browser', () => {
    const alerts = buildAlerts({ ...inputs, tailscale: tailscaleInfo({ state: 'stopped' }) });
    for (const alert of alertsForRole(alerts, 'admin')) expect(alert).not.toHaveProperty('audience');
  });
});

describe('GET /api/system', () => {
  it('requires a session', async () => {
    const t = await systemApp({ collect: false });
    const res = await t.app.inject({ url: '/api/system' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('hides device details from family members', async () => {
    const t = await systemApp();
    const body = await systemAs(t, FAMILY);
    expect(body.server.hostname).toBeNull();
    expect(body.server.osRelease).toBeNull();
    expect(body.tailscale.state).toBe('running');
    expect(body.tailscale.dnsName).toBeNull();
    expect(body.tailscale.peersOnline).toBeNull();
    expect(body.physicalDisks.value).toBeNull();
    expect(body.physicalDisks.reason).toBe('Подробности доступны администратору');
    expect(JSON.stringify(body)).not.toContain('TEST-SERVER');
    expect(JSON.stringify(body)).not.toContain('ST_M13FQBL');
  });

  it('shows device details to the admin', async () => {
    const t = await systemApp();
    const body = await systemAs(t, ADMIN);
    expect(body.server.hostname).toBe('TEST-SERVER');
    expect(body.server.osRelease).toBe('Windows 10 Home (10.0.19045)');
    expect(body.tailscale).toMatchObject({
      state: 'running',
      dnsName: 'test-server.example-tailnet.ts.net',
      peersOnline: 2,
      version: '1.104.1',
      collectedAt: '2026-10-16T10:00:00.000Z',
    });
    expect(body.physicalDisks.value).toHaveLength(3);
    expect(body.physicalDisks.collectedAt).toBe('2026-10-16T10:00:00.000Z');
    expect(body.physicalDisks.source).toBe('PowerShell Get-PhysicalDisk');
    expect(body.printer).toMatchObject({ state: 'ready', collectedAt: '2026-10-16T10:00:00.000Z' });
  });

  it('never invents a temperature', async () => {
    const t = await systemApp();
    for (const user of [ADMIN, FAMILY]) {
      const body = await systemAs(t, user);
      expect(body.temperatureC.value).toBeNull();
      expect(body.temperatureC.collectedAt).toBeNull();
      expect(body.temperatureC.reason).toBe('Датчик температуры недоступен на этом компьютере');
    }
  });

  it('reports memory, uptime and CPU with provenance, and nothing before the first measurement', async () => {
    const t = await systemApp({ collect: false });
    const before = await systemAs(t, ADMIN);
    expect(before.memory.usedBytes).toMatchObject({
      value: null,
      collectedAt: null,
      reason: 'Ещё не измерено',
    });
    expect(before.server.uptimeSeconds.value).toBeNull();
    expect(before.volumes[0]).toMatchObject({ path: 'C:\\', totalBytes: null, freeBytes: null });
    await t.app.dashboard.collector.collectAll();
    const after = await systemAs(t, ADMIN);
    expect(after.cpu).toMatchObject({ model: 'Intel(R) Core(TM) i5-6400 CPU @ 2.70GHz', cores: 4 });
    expect(after.memory).toEqual({
      totalBytes: 16_000_000_000,
      usedBytes: {
        value: 10_000_000_000,
        collectedAt: '2026-10-16T10:00:00.000Z',
        source: 'Node.js os.totalmem()/os.freemem()',
        reason: null,
      },
    });
    expect(after.server.uptimeSeconds.value).toBe(3600);
    expect(after.demo).toBe(false);
  });
});

describe('CPU sampling', () => {
  it('has no usage value until two samples exist', async () => {
    let tick = 0;
    const t = await systemApp({
      collect: false,
      probes: fakeProbes({ cpus: () => fakeCpus(1000 + tick * 1000, 3000 + tick * 1000) }),
    });
    const { collector } = t.app.dashboard;
    collector.collectCpu();
    const first = collector.snapshot('admin').cpu.usagePercent;
    expect(first).toMatchObject({ value: null, collectedAt: null, reason: 'Идёт первое измерение' });
    tick = 1;
    t.clock.advance(5000);
    collector.collectCpu();
    const second = collector.snapshot('admin').cpu.usagePercent;
    expect(second).toEqual({
      value: 50,
      collectedAt: '2026-10-16T10:00:05.000Z',
      source: 'Node.js os.cpus()',
      reason: null,
    });
  });
});

describe('volumes and low space', () => {
  const TB = 1_000_000_000_000;

  it('flags a volume under the threshold and alerts everyone', async () => {
    const t = await systemApp({
      probes: fakeProbes({ statfs: async () => ({ totalBytes: TB, freeBytes: 80_000_000_000 }) }),
    });
    const body = await systemAs(t, FAMILY);
    expect(body.volumes[0]).toMatchObject({ path: 'C:\\', lowSpace: true, reason: null });
    const alert = body.alerts.find((a) => a.id === 'volume-low-c');
    expect(alert).toMatchObject({ level: 'warning', title: 'Заканчивается место на диске C:\\' });
    expect(alert?.text).toContain('Свободно 75 ГБ (8 %)');
  });

  it('makes the alert critical under 5 % and stays quiet with enough space', async () => {
    const critical = await systemApp({
      probes: fakeProbes({ statfs: async () => ({ totalBytes: TB, freeBytes: 30_000_000_000 }) }),
    });
    expect((await systemAs(critical, ADMIN)).alerts.find((a) => a.id === 'volume-low-c')?.level).toBe(
      'critical',
    );
    const fine = await systemApp();
    const body = await systemAs(fine, ADMIN);
    expect(body.volumes[0]?.lowSpace).toBe(false);
    expect(alertIds(body).some((id) => id.startsWith('volume-low'))).toBe(false);
  });

  it('honours LOW_SPACE_PERCENT and checks several volumes', async () => {
    const t = await systemApp({
      env: { VOLUMES: 'C:\\;D:\\', LOW_SPACE_PERCENT: '60' },
      probes: fakeProbes({
        statfs: async (volume) =>
          volume === 'D:\\'
            ? { totalBytes: TB, freeBytes: 900_000_000_000 }
            : { totalBytes: TB, freeBytes: 500_000_000_000 },
      }),
    });
    const body = await systemAs(t, ADMIN);
    expect(body.volumes.map((v) => [v.path, v.lowSpace])).toEqual([
      ['C:\\', true],
      ['D:\\', false],
    ]);
  });
});

describe('alerts in the API', () => {
  it('shows the missing backup to everyone; the suspicious disk only to the admin', async () => {
    const t = await systemApp();
    const family = await systemAs(t, FAMILY);
    expect(family.backup).toMatchObject({ state: 'not_configured', restoreTested: false });
    expect(alertIds(family)).toContain('backup-not-configured');
    expect(family.alerts.find((a) => a.id === 'backup-not-configured')?.level).toBe('warning');
    expect(alertIds(family).some((id) => id.startsWith('disk-'))).toBe(false);

    const admin = await systemAs(t, ADMIN);
    expect(alertIds(admin)).toContain('backup-not-configured');
    const diskAlert = admin.alerts.find((a) => a.id.startsWith('disk-'));
    expect(diskAlert?.title).toContain('ST_M13FQBL');
    expect(diskAlert?.text).toContain('Не инициализируйте и не форматируйте');
    expect(admin.alerts.filter((a) => a.id.startsWith('disk-'))).toHaveLength(1);
  });

  it('drops the backup alert once a backup job reports success', async () => {
    const t = await systemApp({ collect: false });
    const lastSuccessAt = new Date(t.clock().getTime() - DAY).toISOString();
    await writeFile(
      path.join(t.dataDir, 'backup-status.json'),
      JSON.stringify({ lastResult: 'ok', lastSuccessAt }),
    );
    await t.app.dashboard.collector.collectAll();
    const body = await systemAs(t, FAMILY);
    expect(body.backup).toMatchObject({ state: 'ok', lastSuccessAt, restoreTested: false });
    expect(alertIds(body).some((id) => id.startsWith('backup-'))).toBe(false);
  });

  it('tells everyone that remote access is down when Tailscale reports NoState', async () => {
    const t = await systemApp({
      probes: fakeProbes({ tailscaleStatus: async () => readFixture('tailscale-nostate.json') }),
    });
    const body = await systemAs(t, FAMILY);
    expect(body.tailscale).toMatchObject({ state: 'stopped', reason: TAILSCALE_REASON.noState });
    const alert = body.alerts.find((a) => a.id === 'tailscale-not-running');
    expect(alert?.title).toBe('Удалённый доступ не работает');
    expect(alert?.text).toContain('из других стран');
  });

  it('reports a missing Tailscale CLI as not_installed with the alert', async () => {
    const t = await systemApp({
      probes: fakeProbes({
        tailscaleStatus: async () => {
          throw new ProbeError('not_installed', TAILSCALE_REASON.notInstalled);
        },
      }),
    });
    const body = await systemAs(t, ADMIN);
    expect(body.tailscale).toMatchObject({ state: 'not_installed', reason: TAILSCALE_REASON.notInstalled });
    expect(alertIds(body)).toContain('tailscale-not-running');
  });
});

describe('probe failures', () => {
  it('cuts a hung probe at its timeout: nulls with a reason, the rest still answers 200', async () => {
    const t = await systemApp({
      collect: false,
      probeTimeouts: { powershell: 100, tailscale: 100, statfs: 100 },
      probes: fakeProbes({
        physicalDisks: NEVER,
        printers: NEVER,
        tailscaleStatus: NEVER,
        statfs: NEVER,
      }),
    });
    const started = Date.now();
    await t.app.dashboard.collector.collectAll();
    expect(Date.now() - started).toBeLessThan(5000);

    const body = await systemAs(t, ADMIN);
    expect(body.physicalDisks).toMatchObject({ value: null, collectedAt: null });
    expect(body.physicalDisks.reason).toBe('Проверка не завершилась за 0,1 с');
    expect(body.printer).toMatchObject({ state: 'unknown', collectedAt: null });
    expect(body.printer.message).toBe('Состояние принтера неизвестно: проверка не завершилась за 0,1 с');
    expect(body.tailscale).toMatchObject({ state: 'unknown', collectedAt: null, version: null });
    expect(body.tailscale.reason).toContain('не завершилась');
    expect(body.volumes[0]).toMatchObject({ totalBytes: null, freeBytes: null, lowSpace: false });
    expect(body.volumes[0]?.reason).toContain('не завершилась');
    // Everything else is still measured.
    expect(body.memory.usedBytes.value).toBe(10_000_000_000);
    expect(body.server.uptimeSeconds.value).toBe(3600);
    // An unanswered probe is not proof of an outage.
    expect(alertIds(body)).not.toContain('tailscale-not-running');
  });

  it('turns a failing probe into nulls with a Russian reason and never leaks the raw error', async () => {
    const t = await systemApp({
      probes: fakeProbes({
        physicalDisks: async () => {
          throw new Error('internal stack detail C:\\secret');
        },
        printers: async () => {
          throw new ProbeError('failed', 'Не удалось получить данные от Windows');
        },
        tailscaleStatus: async () => {
          throw new Error('spawn EPERM internal');
        },
        statfs: async () => {
          throw new Error('EACCES internal');
        },
      }),
    });
    const res = await t.app.inject({
      url: '/api/system',
      headers: { cookie: await cookieFor(t.app, ADMIN) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('internal');
    const body = res.json() as SystemResponse;
    expect(body.physicalDisks).toMatchObject({
      value: null,
      reason: 'Не удалось получить данные о дисках от Windows',
    });
    expect(body.printer).toMatchObject({
      state: 'unknown',
      message: 'Состояние принтера неизвестно: не удалось получить данные от Windows',
    });
    expect(body.tailscale).toMatchObject({
      state: 'unknown',
      reason: 'Не удалось получить состояние Tailscale',
    });
    expect(body.volumes[0]).toMatchObject({
      freeBytes: null,
      reason: 'Не удалось прочитать свободное место на C:\\',
    });
    expect(alertIds(body)).not.toContain('tailscale-not-running');
    expect(alertIds(body).some((id) => id.startsWith('disk-'))).toBe(false);
  });

  it('serves /api/system from the cache: client polling never runs probes', async () => {
    let calls = 0;
    const t = await systemApp({
      probes: fakeProbes({
        physicalDisks: async () => {
          calls += 1;
          return readFixture('physical-disks.json');
        },
      }),
    });
    expect(calls).toBe(1);
    const cookie = await cookieFor(t.app, ADMIN);
    for (let i = 0; i < 5; i += 1) {
      expect((await t.app.inject({ url: '/api/system', headers: { cookie } })).statusCode).toBe(200);
    }
    expect(calls).toBe(1);
  });
});
