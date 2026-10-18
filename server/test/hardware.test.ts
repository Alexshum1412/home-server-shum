import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Alert, MetricsHistoryResponse, SystemResponse } from '../../shared/api.ts';
import type { StoredUser } from '../src/auth/users.ts';
import { createAlertWatcher } from '../src/system/alert-watcher.ts';
import { buildAlerts } from '../src/system/alerts.ts';
import { createCpuSampler } from '../src/system/cpu.ts';
import {
  createHardwareMonitor,
  parseDiskReliability,
  parseLiveReading,
  parseNvidiaSmi,
  parseSensorTree,
} from '../src/system/hardware.ts';
import { createMetricsHistory } from '../src/system/history.ts';
import { ProbeError } from '../src/system/powershell.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createFakeClock,
  createTestApp,
  FAMILY,
  makeTempDir,
  removeDir,
  type TestApp,
} from './helpers.ts';

describe('video card', () => {
  it('reads nvidia-smi and turns «not available» into «no value»', () => {
    const gpus = parseNvidiaSmi(
      'NVIDIA GeForce GTX 960, 31, 1194, 2048, 39, 18.98, 0, 560.94\nNVIDIA Test, [N/A], [N/A], 4096, [N/A], [Not Supported], [N/A], 1.0\n',
    );
    expect(gpus[0]).toEqual({
      name: 'NVIDIA GeForce GTX 960',
      loadPercent: 31,
      memoryUsedBytes: 1194 * 1024 * 1024,
      memoryTotalBytes: 2048 * 1024 * 1024,
      temperatureC: 39,
      powerWatts: 18.98,
      fanPercent: 0,
      driver: '560.94',
    });
    expect(gpus[1]).toMatchObject({
      loadPercent: null,
      memoryUsedBytes: null,
      temperatureC: null,
      powerWatts: null,
    });
    expect(parseNvidiaSmi('')).toEqual([]);
    expect(parseNvidiaSmi('garbage line')).toEqual([]);
  });
});

describe('processor clock, network and board temperature', () => {
  it('parses one PowerShell reading', () => {
    const live = parseLiveReading({
      currentMhz: 2712,
      maxMhz: 3300,
      adapters: [
        { name: 'Ethernet', description: 'Realtek', hardware: true, speedBps: 1e9, rx: 100, tx: 50 },
        { name: 'Tailscale', description: 'Tunnel', hardware: false, speedBps: 1e11, rx: 1, tx: 2 },
      ],
      thermal: [
        { name: 'TZ00', deciKelvin: 3010 },
        { name: 'bad', deciKelvin: 0 },
        { name: 'hot', deciKelvin: 3231 },
      ],
    });
    expect(live.clock).toEqual({ currentMhz: 2712, maxMhz: 3300 });
    expect(live.adapters[0]).toMatchObject({ name: 'Ethernet', physical: true, linkSpeedMbps: 1000 });
    expect(live.adapters[1]?.physical).toBe(false);
    expect(live.boardTemperatureC).toBe(50); // the hottest believable zone
  });

  it('refuses numbers that cannot be real', () => {
    expect(
      parseLiveReading({ currentMhz: 0, maxMhz: 0, adapters: [], thermal: [{ deciKelvin: 99999 }] }),
    ).toEqual({
      clock: null,
      adapters: [],
      boardTemperatureC: null,
    });
    expect(parseLiveReading(null)).toEqual({ clock: null, adapters: [], boardTemperatureC: null });
  });
});

describe('drive counters', () => {
  it('keeps what a drive says, treats 0 as «no sensor» and explains a bad counter', () => {
    const [ok, hot, silent] = parseDiskReliability([
      { model: 'ST2000', temperature: 29, wear: 0, readErrors: 0, writeErrors: null, hours: 9372 },
      { model: 'SSD', temperature: 61, wear: 93, readErrors: 4, writeErrors: 0, hours: 100 },
      { model: 'USB Flash Drive', temperature: 0, wear: 0, readErrors: null, writeErrors: null, hours: null },
    ]);
    expect(ok).toMatchObject({ temperatureC: 29, wearPercent: null, powerOnHours: 9372, note: null });
    expect(hot?.note).toMatch(/61 °C.*износ 93 %.*ошибок чтения: 4/);
    expect(silent).toMatchObject({ temperatureC: null, wearPercent: null });
    expect(parseDiskReliability({ model: 'one' })).toHaveLength(1); // a single object, not a list
  });
});

