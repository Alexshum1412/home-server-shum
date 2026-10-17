import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Alert, BackupInfo, SystemResponse, TailscaleInfo } from '../../shared/api.ts';
import { alertsForRole, buildAlerts, overallHealth } from '../src/system/alerts.ts';
import { readPrograms } from '../src/system/programs.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, makeTempDir, removeDir } from './helpers.ts';

const NOW = new Date('2026-10-17T03:00:00.000Z');
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeDir(d);
});

async function stateFile(content: unknown): Promise<string> {
  const dir = await makeTempDir('fd-prog-');
  dirs.push(dir);
  await mkdir(path.join(dir, 'run'), { recursive: true });
  await writeFile(path.join(dir, 'run', 'supervisor.json'), JSON.stringify(content));
  return dir;
}

const OK_BACKUP: BackupInfo = {
  state: 'ok',
  lastSuccessAt: NOW.toISOString(),
  restoreTested: true,
  message: 'ok',
};
const TS_OK = { state: 'running' } as TailscaleInfo;

function alerts(programs: Parameters<typeof buildAlerts>[0]['programs']) {
  return buildAlerts({
    backup: OK_BACKUP,
    volumes: [],
    disks: [],
    tailscale: TS_OK,
    servicesConfigError: null,
    programs,
  });
}

describe('supervisor programs', () => {
  it('trusts run/supervisor.json only while the supervisor process is alive', async () => {
    const content = {
      pid: process.pid,
      apps: [
        { name: 'dashboard', title: 'Портал', state: 'running', restarts: 0, startedAt: NOW.toISOString() },
        { name: 'jellyfin', title: 'Кинотеатр (Jellyfin)', state: 'weird', restarts: 2 },
      ],
    };
    const dir = await stateFile(content);
    const live = await readPrograms(dir, NOW);
    expect(live.value).toEqual([
      { name: 'dashboard', title: 'Портал', state: 'running', restarts: 0, startedAt: NOW.toISOString() },
      { name: 'jellyfin', title: 'Кинотеатр (Jellyfin)', state: 'unknown', restarts: 2, startedAt: null },
    ]);
    const dead = await readPrograms(dir, NOW, () => false);
    expect(dead.value).toBeNull();
    expect(dead.reason).toMatch(/Супервизор не запущен/);
    const empty = await makeTempDir('fd-prog-');
    dirs.push(empty);
    expect((await readPrograms(empty, NOW)).value).toBeNull();
  });

  it('raises the right alerts: crash for everyone, stop/instability/no supervisor for the admin', () => {
    const list = alerts({
      value: [
        { name: 'jellyfin', title: 'Кинотеатр (Jellyfin)', state: 'backoff', restarts: 4, startedAt: null },
        { name: 'x', title: 'Икс', state: 'stopped', restarts: 0, startedAt: null },
        { name: 'dashboard', title: 'Портал', state: 'running', restarts: 3, startedAt: null },
      ],
      collectedAt: NOW.toISOString(),
      source: 'test',
      reason: null,
    });
    const crash = list.find((a) => a.id === 'program-crash-jellyfin');
    expect(crash).toMatchObject({ level: 'critical', audience: 'all' });
    expect(list.find((a) => a.id === 'program-stopped-x')).toMatchObject({
      level: 'warning',
      audience: 'admin',
    });
    expect(list.find((a) => a.id === 'program-unstable-dashboard')).toMatchObject({ audience: 'admin' });
    const family = alertsForRole(list, 'family');
    expect(family.map((a) => a.id)).toEqual(['program-crash-jellyfin']);
    expect(family[0]?.text).not.toMatch(/supervisor\.log/);
    expect(alertsForRole(list, 'admin').find((a) => a.id === 'program-crash-jellyfin')?.text).toMatch(
      /Сбоев.*4/,
    );

    const none = alerts({
      value: null,
      collectedAt: NOW.toISOString(),
      source: 'test',
      reason: 'Супервизор не запущен: x',
    });
    expect(none.find((a) => a.id === 'supervisor-not-running')).toMatchObject({ audience: 'admin' });
    // Before the first read there is no evidence: no alert.
    expect(alerts(undefined).some((a) => a.id === 'supervisor-not-running')).toBe(false);
  });

  it('summarises four levels: ok, warning, error, unknown', () => {
    const w: Alert = { id: 'w', level: 'warning', title: 't', text: 't' };
    const c: Alert = { id: 'c', level: 'critical', title: 't', text: 't' };
    expect(overallHealth([], true)).toEqual({ level: 'ok', text: 'Всё работает' });
    expect(overallHealth([w], true).level).toBe('warning');
    expect(overallHealth([w, c], true).level).toBe('error');
    expect(overallHealth([], false).level).toBe('unknown');
  });
});

describe('GET /api/system with programs', () => {
  it('returns the programs and an overall level for each audience', async () => {
    const t = await createTestApp();
    dirs.push(t.dataDir);
    try {
      await addUser(t.dataDir, t.clock, ADMIN);
      await addUser(t.dataDir, t.clock, FAMILY);
      await mkdir(path.join(t.dataDir, 'run'), { recursive: true });
      await writeFile(
        path.join(t.dataDir, 'run', 'supervisor.json'),
        JSON.stringify({
          pid: process.pid,
          apps: [{ name: 'jellyfin', title: 'Кинотеатр', state: 'backoff', restarts: 1 }],
        }),
      );
      // Background timers are off in tests: collect once by hand.
      await t.app.dashboard.collector.collectAll();
      const body = (await (
        await t.app.inject({ url: '/api/system', headers: { cookie: await cookieFor(t.app, FAMILY) } })
      ).json()) as SystemResponse;
      expect(body.programs.value?.[0]).toMatchObject({ name: 'jellyfin', state: 'backoff' });
      expect(body.overall.level).toBe('error');
      expect(body.alerts.map((a) => a.id)).toContain('program-crash-jellyfin');
    } finally {
      await t.app.close();
    }
  });
});
