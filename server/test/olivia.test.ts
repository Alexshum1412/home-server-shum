import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OliviaResponse, SystemResponse } from '../../shared/api.ts';
import { diagnose } from '../src/olivia/rules.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, removeDir, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-17T03:00:00.000Z');
const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps.splice(0)) {
    await t.app.close();
    await removeDir(t.dataDir);
  }
});

function system(overrides: Partial<SystemResponse> = {}): SystemResponse {
  return {
    generatedAt: NOW.toISOString(),
    demo: false,
    server: {
      version: '1',
      startedAt: NOW.toISOString(),
      hostname: 'X',
      osRelease: null,
      uptimeSeconds: { value: 1, collectedAt: null, source: '', reason: null },
    },
    cpu: { model: 'cpu', cores: 4, usagePercent: { value: 5, collectedAt: null, source: '', reason: null } },
    memory: { totalBytes: 16e9, usedBytes: { value: 6e9, collectedAt: null, source: '', reason: null } },
    temperatureC: { value: null, collectedAt: null, source: '', reason: 'нет' },
    hardware: null,
    volumes: [],
    physicalDisks: { value: [], collectedAt: null, source: '', reason: null },
    tailscale: {
      state: 'running',
      dnsName: null,
      peersOnline: null,
      version: null,
      reason: null,
      collectedAt: null,
    } as SystemResponse['tailscale'],
    printer: { name: null, state: 'ready', message: '', collectedAt: null } as SystemResponse['printer'],
    backup: { state: 'ok', lastSuccessAt: NOW.toISOString(), restoreTested: true, message: 'ok' },
    programs: {
      value: [{ name: 'jellyfin', title: 'Кинотеатр', state: 'running', restarts: 0, startedAt: null }],
      collectedAt: null,
      source: '',
      reason: null,
    },
    overall: { level: 'ok', text: '' },
    alerts: [],
    ...overrides,
  };
}

const jf = (state: string, restarts = 0) =>
  ({
    value: [{ name: 'jellyfin', title: 'Кинотеатр', state, restarts, startedAt: null }],
    collectedAt: null,
    source: '',
    reason: null,
  }) as SystemResponse['programs'];

describe('Оливия rules', () => {
  const run = (s: SystemResponse, audit: { time: string; action: string }[] = []) =>
    diagnose({
      system: s,
      services: [],
      audit: audit.map((a) => ({ ...a, actor: null, ip: null, detail: null })),
      now: NOW,
      backupRunning: false,
    });

  it('says all is well when nothing is wrong', () => {
    expect(run(system()).map((f) => f.id)).toEqual(['all-good']);
  });

  it('turns measured problems into findings with only fixed, safe actions', () => {
    expect(run(system({ programs: jf('backoff', 5) }))[0]).toMatchObject({
      id: 'jellyfin-crash',
      level: 'error',
      action: 'restart-jellyfin',
    });
    expect(run(system({ programs: jf('stopped') }))[0]).toMatchObject({ action: 'start-jellyfin' });
    const failed = run(
      system({
        backup: {
          state: 'failed',
          lastSuccessAt: null,
          restoreTested: false,
          message: 'Флешка не подключена',
        },
      }),
    );
    expect(failed[0]).toMatchObject({ id: 'backup-failed', action: 'run-backup' });
    const lowSpace = run(
      system({
        volumes: [
          { path: 'C:\\', totalBytes: 1, freeBytes: 0, lowSpace: true } as SystemResponse['volumes'][number],
        ],
      }),
    );
    // Space is never freed automatically: no action, only advice.
    expect(lowSpace[0]).toMatchObject({ action: null });
    expect(lowSpace[0]?.suggestion).toMatch(/ничего не удаляет/);
    const many = Array.from({ length: 20 }, () => ({
      time: '2026-10-17T01:00:00.000Z',
      action: 'login.failure',
    }));
    expect(run(system(), many).map((f) => f.id)).toContain('logins');
    const old = Array.from({ length: 30 }, () => ({
      time: '2026-10-10T01:00:00.000Z',
      action: 'login.failure',
    }));
    expect(run(system(), old).map((f) => f.id)).toEqual(['all-good']);
    expect(
      run(system({ programs: { value: null, collectedAt: null, source: '', reason: 'нет' } }))[0]?.id,
    ).toBe('supervisor');
  });
});