describe('sensor program', () => {
  const tree = (cpuLabel: string, cpuValue: string) => ({
    Text: 'Sensor',
    Children: [
      {
        Text: 'PC',
        Children: [
          {
            Text: 'Intel Core i5-6400',
            Children: [
              {
                Text: 'Temperatures',
                Children: [
                  { Text: cpuLabel, Value: cpuValue },
                  { Text: 'Core #2', Value: '58,0 °C' },
                ],
              },
              { Text: 'Load', Children: [{ Text: 'CPU Total', Value: '12,0 %' }] },
            ],
          },
          {
            Text: 'NVIDIA GeForce GTX 960',
            Children: [{ Text: 'Temperatures', Children: [{ Text: 'GPU Core', Value: '41,0 °C' }] }],
          },
        ],
      },
    ],
  });

  it('takes the processor package, else the hottest core, and the video card core', () => {
    expect(parseSensorTree(tree('CPU Package', '47,0 °C'))).toEqual({ cpuC: 47, gpuC: 41 });
    expect(parseSensorTree(tree('Core #1', '52,0 °C'))).toEqual({ cpuC: 58, gpuC: 41 });
  });

  it('does not mistake a load or a fan for a temperature', () => {
    expect(parseSensorTree({ Text: 'x', Children: [{ Text: 'CPU Total', Value: '90,0 %' }] })).toEqual({
      cpuC: null,
      gpuC: null,
    });
    expect(parseSensorTree('nonsense')).toEqual({ cpuC: null, gpuC: null });
  });
});

describe('per-core load', () => {
  it('measures every core between two samples', () => {
    const sampler = createCpuSampler();
    const core = (user: number, idle: number) => ({
      model: 'x',
      speed: 1,
      times: { user, nice: 0, sys: 0, idle, irq: 0 },
    });
    sampler.sample([core(0, 0), core(0, 0)], new Date(0));
    expect(sampler.cores().value).toBeNull();
    sampler.sample([core(50, 50), core(10, 90)], new Date(1000));
    expect(sampler.cores().value).toEqual([50, 10]);
  });
});

describe('hardware monitor', () => {
  it('computes network speed between two readings and says why a value is missing', async () => {
    const clock = createFakeClock();
    let rx = 1000;
    const monitor = createHardwareMonitor({
      config: { hwMonitorUrl: null },
      clock,
      timeoutMs: 1000,
      probes: {
        hardwareLive: async () => ({
          currentMhz: 2700,
          maxMhz: 2700,
          adapters: [
            { name: 'Ethernet', description: 'Realtek', hardware: true, speedBps: 1e9, rx, tx: 500 },
          ],
          thermal: [],
        }),
        gpu: async () => {
          throw new ProbeError('not_installed', 'Драйвер NVIDIA (nvidia-smi) не найден');
        },
      },
    });
    await monitor.collectLive();
    expect(
      monitor.snapshot({ value: null, collectedAt: null, source: '', reason: 'x' }).network.value?.[0]
        ?.rxBytesPerSec,
    ).toBeNull();
    clock.advance(10_000);
    rx = 21_000;
    await monitor.collectLive();
    const info = monitor.snapshot({ value: [10], collectedAt: null, source: '', reason: null });
    expect(info.network.value?.[0]).toMatchObject({ rxBytesPerSec: 2000, txBytesPerSec: 0 });
    expect(info.gpu).toMatchObject({ value: null, reason: 'Драйвер NVIDIA (nvidia-smi) не найден' });
    expect(info.cpuTemperatureC.value).toBeNull();
    expect(info.cpuTemperatureC.reason).toMatch(/LibreHardwareMonitor/);
    expect(info.boardTemperatureC.reason).toMatch(/недоступен/);
    expect(monitor.latest().rx).toBe(2000);
  });

  it('shows no speed after a counter reset instead of a huge negative number', async () => {
    const clock = createFakeClock();
    let rx = 5_000_000;
    const monitor = createHardwareMonitor({
      config: { hwMonitorUrl: null },
      clock,
      timeoutMs: 1000,
      probes: {
        hardwareLive: async () => ({
          currentMhz: 1,
          maxMhz: 1,
          adapters: [{ name: 'Wi-Fi', description: 'x', hardware: true, speedBps: 1e8, rx, tx: 1 }],
          thermal: [],
        }),
      },
    });
    await monitor.collectLive();
    clock.advance(5000);
    rx = 10;
    await monitor.collectLive();
    expect(
      monitor.snapshot({ value: null, collectedAt: null, source: '', reason: '' }).network.value?.[0]
        ?.rxBytesPerSec,
    ).toBeNull();
  });
});

