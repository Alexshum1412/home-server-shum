import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceStatus, ServicesResponse } from '../../shared/api.ts';
import type { ServiceDefinition } from '../src/services/config.ts';
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

let server: Server;
let base: string;
let closedPortUrl: string;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    } else if (req.url === '/err') {
      res.writeHead(500).end('boom');
    } else if (req.url === '/unavailable') {
      res.writeHead(503).end('busy');
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://elsewhere.invalid/login' }).end();
    } else if (req.url === '/slow') {
      setTimeout(() => res.writeHead(200).end('late'), 2000).unref();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  closedPortUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/`;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps.splice(0)) {
    await t.app.close();
    await removeDir(t.dataDir);
  }
});

function service(id: string, extra: Partial<ServiceDefinition>): ServiceDefinition {
  return {
    id,
    kind: 'other',
    name: `Сервис ${id}`,
    description: 'Тестовый сервис',
    openUrl: null,
    healthUrl: null,
    enabled: true,
    hint: `Подсказка ${id}`,
    ...extra,
  };
}

async function appWithServices(services: ServiceDefinition[] | string, env: Record<string, string> = {}) {
  const dataDir = await makeTempDir();
  const content = typeof services === 'string' ? services : JSON.stringify({ version: 1, services });
  await writeFile(path.join(dataDir, 'services.json'), content);
  const t = await createTestApp({ dataDir, fetch, env: { SERVICE_CHECK_TIMEOUT_MS: '300', ...env } });
  apps.push(t);
  await addUser(dataDir, t.clock, ADMIN);
  await addUser(dataDir, t.clock, FAMILY);
  return t;
}

async function getServices(
  t: TestApp,
  user: { username: string; password: string } = FAMILY,
): Promise<ServicesResponse> {
  const cookie = await cookieFor(t.app, user);
  const res = await t.app.inject({ url: '/api/services', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const byId = (list: ServiceStatus[], id: string) => {
  const found = list.find((s) => s.id === id);
  if (!found) throw new Error(`service ${id} missing`);
  return found;
};

describe('service registry', () => {
  it('creates services.json from defaults on a fresh install; all not configured, with hints', async () => {
    const t = await createTestApp();
    apps.push(t);
    await addUser(t.dataDir, t.clock, FAMILY);
    const file = JSON.parse(await readFile(path.join(t.dataDir, 'services.json'), 'utf8'));
    expect(file.version).toBe(1);
    expect(file.services.map((s: ServiceDefinition) => s.id)).toEqual([
      'media',
      'photos',
      'files',
      'downloads',
      'calendar',
    ]);
    const body = await getServices(t);
    expect(body.configError).toBeNull();
    // Downloads, files and photos are part of the portal itself; the rest needs a separate program.
    const builtIn = ['downloads', 'files', 'photos', 'calendar'];
    for (const id of builtIn) {
      expect(byId(body.services, id)).toMatchObject({ state: 'online', message: 'Встроено в портал' });
    }
    for (const s of body.services.filter((x) => !builtIn.includes(x.id))) {
      expect(s.state).toBe('not_configured');
      expect(s.openUrl).toBeNull();
      expect(s.checkedAt).toBeNull();
      expect(s.hint).toBeTruthy();
      expect(s.demo).toBe(false);
      expect(s).toHaveProperty('detail', null);
    }
    expect(byId(body.services, 'media')).toMatchObject({
      name: 'Кинотеатр',
      description: 'Фильмы и сериалы (Jellyfin)',
      hint: 'Кинотеатр пока не подключён. Попросите администратора установить Jellyfin.',
    });
  });

  it('reports honest states from real HTTP checks', async () => {
    const t = await appWithServices([
      service('up', { openUrl: `${base}/ok` }),
      service('err', { openUrl: `${base}/`, healthUrl: `${base}/err` }),
      service('slow', { openUrl: `${base}/slow` }),
      service('down', { openUrl: closedPortUrl }),
      service('moved', { openUrl: `${base}/redirect` }),
      service('off', { openUrl: `${base}/ok`, enabled: false }),
      service('none', {}),
    ]);
    const before = await getServices(t);
    expect(byId(before.services, 'up')).toMatchObject({
      state: 'unknown',
      message: 'Проверка ещё не выполнялась',
      checkedAt: null,
    });

    await t.app.dashboard.registry.checkAll();
    const { services } = await getServices(t);
    const up = byId(services, 'up');
    expect(up.state).toBe('online');
    expect(up.openUrl).toBe(`${base}/ok`);
    expect(up.latencyMs).toEqual(expect.any(Number));
    expect(up.checkedAt).toBe('2026-10-16T10:00:00.000Z');
    expect(up.hint).toBeNull();

    expect(byId(services, 'err')).toMatchObject({
      state: 'degraded',
      message: 'Сервис отвечает с ошибкой',
      latencyMs: null,
      detail: null,
    });
    expect(byId(services, 'slow')).toMatchObject({
      state: 'offline',
      message: 'Сервис не ответил за 0,3 с',
      detail: null,
    });
    const down = byId(services, 'down');
    expect(down).toMatchObject({ state: 'offline', message: 'Сервис не отвечает', detail: null });
    expect(down.checkedAt).not.toBeNull();
    expect(byId(services, 'moved').state).toBe('online');
    expect(byId(services, 'off')).toMatchObject({ state: 'disabled', openUrl: null });
    expect(byId(services, 'none')).toMatchObject({ state: 'not_configured', openUrl: null });
    expect(requests).not.toContain('/login');
    for (const s of services) expect(s, s.id).toHaveProperty('detail', null);

    // The admin sees the technical detail behind the same plain message.
    const admin = (await getServices(t, ADMIN)).services;
    expect(byId(admin, 'err')).toMatchObject({ message: 'Сервис отвечает с ошибкой', detail: 'HTTP 500' });
    expect(byId(admin, 'slow')).toMatchObject({
      message: 'Сервис не ответил за 0,3 с',
      detail: 'timeout 300 мс',
    });
    expect(byId(admin, 'down').detail).toMatch(/^ECONNREFUSED 127\.0\.0\.1:\d+$/);
    expect(byId(admin, 'up').detail).toBeNull();
    expect(byId(admin, 'none').detail).toBeNull();
  });

  it('keeps HTTP codes out of the family view; admin, refresh and diagnostics keep them', async () => {
    const t = await appWithServices([service('busy', { openUrl: `${base}/unavailable` })]);
    await t.app.dashboard.registry.checkAll();
    const family = byId((await getServices(t, FAMILY)).services, 'busy');
    expect(family).toMatchObject({ state: 'degraded', message: 'Сервис отвечает с ошибкой', detail: null });
    const familyRaw = await t.app.inject({
      url: '/api/services',
      headers: { cookie: await cookieFor(t.app, FAMILY) },
    });
    expect(familyRaw.body).not.toContain('503');

    expect(byId((await getServices(t, ADMIN)).services, 'busy').detail).toBe('HTTP 503');
    const cookie = await cookieFor(t.app, ADMIN);
    const refresh = await t.app.inject({
      method: 'POST',
      url: '/api/services/refresh',
      headers: { cookie },
      payload: {},
    });
    expect(refresh.statusCode).toBe(200);
    expect(byId((refresh.json() as ServicesResponse).services, 'busy').detail).toBe('HTTP 503');
    const diagnostics = await t.app.inject({ url: '/api/admin/diagnostics', headers: { cookie } });
    expect(byId(diagnostics.json().services, 'busy').detail).toBe('HTTP 503');
  });

  it('never sends a javascript: (or otherwise unsafe) URL to the browser', async () => {
    const t = await appWithServices([
      service('evil', { openUrl: 'javascript:alert(1)' }),
      service('creds', { openUrl: 'http://user:pass@127.0.0.1:1/' }),
      service('file', { openUrl: `${base}/ok`, healthUrl: 'file:///C:/Windows/win.ini' }),
    ]);
    await t.app.dashboard.registry.checkAll();
    const cookie = await cookieFor(t.app, FAMILY);
    const res = await t.app.inject({ url: '/api/services', headers: { cookie } });
    expect(res.body).not.toContain('javascript:');
    expect(res.body).not.toContain('user:pass');
    for (const s of (res.json() as ServicesResponse).services) {
      expect(s).toMatchObject({
        state: 'not_configured',
        openUrl: null,
        message: 'Адрес сервиса указан неверно',
      });
    }
  });

  it('keeps an invalid services.json untouched and tells only the admin', async () => {
    const broken = '{ "version": 1, "services": [ { "id": "media" ';
    const t = await appWithServices(broken);
    const family = await getServices(t, FAMILY);
    expect(family.services).toEqual([]);
    expect(family.configError).toBeNull();
    const admin = await getServices(t, ADMIN);
    expect(admin.configError).toMatch(/services\.json/);
    expect(await readFile(path.join(t.dataDir, 'services.json'), 'utf8')).toBe(broken);

    const cookie = await cookieFor(t.app, ADMIN);
    const system = (await t.app.inject({ url: '/api/system', headers: { cookie } })).json();
    expect(system.alerts.map((a: { id: string }) => a.id)).toContain('services-config-error');
  });

  it('reports schema errors (e.g. unknown kind) as a config error', async () => {
    const t = await appWithServices([service('x', { kind: 'nuclear' as never })]);
    expect((await getServices(t, ADMIN)).configError).toMatch(/kind/);
  });
});

describe('supervised programs', () => {
  it('says «stopped» or «restarting» from the supervisor state instead of a bare «not answering»', async () => {
    const t = await appWithServices([
      service('stopped', { openUrl: closedPortUrl, process: 'jellyfin' }),
      service('crashed', { openUrl: closedPortUrl, process: 'other' }),
      service('plain', { openUrl: closedPortUrl, process: 'missing' }),
      service('up', { openUrl: `${base}/ok`, process: 'jellyfin' }),
    ]);
    await mkdir(path.join(t.dataDir, 'run'), { recursive: true });
    await writeFile(
      path.join(t.dataDir, 'run', 'supervisor.json'),
      JSON.stringify({
        apps: [
          { name: 'jellyfin', state: 'stopped', restarts: 0, message: 'Остановлен' },
          { name: 'other', state: 'backoff', restarts: 3, message: 'Сбой' },
        ],
      }),
    );
    await t.app.dashboard.registry.checkAll();
    const family = (await getServices(t)).services;
    expect(byId(family, 'stopped')).toMatchObject({ state: 'offline', message: 'Остановлен' });
    expect(byId(family, 'stopped').hint).toMatch(/администратора запустить/);
    expect(byId(family, 'crashed').message).toBe('Сбой: сервис перезапускается автоматически');
    expect(byId(family, 'plain').message).toBe('Сервис не отвечает');
    expect(byId(family, 'up').state).toBe('online');
    // Technical detail only for the admin.
    expect(byId(family, 'crashed').detail ?? null).toBeNull();
    const admin = (await getServices(t, ADMIN)).services;
    expect(byId(admin, 'crashed').detail).toMatch(/супервизор: backoff, перезапусков 3/);
  });

  it('rejects an invalid process name in services.json', async () => {
    const t = await appWithServices([service('x', { openUrl: `${base}/ok`, process: '../evil' })]);
    const body = await getServices(t, ADMIN);
    expect(body.configError).toMatch(/process/);
  });
});

describe('demo mode', () => {
  it('labels every fabricated state with demo: true', async () => {
    const t = await createTestApp({ env: { DASHBOARD_DEMO: '1' } });
    apps.push(t);
    await addUser(t.dataDir, t.clock, FAMILY);
    const { services } = await getServices(t);
    expect(services.every((s) => s.demo)).toBe(true);
    expect(byId(services, 'media')).toMatchObject({
      state: 'online',
      openUrl: 'http://127.0.0.1:8096',
      latencyMs: 12,
    });
    expect(byId(services, 'photos').state).toBe('offline');
    expect(byId(services, 'files').state).toBe('not_configured');
    expect(byId(services, 'downloads')).toMatchObject({
      state: 'degraded',
      message: 'Сервис отвечает с ошибкой (демо)',
    });
    expect(byId(services, 'calendar').state).toBe('not_configured');
    // Family view: every status carries detail, always null.
    for (const s of services) expect(s, s.id).toHaveProperty('detail', null);
    await addUser(t.dataDir, t.clock, ADMIN);
    const admin = (await getServices(t, ADMIN)).services;
    for (const s of admin) expect(s, s.id).toHaveProperty('detail');
    expect(byId(admin, 'downloads').detail).toBe('HTTP 503 (демо)');
    expect(byId(admin, 'media').detail).toBeNull();
    const session = await t.app.inject({
      url: '/api/session',
      headers: { cookie: await cookieFor(t.app, FAMILY) },
    });
    expect(session.json().demo).toBe(true);
  });

  it('never fabricates anything outside demo mode', async () => {
    const t = await appWithServices([service('up', { openUrl: `${base}/ok` })]);
    await t.app.dashboard.registry.checkAll();
    const { services } = await getServices(t);
    expect(services.every((s) => s.demo === false)).toBe(true);
    expect(services.map((s) => s.id)).toEqual(['up']);
  });
});

describe('manual refresh', () => {
  it('is admin-only, audited and rate limited to once per 10 s', async () => {
    let calls = 0;
    const countingFetch = async (input: string, init: RequestInit) => {
      calls += 1;
      return fetch(input, init);
    };
    const dataDir = await makeTempDir();
    await writeFile(
      path.join(dataDir, 'services.json'),
      JSON.stringify({ version: 1, services: [service('up', { openUrl: `${base}/ok` })] }),
    );
    const t = await createTestApp({ dataDir, fetch: countingFetch });
    apps.push(t);
    await addUser(dataDir, t.clock, ADMIN);
    await addUser(dataDir, t.clock, FAMILY);

    const anonymous = await t.app.inject({ method: 'POST', url: '/api/services/refresh', payload: {} });
    expect(anonymous.statusCode).toBe(401);

    const cookie = await cookieFor(t.app, ADMIN);
    const first = await t.app.inject({
      method: 'POST',
      url: '/api/services/refresh',
      headers: { cookie },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(byId((first.json() as ServicesResponse).services, 'up').state).toBe('online');
    expect(calls).toBe(1);

    t.clock.advance(5000);
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/services/refresh',
      headers: { cookie },
      payload: {},
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('5');
    expect(calls).toBe(1);

    t.clock.advance(5000);
    const third = await t.app.inject({
      method: 'POST',
      url: '/api/services/refresh',
      headers: { cookie },
      payload: {},
    });
    expect(third.statusCode).toBe(200);
    expect(calls).toBe(2);

    const actions = (await t.app.dashboard.audit.readLatest(10)).map((e) => e.action);
    expect(actions.filter((a) => a === 'services.refresh')).toHaveLength(2);
  });

  it('requires a session for the services list', async () => {
    const t = await createTestApp();
    apps.push(t);
    expect((await t.app.inject({ url: '/api/services' })).statusCode).toBe(401);
  });
});