async function app(env: Record<string, string> = {}, sent: Array<{ cmd: string; app?: string }> = []) {
  const t = await createTestApp({
    env,
    oliviaActionDeps: {
      send: async (_pipe, command) => {
        sent.push(command as { cmd: string; app?: string });
        return { ok: true };
      },
      startBackup: async () => {
        sent.push({ cmd: 'backup' });
      },
    },
  });
  apps.push(t);
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
  await mkdir(path.join(t.dataDir, 'run'), { recursive: true });
  await writeFile(
    path.join(t.dataDir, 'run', 'supervisor.json'),
    JSON.stringify({
      pid: process.pid,
      apps: [{ name: 'jellyfin', title: 'Кинотеатр', state: 'running', restarts: 0 }],
    }),
  );
  await t.app.dashboard.collector.collectAll();
  return { t, admin: await cookieFor(t.app, ADMIN), family: await cookieFor(t.app, FAMILY) };
}

describe('Оливия API', () => {
  it('is for admins only and lists findings and actions', async () => {
    const { t, admin, family } = await app();
    expect((await t.app.inject({ url: '/api/admin/olivia', headers: { cookie: family } })).statusCode).toBe(
      403,
    );
    const body = (
      await t.app.inject({ url: '/api/admin/olivia', headers: { cookie: admin } })
    ).json() as OliviaResponse;
    expect(body.findings.length).toBeGreaterThan(0);
    expect(body.actions.map((a) => a.id).sort()).toEqual([
      'recheck-services',
      'restart-jellyfin',
      'run-backup',
      'start-jellyfin',
    ]);
    expect(body.actions.find((a) => a.id === 'start-jellyfin')).toMatchObject({
      allowed: false,
      reason: 'Кинотеатр не остановлен',
    });
  });

  it('runs only listed actions, only confirmed, only when they apply, once per half minute, and logs them', async () => {
    const sent: Array<{ cmd: string; app?: string }> = [];
    const { t, admin, family } = await app({}, sent);
    const post = (id: string, payload: object, cookie = admin) =>
      t.app.inject({
        method: 'POST',
        url: `/api/admin/olivia/actions/${encodeURIComponent(id)}`,
        headers: { cookie },
        payload,
      });
    expect((await post('restart-jellyfin', { confirm: true }, family)).statusCode).toBe(403);
    expect((await post('restart-jellyfin', {})).statusCode).toBe(400);
    expect((await post('restart-jellyfin', { confirm: 'yes' })).statusCode).toBe(400);
    for (const bad of ['format-disk', 'restart-jellyfin;calc', '../../run', '__proto__', 'constructor']) {
      expect((await post(bad, { confirm: true })).statusCode, bad).toBe(404);
    }
    expect((await post('start-jellyfin', { confirm: true })).statusCode).toBe(409);
    const ok = await post('restart-jellyfin', { confirm: true });
    expect(ok.json()).toMatchObject({ ok: true });
    expect(sent).toEqual([{ cmd: 'restart', app: 'jellyfin' }]);
    expect((await post('restart-jellyfin', { confirm: true })).statusCode).toBe(429);
    expect((await post('run-backup', { confirm: true })).json()).toMatchObject({ ok: true });
    expect(sent.at(-1)).toEqual({ cmd: 'backup' });
    const audit = await t.app.inject({ url: '/api/admin/audit?limit=50', headers: { cookie: admin } });
    const details = (audit.json().entries as Array<{ action: string; detail: string }>)
      .filter((e) => e.action === 'olivia.action')
      .map((e) => e.detail);
    expect(details.some((d) => d.startsWith('restart-jellyfin: Кинотеатр перезапущен'))).toBe(true);
    expect(details.some((d) => d.startsWith('start-jellyfin: отказано'))).toBe(true);
  });

  it('switches off completely with OLIVIA_ENABLED=0 while monitoring keeps working', async () => {
    const { t, admin } = await app({ OLIVIA_ENABLED: '0' });
    expect((await t.app.inject({ url: '/api/admin/olivia', headers: { cookie: admin } })).statusCode).toBe(
      404,
    );
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/admin/olivia/actions/run-backup',
          headers: { cookie: admin },
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(404);
    const sys = await t.app.inject({ url: '/api/system', headers: { cookie: admin } });
    expect(sys.statusCode).toBe(200);
    expect((sys.json() as SystemResponse).overall.level).toBeDefined();
  });
});