describe('history', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('fd-hist-');
  });
  afterEach(() => removeDir(dir));

  const point = (t: number, cpu: number | null = 10) => ({
    t,
    cpu,
    memory: 40,
    gpu: null,
    cpuTemp: null,
    gpuTemp: null,
    rxBytesPerSec: null,
    txBytesPerSec: null,
  });

  it('keeps a day, forgets older readings, survives a restart and thins what it returns', async () => {
    let now = 100_000_000;
    const history = createMetricsHistory({ dataDir: dir, now: () => now });
    for (let i = 0; i < 100; i++) history.record(point(now / 1000 + i * 60));
    now += 100 * 60_000;
    expect(history.points(10).length).toBeLessThanOrEqual(11);
    expect(history.points(500)).toHaveLength(100);
    await history.flush();
    const again = createMetricsHistory({ dataDir: dir, now: () => now });
    await again.load();
    expect(again.points(500)).toHaveLength(100);
    now += 25 * 60 * 60 * 1000;
    expect(again.points(500)).toHaveLength(0); // all older than a day
  });

  it('ignores a reading from a clock that went back and a broken file', async () => {
    const history = createMetricsHistory({ dataDir: dir, now: () => 5_000_000 });
    history.record(point(5000));
    history.record(point(4000));
    expect(history.points().map((p) => p.t)).toEqual([5000]);
    const messages: string[] = [];
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'metrics-history.json'), '{ not json');
    const broken = createMetricsHistory({
      dataDir: dir,
      now: () => 5_000_000,
      onError: (m) => messages.push(m),
    });
    await broken.load();
    expect(broken.points()).toEqual([]);
    expect(messages).toHaveLength(1);
  });
});

describe('alerts from the hardware', () => {
  const base = {
    backup: { state: 'ok' as const, lastSuccessAt: null, restoreTested: true, message: '' },
    volumes: [],
    disks: null,
    tailscale: {
      state: 'running' as const,
      dnsName: null,
      peersOnline: null,
      version: null,
      collectedAt: null,
      reason: null,
    },
    servicesConfigError: null,
  };

  it('warns about heat only when a sensor says so', () => {
    expect(
      buildAlerts({ ...base, hardware: { cpuTemperatureC: null, gpuTemperatureC: null, reliability: null } }),
    ).toEqual([]);
    const alerts = buildAlerts({
      ...base,
      hardware: { cpuTemperatureC: 92, gpuTemperatureC: 101, reliability: null },
    });
    expect(alerts.map((a) => [a.id, a.level, a.audience])).toEqual([
      ['cpu-hot', 'warning', 'admin'],
      ['gpu-hot', 'critical', 'admin'],
    ]);
  });

  it('warns about a drive that reports errors', () => {
    const alerts = buildAlerts({
      ...base,
      hardware: {
        cpuTemperatureC: null,
        gpuTemperatureC: null,
        reliability: [
          {
            model: 'Fine',
            temperatureC: 30,
            wearPercent: null,
            readErrors: 0,
            writeErrors: 0,
            powerOnHours: 1,
            note: null,
          },
          {
            model: 'Bad',
            temperatureC: 30,
            wearPercent: null,
            readErrors: 5,
            writeErrors: 0,
            powerOnHours: 1,
            note: 'Диск сообщает: ошибок чтения: 5.',
          },
        ],
      },
    });
    expect(alerts.map((a) => a.id)).toEqual(['disk-smart-1']);
  });
});

