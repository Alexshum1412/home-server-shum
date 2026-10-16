import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { type BuildAppOptions, buildApp, type DashboardApp } from '../src/app.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { createUserStore, type StoredUser } from '../src/auth/users.ts';
import { type Config, type Env, loadConfig } from '../src/config.ts';
import type { SystemProbes } from '../src/system/probes.ts';

export const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

export async function makeTempDir(prefix = 'fd-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export interface FakeClock {
  (): Date;
  advance(ms: number): void;
}

export function createFakeClock(start = '2026-10-16T10:00:00.000Z'): FakeClock {
  let now = Date.parse(start);
  const clock = (() => new Date(now)) as FakeClock;
  clock.advance = (ms: number) => {
    now += ms;
  };
  return clock;
}

/** Four identical cores with the given cumulative busy/idle times (ms). */
export function fakeCpus(busy: number, idle: number): os.CpuInfo[] {
  return Array.from({ length: 4 }, () => ({
    model: 'Intel(R) Core(TM) i5-6400 CPU @ 2.70GHz',
    speed: 2712,
    times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
  }));
}

export function fakeProbes(overrides: Partial<SystemProbes> = {}): SystemProbes {
  return {
    cpus: () => fakeCpus(1000, 3000),
    totalMemoryBytes: () => 16_000_000_000,
    freeMemoryBytes: () => 6_000_000_000,
    uptimeSeconds: () => 3600.4,
    hostname: () => 'TEST-SERVER',
    osRelease: () => 'Windows 10 Home (10.0.19045)',
    statfs: async () => ({ totalBytes: 2_000_000_000_000, freeBytes: 1_000_000_000_000 }),
    physicalDisks: async () => readFixture('physical-disks.json'),
    printers: async () => readFixture('printers.json'),
    tailscaleStatus: async () => readFixture('tailscale-status.json'),
    ...overrides,
  };
}

const networkDisabled = async (): Promise<Response> => {
  throw new Error('network is disabled in tests');
};

export interface TestApp {
  app: DashboardApp;
  config: Config;
  dataDir: string;
  clock: FakeClock;
}

export interface TestAppOptions extends Partial<Omit<BuildAppOptions, 'config' | 'clock'>> {
  env?: Env;
  dataDir?: string;
  clock?: FakeClock;
}

/** The portal's own loopback address: what a browser on the server sends as Host. */
export function localHost(config: Config): string {
  return `127.0.0.1:${config.port}`;
}

/**
 * inject() would send "Host: localhost:80", which the host allowlist rejects. Requests without an
 * explicit Host header get the portal's own loopback address instead (a test may still pass one).
 */
function injectWithDefaultHost(app: DashboardApp, host: string): void {
  const inject = app.inject.bind(app) as (options: InjectOptions) => Promise<LightMyRequestResponse>;
  const patched = (options: InjectOptions | string) =>
    inject(typeof options === 'string' ? { url: options, authority: host } : { authority: host, ...options });
  (app as { inject: unknown }).inject = patched;
}

/** App with a temp data dir, no logger, no background timers, fake probes/clock and no network. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const { env, dataDir: givenDir, clock: givenClock, ...rest } = options;
  const dataDir = givenDir ?? (await makeTempDir());
  const clock = givenClock ?? createFakeClock();
  const config = loadConfig({ DASHBOARD_DATA_DIR: dataDir, VOLUMES: 'C:\\', ...env }, 'win32');
  const app = await buildApp({
    logger: false,
    startBackground: false,
    fetch: networkDisabled,
    probes: fakeProbes(),
    webRoot: path.join(dataDir, 'web-not-built'),
    usersReloadIntervalMs: 0,
    ...rest,
    config,
    clock,
  });
  injectWithDefaultHost(app, localHost(config));
  return { app, config, dataDir, clock };
}

export async function addUser(
  dataDir: string,
  clock: () => Date,
  user: { username: string; password: string; role?: 'family' | 'admin'; displayName?: string },
): Promise<StoredUser> {
  const store = createUserStore(dataDir, { clock, reloadIntervalMs: 0 });
  return store.add({
    username: user.username,
    displayName: user.displayName ?? user.username,
    role: user.role ?? 'family',
    passwordHash: await hashPassword(user.password),
  });
}

export const ADMIN = {
  username: 'papa',
  password: 'admin-password-1',
  role: 'admin' as const,
  displayName: 'Папа',
};
export const FAMILY = {
  username: 'mama',
  password: 'family-password-1',
  role: 'family' as const,
  displayName: 'Мама',
};

export function sessionCookie(res: LightMyRequestResponse): string | undefined {
  const cookie = res.cookies.find((c) => c.name === 'fd_session');
  return cookie && cookie.value !== '' ? `fd_session=${cookie.value}` : undefined;
}

export async function login(
  app: DashboardApp,
  username: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<{ res: LightMyRequestResponse; cookie: string | undefined }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password },
    headers,
  });
  return { res, cookie: sessionCookie(res) };
}

/** Logs in and returns the cookie header, failing loudly when sign-in did not work. */
export async function cookieFor(
  app: DashboardApp,
  user: { username: string; password: string },
): Promise<string> {
  const { res, cookie } = await login(app, user.username, user.password);
  if (res.statusCode !== 200 || !cookie) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return cookie;
}
