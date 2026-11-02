import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditResponse, NotificationsResponse, SystemResponse } from '../../shared/api.ts';
import type {
  ServerActionResponse,
  ServerPageResponse,
  ServerReportResponse,
} from '../../shared/server-page.ts';
import type { ServerPageDeps } from '../src/admin/server-page.ts';
import { ACTION_GAP_MS } from '../src/admin/server-page.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, removeDir, type TestApp } from './helpers.ts';

const SECRET = 'CANARY-pass-7781';
const CHAT_TEXT = 'секретная переписка семьи';

let t: TestApp;
afterEach(async () => {
  await t.app.close();
  await removeDir(t.dataDir);
});

function snapshot(supervisor: boolean): SystemResponse {
  const programs = supervisor
    ? {
        collectedAt: '2026-10-16T10:00:00.000Z',
        source: 'test',
        reason: null,
        value: [
          {
            name: 'dashboard',
            title: 'Портал',
            state: 'running',
            restarts: 0,
            startedAt: '2026-10-16T09:00:00.000Z',
          },
          {
            name: 'jellyfin',
            title: 'Кинотеатр',
            state: 'running',
            restarts: 2,
            startedAt: '2026-10-16T09:30:00.000Z',
          },
          { name: 'aria2', title: 'Торренты', state: 'stopped', restarts: 0, startedAt: null },
        ],
      }
    : {
        collectedAt: '2026-10-16T10:00:00.000Z',
        source: 'test',
        value: null,
        reason: 'Супервизор не запущен: автоматический перезапуск не работает',
      };
  return {
    generatedAt: '2026-10-16T10:00:00.000Z',
    demo: false,
    server: {
      version: 't',
      startedAt: '2026-10-16T09:00:00.000Z',
      hostname: 'SERVER-HOME',
      osRelease: 'Windows test',
      uptimeSeconds: { value: 1, collectedAt: null, source: '', reason: null },
    },
    volumes: [
      {
        path: 'C:\\',
        totalBytes: 200 * 1024 ** 3,
        freeBytes: 80 * 1024 ** 3,
        collectedAt: null,
        reason: null,
        lowSpace: false,
      },
    ],
    backup: {
      state: 'ok',
      lastSuccessAt: '2026-10-16T03:30:00.000Z',
      restoreTested: true,
      message: 'Копия сделана ночью.',
    },
    programs,
    alerts: [],
  } as unknown as SystemResponse;
}

interface Calls {
  sent: Array<{ cmd: string; app?: string }>;
  later: Array<() => void>;
  backups: number;
  rechecks: number;
}

async function setup(options: { supervisor?: boolean; backupRunning?: boolean } = {}) {
  const calls: Calls = { sent: [], later: [], backups: 0, rechecks: 0 };
  const deps: Partial<ServerPageDeps> = {
    snapshot: () => snapshot(options.supervisor ?? true),
    send: (async (_pipe: string, command: { cmd: string; app?: string }) => {
      calls.sent.push(command);
      return { ok: true };
    }) as ServerPageDeps['send'],
    later: (work) => calls.later.push(work),
    backupRunning: async () => options.backupRunning ?? false,
    startBackup: async () => {
      calls.backups += 1;
    },
    recheckServices: async () => {
      calls.rechecks += 1;
    },
  };
  t = await createTestApp({ serverPageDeps: deps });
  const papa = await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
  return { calls, papa, admin: await cookieFor(t.app, ADMIN), mama: await cookieFor(t.app, FAMILY) };
}

const post = (cookie: string, payload: unknown) =>
  t.app.inject({
    method: 'POST',
    url: '/api/admin/server/action',
    headers: { cookie },
    payload: payload as object,
  });
const get = (cookie: string, url = '/api/admin/server') => t.app.inject({ url, headers: { cookie } });