describe('alert watcher', () => {
  const admin = { id: 'a1', role: 'admin' } as StoredUser;
  const family = { id: 'f1', role: 'family' } as StoredUser;
  const alert = (id: string, level: Alert['level'] = 'warning'): Alert => ({
    id,
    level,
    title: `T ${id}`,
    text: 'text',
  });

  it('announces a problem once, after it was seen twice, only to administrators', async () => {
    const sent: Array<{ users: readonly string[]; kind: string; key?: string }> = [];
    let now = 0;
    let current = [alert('volume-low-c')];
    const watcher = createAlertWatcher({
      alerts: () => current,
      admins: async () => [admin, family],
      notify: async (input) => {
        sent.push(input);
      },
      now: () => now,
    });
    await watcher.tick();
    expect(sent).toHaveLength(0); // seen once: maybe a slow probe
    await watcher.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ users: ['a1'], kind: 'disk', key: 'alert:volume-low-c' });
    await watcher.tick();
    expect(sent).toHaveLength(1); // not again every minute
    now += 25 * 60 * 60 * 1000;
    await watcher.tick();
    expect(sent).toHaveLength(2); // a reminder after a day
    current = [];
    await watcher.tick();
    current = [alert('volume-low-c')];
    await watcher.tick();
    await watcher.tick();
    expect(sent).toHaveLength(3); // gone and back: announced again
  });

  it('maps problems to the notification kinds and ignores information', async () => {
    const kinds: string[] = [];
    const watcher = createAlertWatcher({
      alerts: () => [
        alert('backup-failed', 'critical'),
        alert('program-crash-jellyfin'),
        alert('cpu-hot'),
        alert('note', 'info'),
      ],
      admins: async () => [admin],
      notify: async (input) => {
        kinds.push(input.kind);
      },
      now: () => 0,
    });
    await watcher.tick();
    await watcher.tick();
    expect(kinds).toEqual(['backup', 'service', 'system']);
  });
});

describe('GET /api/system with hardware', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await addUser(t.dataDir, t.clock, ADMIN);
    await addUser(t.dataDir, t.clock, FAMILY);
    await t.app.dashboard.collector.collectAll();
  });
  afterEach(async () => {
    await t.app.close();
    await removeDir(t.dataDir);
  });

  it('shows the details to the administrator only, with a reason for what it cannot measure', async () => {
    const adminCookie = await cookieFor(t.app, ADMIN);
    const familyCookie = await cookieFor(t.app, FAMILY);
    const admin = (
      await t.app.inject({ url: '/api/system', headers: { cookie: adminCookie } })
    ).json<SystemResponse>();
    expect(admin.hardware).not.toBeNull();
    expect(admin.hardware?.gpu.value).toBeNull();
    expect(admin.hardware?.gpu.reason).toBeTruthy();
    const family = (
      await t.app.inject({ url: '/api/system', headers: { cookie: familyCookie } })
    ).json<SystemResponse>();
    expect(family.hardware).toBeNull();
    expect(
      (await t.app.inject({ url: '/api/system/history', headers: { cookie: familyCookie } })).statusCode,
    ).toBe(403);
    const history = (
      await t.app.inject({ url: '/api/system/history', headers: { cookie: adminCookie } })
    ).json<MetricsHistoryResponse>();
    expect(history.intervalSec).toBe(60);
    expect(Array.isArray(history.points)).toBe(true);
  });
});