describe('the «Сервер» page: who may use it', () => {
  it('is closed to a family member and to a stranger, on every route', async () => {
    const { mama } = await setup();
    for (const url of ['/api/admin/server', '/api/admin/server/report']) {
      expect((await get(mama, url)).statusCode, url).toBe(403);
      expect((await t.app.inject({ url })).statusCode, url).toBe(401);
    }
    expect((await post(mama, { action: 'restart', program: 'jellyfin', confirm: true })).statusCode).toBe(
      403,
    );
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/admin/server/action',
          payload: { action: 'recheck' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('is not offered through the public address either', async () => {
    const { admin } = await setup();
    const res = await t.app.inject({ url: '/api/admin/server', headers: { cookie: admin, 'cf-ray': 'abc' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('the «Сервер» page: what it shows', () => {
  it('lists the four programs with their state, the last start and the restarts', async () => {
    const { admin } = await setup();
    const page = (await get(admin)).json() as ServerPageResponse;
    expect(page.supervisor.running).toBe(true);
    const byId = Object.fromEntries(page.programs.map((program) => [program.id, program]));
    expect(Object.keys(byId)).toEqual(['dashboard', 'jellyfin', 'aria2', 'llama', 'searxng']);
    expect(byId.jellyfin).toMatchObject({
      state: 'running',
      stateText: 'Работает',
      restarts: 2,
      startedAt: '2026-10-16T09:30:00.000Z',
    });
    expect(byId.aria2?.stateText).toBe('Остановлена');
    expect(byId.llama?.stateText).toContain('Не установлена');
    expect(page.disks[0]?.path).toBe('C:\\');
    expect(page.backup.message).toContain('ночью');
    expect(page.model.configured).toBe(false);
    expect(page.downloads).toMatchObject({ total: 0, active: 0, failed: 0 });
    expect(page.portal.previousRun).toBe('unknown');
  });

  it('says honestly that the supervisor is not running', async () => {
    const { admin } = await setup({ supervisor: false });
    const page = (await get(admin)).json() as ServerPageResponse;
    expect(page.supervisor.running).toBe(false);
    expect(page.supervisor.message).toContain('Супервизор не запущен');
    expect(page.programs.find((program) => program.id === 'jellyfin')?.stateText).toContain(
      'супервизор не запущен',
    );
    // The portal answers this very request, so it is shown as running by itself.
    expect(page.programs.find((program) => program.id === 'dashboard')?.state).toBe('external');
  });

  it('shows the last lines of the logs without secrets, names, addresses or message texts', async () => {
    const { admin } = await setup();
    const logs = path.join(t.dataDir, 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(
      path.join(logs, 'dashboard.err.log'),
      [
        `Не удалось войти: password=${SECRET} от 192.168.1.57`,
        `Ошибка в C:\\FamilyData\\Files\\users\\mama\\Notes\\x.txt для mama@example.org`,
      ].join('\n'),
    );
    const out = [
      { level: 30, time: 1_700_000_000_000, msg: 'всё хорошо' },
      { level: 40, time: 1_700_000_001_000, msg: 'медленный запрос', text: CHAT_TEXT },
      { level: 50, time: 1_700_000_002_000, msg: `сбой токен=${SECRET}`, err: { message: 'boom' } },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    await writeFile(path.join(logs, 'dashboard.out.log'), out);
    await writeFile(
      path.join(logs, 'supervisor.log'),
      `2026-10-16T10:00:00Z [1] Программа mama запущена, ключ ${'a1'.repeat(20)}\n`,
    );

    const res = await get(admin);
    const page = res.json() as ServerPageResponse;
    for (const bad of [
      SECRET,
      '192.168.1.57',
      'FamilyData',
      'mama@example.org',
      CHAT_TEXT,
      'a1'.repeat(20),
    ]) {
      expect(res.body, bad).not.toContain(bad);
    }
    const blocks = Object.fromEntries(page.errors.map((block) => [block.source, block]));
    expect(blocks['portal-errors']?.lines).toHaveLength(2);
    // Only warnings and worse from the portal's own log, written as readable lines.
    expect(blocks['portal-warnings']?.lines).toHaveLength(2);
    expect(blocks['portal-warnings']?.lines.join('\n')).toContain('WARN медленный запрос');
    expect(blocks['portal-warnings']?.lines.join('\n')).not.toContain('всё хорошо');
    expect(blocks.supervisor?.lines.join('\n')).toContain('Программа');
  });

  it('tells that there is no log yet instead of showing an empty box', async () => {
    const { admin } = await setup();
    const page = (await get(admin)).json() as ServerPageResponse;
    expect(page.errors.map((block) => block.note)).toEqual([
      'Файла журнала ещё нет.',
      'Файла журнала ещё нет.',
      'Файла журнала ещё нет.',
    ]);
  });

  it('makes a report that can be copied: canary secrets and names never appear in it', async () => {
    const { admin } = await setup();
    const logs = path.join(t.dataDir, 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(
      path.join(logs, 'dashboard.err.log'),
      `password=${SECRET} user mama from 10.1.2.3 (${CHAT_TEXT})\n`,
    );
    const res = await get(admin, '/api/admin/server/report');
    const report = res.json() as ServerReportResponse;
    expect(report.text).toContain('Портал (этот сайт)');
    expect(report.text).toContain('Диски:');
    for (const bad of [SECRET, '10.1.2.3', 'SERVER-HOME', 'mama', 'Мама', 'папа'])
      expect(res.body, bad).not.toContain(bad);
    expect(report.removed.length).toBeGreaterThan(0);
    // Writing the report is recorded; the record says nothing about the content.
    const audit = (await get(admin, '/api/admin/audit?limit=20')).json() as AuditResponse;
    expect(audit.entries.some((entry) => entry.action === 'diagnostics.export')).toBe(true);
  });
});

describe('the «Сервер» page: what it may do', () => {
  it('restarts a program only with a confirmation, and passes the supervisor nothing but its id', async () => {
    const { admin, calls } = await setup();
    const missing = await post(admin, { action: 'restart', program: 'jellyfin' });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { error: string }).error).toBe('confirm_required');
    expect(calls.sent).toEqual([]);

    const done = await post(admin, { action: 'restart', program: 'jellyfin', confirm: true });
    expect(done.statusCode).toBe(200);
    expect((done.json() as ServerActionResponse).message).toContain('Кинотеатр');
    expect(calls.sent).toEqual([{ cmd: 'restart', app: 'jellyfin' }]);

    t.clock.advance(ACTION_GAP_MS + 1000);
    expect((await post(admin, { action: 'stop', program: 'aria2', confirm: true })).statusCode).toBe(200);
    t.clock.advance(ACTION_GAP_MS + 1000);
    expect((await post(admin, { action: 'start', program: 'llama' })).statusCode).toBe(200);
    expect(calls.sent).toEqual([
      { cmd: 'restart', app: 'jellyfin' },
      { cmd: 'stop', app: 'aria2' },
      { cmd: 'start', app: 'llama' },
    ]);
  });

  it('refuses an unknown program, an extra field and a made-up action', async () => {
    const { admin, calls } = await setup();
    for (const body of [
      { action: 'restart', program: 'powershell', confirm: true },
      { action: 'restart', program: 'jellyfin', confirm: true, command: 'cmd /c calc' },
      { action: 'restart', program: '../../x', confirm: true },
      { action: 'delete', program: 'jellyfin', confirm: true },
      { action: 'restart', program: 'jellyfin', confirm: 'yes' },
      { program: 'jellyfin' },
    ]) {
      const res = await post(admin, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    // Not JSON at all: refused before it is even read.
    expect((await post(admin, 'restart jellyfin')).statusCode).toBe(415);
    expect(calls.sent).toEqual([]);
  });

  it('asks twice before the portal itself is stopped or restarted, and answers before it goes', async () => {
    const { admin, calls } = await setup();
    const first = await post(admin, { action: 'stop', program: 'dashboard', confirm: true });
    expect(first.statusCode).toBe(400);
    expect((first.json() as { error: string }).error).toBe('portal_confirm_required');
    expect(calls.sent).toEqual([]);

    const start = await post(admin, { action: 'start', program: 'dashboard' });
    expect(start.statusCode).toBe(409);

    const ok = await post(admin, {
      action: 'restart',
      program: 'dashboard',
      confirm: true,
      portalConfirmed: true,
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as ServerActionResponse).message).toContain('перезапускается');
    // The command goes out only after the answer, through the delayed call.
    expect(calls.sent).toEqual([]);
    expect(calls.later).toHaveLength(1);
    calls.later[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.sent).toEqual([{ cmd: 'restart', app: 'dashboard' }]);
  });

  it('does not repeat the same action within seconds', async () => {
    const { admin, calls } = await setup();
    expect((await post(admin, { action: 'restart', program: 'jellyfin', confirm: true })).statusCode).toBe(
      200,
    );
    const again = await post(admin, { action: 'restart', program: 'jellyfin', confirm: true });
    expect(again.statusCode).toBe(429);
    expect(calls.sent).toHaveLength(1);
    // Another program is not held up by it.
    expect((await post(admin, { action: 'restart', program: 'aria2', confirm: true })).statusCode).toBe(200);
  });

  it('says so when the supervisor is not running, instead of pretending', async () => {
    const { admin, calls } = await setup({ supervisor: false });
    const res = await post(admin, { action: 'restart', program: 'jellyfin', confirm: true });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('no_supervisor');
    expect((res.json() as { message: string }).message).toContain('кнопкой на рабочем столе');
    expect(calls.sent).toEqual([]);
  });

  it('reports a refusal of the supervisor as an error', async () => {
    await setup();
    const failing = await createTestApp({
      serverPageDeps: {
        snapshot: () => snapshot(true),
        send: (async () => ({ ok: false, error: 'Нет программы «jellyfin»' })) as ServerPageDeps['send'],
      },
    });
    await addUser(failing.dataDir, failing.clock, ADMIN);
    const cookie = await cookieFor(failing.app, ADMIN);
    const res = await failing.app.inject({
      method: 'POST',
      url: '/api/admin/server/action',
      headers: { cookie },
      payload: { action: 'restart', program: 'jellyfin', confirm: true },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { message: string }).message).toContain('Нет программы');
    await failing.app.close();
    await removeDir(failing.dataDir);
  });

  it('makes a backup and checks the services, and does not start a second backup', async () => {
    const { admin, calls } = await setup();
    expect((await post(admin, { action: 'backup' })).statusCode).toBe(200);
    expect(calls.backups).toBe(1);
    expect((await post(admin, { action: 'recheck' })).statusCode).toBe(200);
    expect(calls.rechecks).toBe(1);
  });

  it('refuses a second backup while one is running', async () => {
    const { admin, calls } = await setup({ backupRunning: true });
    const res = await post(admin, { action: 'backup' });
    expect(res.statusCode).toBe(409);
    expect(calls.backups).toBe(0);
  });

  it('writes what was done and to which program into the journal — and nothing else', async () => {
    const { admin } = await setup();
    await post(admin, { action: 'restart', program: 'jellyfin', confirm: true });
    await post(admin, { action: 'restart', program: 'aria2' }); // no confirmation: not an event
    const audit = (await get(admin, '/api/admin/audit?limit=20')).json() as AuditResponse;
    const mine = audit.entries.filter((entry) => entry.action === 'server.action');
    expect(mine.map((entry) => entry.detail)).toEqual(['restart jellyfin: выполнено']);
  });
});

describe('the portal after a crash', () => {
  it('tells the administrators once when the last run did not end on purpose', async () => {
    t = await createTestApp({ startBackground: true });
    await addUser(t.dataDir, t.clock, ADMIN);
    await addUser(t.dataDir, t.clock, FAMILY);
    await t.app.ready();
    // Nothing is told after a first start.
    const admin = await cookieFor(t.app, ADMIN);
    expect(
      ((await get(admin, '/api/notifications')).json() as NotificationsResponse).notifications,
    ).toHaveLength(0);
    // Cut off, not closed: the next start finds «running» in the record.
    const dataDir = t.dataDir;
    const clock = t.clock;
    await writeFile(
      path.join(dataDir, 'run-state.json'),
      JSON.stringify({
        state: 'running',
        startedAt: '2026-10-16T09:00:00.000Z',
        at: '2026-10-16T09:41:00.000Z',
        pid: 1,
      }),
    );
    // A second instance on the same data folder stands in for the portal after its restart.
    const second = await createTestApp({ startBackground: true, dataDir, clock });
    await second.app.ready();
    const cookie = await cookieFor(second.app, ADMIN);
    const list = (
      await second.app.inject({ url: '/api/notifications', headers: { cookie } })
    ).json() as NotificationsResponse;
    expect(list.notifications).toHaveLength(1);
    expect(list.notifications[0]?.title).toMatch(/^Сервер перезапускался после сбоя в \d{2}:\d{2}$/);
    expect(list.notifications[0]?.url).toBe('/server');
    // The family is not bothered with it.
    const family = await cookieFor(second.app, FAMILY);
    const theirs = (
      await second.app.inject({ url: '/api/notifications', headers: { cookie: family } })
    ).json() as NotificationsResponse;
    expect(theirs.notifications).toHaveLength(0);
    // A normal stop and start never raises it.
    await second.app.close();
    const third = await createTestApp({ startBackground: true, dataDir, clock });
    await third.app.ready();
    const again = (
      await third.app.inject({
        url: '/api/notifications',
        headers: { cookie: await cookieFor(third.app, ADMIN) },
      })
    ).json() as NotificationsResponse;
    expect(again.notifications).toHaveLength(1); // the old one only; no second alarm
    await third.app.close();
  });
});
