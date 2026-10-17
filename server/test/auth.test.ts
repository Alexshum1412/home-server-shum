import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsersResponse } from '../../shared/api.ts';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../src/auth/passwords.ts';
import { createSlidingWindowLimiter } from '../src/auth/rate-limit.ts';
import { INVALID_CREDENTIALS_MESSAGE } from '../src/auth/routes.ts';
import { createSessionStore, MAX_SESSIONS_PER_USER } from '../src/auth/sessions.ts';
import { createUserStore } from '../src/auth/users.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createFakeClock,
  createTestApp,
  FAMILY,
  login,
  makeTempDir,
  removeDir,
  type TestApp,
} from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
});

afterEach(async () => {
  await t.app.close();
  await removeDir(t.dataDir);
});

describe('passwords', () => {
  it('stores salted scrypt hashes in the agreed format and verifies them', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterY', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$999999999$8$1$AAAA$AAAA')).toBe(false);
  });

  it('enforces the password policy', () => {
    expect(checkPasswordPolicy('short', 'mama')).toMatch(/короткий/);
    expect(checkPasswordPolicy('mamamamama', 'mamamamama')).toMatch(/логином/);
    expect(checkPasswordPolicy('a'.repeat(257), 'mama')).toMatch(/длинный/);
    expect(checkPasswordPolicy('длинный-пароль', 'mama')).toBeNull();
  });
});

describe('setup state', () => {
  it('reports when no users exist and shows the CLI command', async () => {
    const empty = await createTestApp();
    try {
      const res = await empty.app.inject({ url: '/api/setup-state' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        hasUsers: false,
        createAdminCommand: 'scripts\\user.cmd add <логин> --name "<Имя>" --role admin',
      });
    } finally {
      await empty.app.close();
      await removeDir(empty.dataDir);
    }
    const res = await t.app.inject({ url: '/api/setup-state' });
    expect(res.json().hasUsers).toBe(true);
  });

  it('never offers the first run when users.json exists but is broken; sign-in answers 503', async () => {
    const usersUnavailable = {
      error: 'users_unavailable',
      message: 'Не удаётся прочитать список пользователей на сервере. Сообщите администратору.',
    };
    for (const broken of ['{"version":1,"users":[{"id":', '{"version":1,"users":"none"}']) {
      const dir = await makeTempDir();
      await writeFile(path.join(dir, 'users.json'), broken);
      const lines: string[] = [];
      const broke = await createTestApp({
        dataDir: dir,
        logger: { level: 'error', stream: { write: (line: string) => lines.push(line) } },
      });
      try {
        const setup = await broke.app.inject({ url: '/api/setup-state' });
        expect(setup.statusCode).toBe(200);
        expect(setup.json().hasUsers, broken).toBe(true);
        for (let i = 0; i < 12; i += 1) {
          const res = await login(broke.app, ADMIN.username, ADMIN.password);
          expect(res.res.statusCode, broken).toBe(503);
          expect(res.res.json()).toEqual(usersUnavailable);
          expect(res.cookie).toBeUndefined();
        }
        expect(lines.join('\n')).toContain('users.json');
        // The broken file is never overwritten.
        expect(await readFile(path.join(dir, 'users.json'), 'utf8')).toBe(broken);
        // Once the owner repairs the file, sign-in works and the 503s did not count as failures.
        await rm(path.join(dir, 'users.json'));
        await addUser(dir, broke.clock, ADMIN);
        expect((await login(broke.app, ADMIN.username, ADMIN.password)).res.statusCode).toBe(200);
      } finally {
        await broke.app.close();
        await removeDir(dir);
      }
    }
  });

  it('answers 503 when users.json breaks while the server runs, instead of trusting a stale list', async () => {
    const file = path.join(t.dataDir, 'users.json');
    const good = await readFile(file, 'utf8');
    await writeFile(file, '{ not json');
    expect((await login(t.app, FAMILY.username, FAMILY.password)).res.statusCode).toBe(503);
    expect((await t.app.inject({ url: '/api/setup-state' })).json().hasUsers).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('{ not json');
    await writeFile(file, good);
    expect((await login(t.app, FAMILY.username, FAMILY.password)).res.statusCode).toBe(200);
  });
});

describe('login', () => {
  it('signs in with correct credentials and returns the session user', async () => {
    const { res, cookie } = await login(t.app, 'Mama ', FAMILY.password);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      user: { id: expect.any(String), username: 'mama', displayName: 'Мама', role: 'family' },
      demo: false,
      mustChangePassword: false,
    });
    expect(res.body).not.toContain('scrypt');
    expect(cookie).toBeDefined();
    const session = await t.app.inject({ url: '/api/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.username).toBe('mama');
    const mama = await t.app.dashboard.users.findByUsername('mama');
    expect(t.app.dashboard.logins.get(mama?.id ?? '')).toBe('2026-10-16T10:00:00.000Z');
  });

  it('records the sign-in time in logins.json and never writes users.json (the CLI owns it)', async () => {
    const usersFile = path.join(t.dataDir, 'users.json');
    const before = await readFile(usersFile, 'utf8');
    const beforeMtime = (await stat(usersFile)).mtimeMs;
    t.clock.advance(60_000);
    expect((await login(t.app, FAMILY.username, FAMILY.password)).res.statusCode).toBe(200);
    expect(await readFile(usersFile, 'utf8')).toBe(before);
    expect((await stat(usersFile)).mtimeMs).toBe(beforeMtime);

    const mama = await t.app.dashboard.users.findByUsername('mama');
    const logins = JSON.parse(await readFile(path.join(t.dataDir, 'logins.json'), 'utf8'));
    expect(logins).toEqual({ version: 1, lastLoginAt: { [mama?.id ?? '']: '2026-10-16T10:01:00.000Z' } });

    // Still shown to the admin, also after a restart.
    const lastLoginOf = async (app: TestApp['app'], username: string) => {
      const cookie = await cookieFor(app, ADMIN);
      const res = await app.inject({ url: '/api/admin/users', headers: { cookie } });
      return (res.json() as UsersResponse).users.find((u) => u.username === username)?.lastLoginAt;
    };
    expect(await lastLoginOf(t.app, 'mama')).toBe('2026-10-16T10:01:00.000Z');
    const restarted = await createTestApp({ dataDir: t.dataDir, clock: t.clock });
    try {
      expect(await lastLoginOf(restarted.app, 'mama')).toBe('2026-10-16T10:01:00.000Z');
    } finally {
      await restarted.app.close();
    }
    expect(await readFile(usersFile, 'utf8')).toBe(before);
  });

  it('still shows a sign-in time stored in users.json by an older version', async () => {
    const usersFile = path.join(t.dataDir, 'users.json');
    const data = JSON.parse(await readFile(usersFile, 'utf8')) as { users: Array<Record<string, unknown>> };
    for (const user of data.users) {
      user.lastLoginAt = user.username === 'mama' ? '2026-01-02T03:04:05.000Z' : null;
    }
    await writeFile(usersFile, JSON.stringify(data));
    const cookie = await cookieFor(t.app, ADMIN);
    const res = await t.app.inject({ url: '/api/admin/users', headers: { cookie } });
    const users = (res.json() as UsersResponse).users;
    expect(users.find((u) => u.username === 'mama')?.lastLoginAt).toBe('2026-01-02T03:04:05.000Z');
    // A newer time from logins.json wins over the old field.
    expect(users.find((u) => u.username === 'papa')?.lastLoginAt).toBe('2026-10-16T10:00:00.000Z');
  });

  it('answers wrong password and unknown user with the same generic 401', async () => {
    const wrong = await login(t.app, FAMILY.username, 'not-the-password');
    const unknown = await login(t.app, 'stranger', 'not-the-password');
    for (const { res, cookie } of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_credentials', message: INVALID_CREDENTIALS_MESSAGE });
      expect(cookie).toBeUndefined();
    }
    const entries = await t.app.dashboard.audit.readLatest(10);
    expect(entries.map((e) => e.action)).toEqual(['login.failure', 'login.failure']);
    expect(JSON.stringify(entries)).not.toContain('not-the-password');
  });

  it('validates the body', async () => {
    for (const payload of [
      {},
      { username: 'mama' },
      { username: '', password: 'x' },
      { username: 1, password: 2 },
    ]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/login', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_request');
    }
    const longName = await login(t.app, 'a'.repeat(65), 'whatever-password');
    expect(longName.res.statusCode).toBe(400);
  });

  it('blocks a username after 10 failures with 429 even for the correct password', async () => {
    for (let i = 0; i < 10; i += 1) {
      const { res } = await login(t.app, FAMILY.username, `wrong-password-${i}`);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await login(t.app, FAMILY.username, FAMILY.password);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.cookie).toBeUndefined();
    expect(Number(blocked.res.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.res.json().message).toMatch(/через \d+ мин/);
    const latest = await t.app.dashboard.audit.readLatest(1);
    expect(latest[0]?.action).toBe('login.blocked');
    // Another user is not affected.
    expect((await login(t.app, ADMIN.username, ADMIN.password)).res.statusCode).toBe(200);
    // After the window passes the correct password works again.
    t.clock.advance(15 * 60 * 1000 + 1000);
    expect((await login(t.app, FAMILY.username, FAMILY.password)).res.statusCode).toBe(200);
  });

  it('blocks a client address after 30 failures across usernames, other addresses unaffected', async () => {
    const attacker = { remoteAddress: '10.0.0.7' };
    for (let i = 0; i < 30; i += 1) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: `guess${i % 5}`, password: `wrong-password-${i}` },
        ...attacker,
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: ADMIN.username, password: ADMIN.password },
      ...attacker,
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json().error).toBe('too_many_attempts');
    const [entry] = await t.app.dashboard.audit.readLatest(1);
    expect(entry).toMatchObject({ action: 'login.blocked', ip: '10.0.0.7' });
    expect(entry?.detail).toContain('с этого адреса');

    const other = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: ADMIN.username, password: ADMIN.password },
      remoteAddress: '10.0.0.8',
    });
    expect(other.statusCode).toBe(200);
  });

  it('counts concurrent guesses up front: a burst gets at most 10 evaluations, the rest 429', async () => {
    const burst = Array.from({ length: 40 }, (_, i) => login(t.app, FAMILY.username, `wrong-password-${i}`));
    // The correct password arrives inside the burst, after the limit was reached by guesses
    // that are still being checked (password hashing is slow).
    const { byUser } = t.app.dashboard.limiter;
    for (let i = 0; i < 10_000 && byUser.check(FAMILY.username).allowed; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const correct = await login(t.app, FAMILY.username, FAMILY.password);
    const results = await Promise.all(burst);
    expect(correct.res.statusCode).toBe(429);
    expect(correct.cookie).toBeUndefined();
    expect(correct.res.headers['retry-after']).toBeDefined();
    const codes = results.map((r) => r.res.statusCode);
    expect(codes.filter((code) => code === 401).length).toBeLessThanOrEqual(10);
    expect(codes.filter((code) => code !== 401 && code !== 429)).toEqual([]);
    const actions = (await t.app.dashboard.audit.readLatest(500)).map((e) => e.action);
    expect(actions.filter((a) => a === 'login.failure').length).toBeLessThanOrEqual(10);
    expect(actions).not.toContain('login.success');
  });

  it('does not count a successful sign-in against the address', async () => {
    // 31 sign-ins from one address: one more than the 30 failures that would block it.
    for (let i = 0; i < 31; i += 1) {
      const user = i % 2 ? ADMIN : FAMILY;
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: user.username, password: user.password },
        remoteAddress: '10.0.0.9',
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('audits a blocked login once per window, so a flood cannot push real entries out', async () => {
    expect((await login(t.app, ADMIN.username, ADMIN.password)).res.statusCode).toBe(200);
    for (let i = 0; i < 10; i += 1) await login(t.app, FAMILY.username, `wrong-password-${i}`);
    for (let i = 0; i < 600; i += 1) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: FAMILY.username, password: `flood-password-${i}` },
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    }
    const entries = await t.app.dashboard.audit.readLatest(500);
    const blocked = entries.filter((e) => e.action === 'login.blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked.length).toBeLessThanOrEqual(2);
    expect(blocked[0]?.detail).toContain('не записываются');
    expect(entries.filter((e) => e.action === 'login.failure')).toHaveLength(10);
    expect(entries.some((e) => e.action === 'login.success' && e.actor === ADMIN.username)).toBe(true);

    // A new block after the window has passed is recorded again.
    t.clock.advance(15 * 60 * 1000 + 1000);
    for (let i = 0; i < 10; i += 1) await login(t.app, FAMILY.username, `wrong-again-${i}`);
    expect((await login(t.app, FAMILY.username, 'one-more-guess')).res.statusCode).toBe(429);
    const after = await t.app.dashboard.audit.readLatest(500);
    expect(after.filter((e) => e.action === 'login.blocked')).toHaveLength(blocked.length + 1);
    expect(after[0]?.action).toBe('login.blocked');
  });

  it('clears the username counter after a successful sign-in', async () => {
    for (let i = 0; i < 9; i += 1) await login(t.app, FAMILY.username, `wrong-${i}-password`);
    expect((await login(t.app, FAMILY.username, FAMILY.password)).res.statusCode).toBe(200);
    for (let i = 0; i < 9; i += 1) await login(t.app, FAMILY.username, `wrong-${i}-password`);
    expect((await login(t.app, FAMILY.username, FAMILY.password)).res.statusCode).toBe(200);
  });
});

describe('sliding-window limiter', () => {
  it('limits per key and recovers after the window', () => {
    const clock = createFakeClock();
    const limiter = createSlidingWindowLimiter({ limit: 30, windowMs: 15 * 60 * 1000, clock });
    for (let i = 0; i < 30; i += 1) {
      expect(limiter.check('10.0.0.1').allowed).toBe(true);
      limiter.hit('10.0.0.1');
    }
    const check = limiter.check('10.0.0.1');
    expect(check.allowed).toBe(false);
    expect(check.retryAfterSec).toBe(15 * 60);
    expect(limiter.check('10.0.0.2').allowed).toBe(true);
    clock.advance(15 * 60 * 1000);
    expect(limiter.check('10.0.0.1').allowed).toBe(true);
  });

  it('takes back the newest hit with release()', () => {
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1000, clock: createFakeClock() });
    limiter.hit('k');
    limiter.hit('k');
    expect(limiter.check('k').allowed).toBe(false);
    limiter.release('k');
    expect(limiter.check('k').allowed).toBe(true);
    limiter.release('k');
    limiter.release('k');
    limiter.release('missing');
    limiter.hit('k');
    expect(limiter.check('k').allowed).toBe(true);
  });

  it('bounds memory', () => {
    const limiter = createSlidingWindowLimiter({
      limit: 1,
      windowMs: 1000,
      clock: createFakeClock(),
      maxKeys: 5,
    });
    for (let i = 0; i < 100; i += 1) limiter.hit(`user-${i}`);
    expect(limiter.check('user-0').allowed).toBe(true);
    expect(limiter.check('user-99').allowed).toBe(false);
  });
});

describe('access control', () => {
  it('returns 401 JSON for protected APIs without a session', async () => {
    for (const url of [
      '/api/session',
      '/api/services',
      '/api/system',
      '/api/connection',
      '/api/admin/audit',
      '/api/admin/users',
      '/api/admin/diagnostics',
    ]) {
      const res = await t.app.inject({ url, headers: { cookie: 'fd_session=forged-token-value' } });
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toMatchObject({ error: 'unauthorized', message: expect.any(String) });
    }
  });

  it('returns 403 to family users on admin APIs', async () => {
    const cookie = await cookieFor(t.app, FAMILY);
    for (const url of ['/api/admin/audit', '/api/admin/users', '/api/admin/diagnostics']) {
      const res = await t.app.inject({ url, headers: { cookie } });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error).toBe('forbidden');
      expect(res.body).not.toContain('login.success');
    }
    const refresh = await t.app.inject({
      method: 'POST',
      url: '/api/services/refresh',
      headers: { cookie },
      payload: {},
    });
    expect(refresh.statusCode).toBe(403);
  });

  it('serves the connection addresses to signed-in users', async () => {
    const cookie = await cookieFor(t.app, FAMILY);
    const res = await t.app.inject({ url: '/api/connection', headers: { cookie } });
    expect(res.json()).toEqual({
      tailnetUrl: 'https://server-home.tail89d77e.ts.net',
      lanUrl: null,
      localUrl: 'http://127.0.0.1:8070',
    });
  });
});

describe('sessions', () => {
  it('logout deletes the session, clears the cookie and later requests get 401', async () => {
    const cookie = await cookieFor(t.app, FAMILY);
    const res = await t.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === 'fd_session');
    expect(cleared?.value).toBe('');
    expect(cleared?.expires?.getTime() ?? 0).toBeLessThan(Date.now());
    expect((await t.app.inject({ url: '/api/session', headers: { cookie } })).statusCode).toBe(401);
    expect(t.app.dashboard.sessions.count()).toBe(0);
    expect((await t.app.dashboard.audit.readLatest(1))[0]?.action).toBe('logout');
  });

  it('stores only token hashes and survives a server restart', async () => {
    const cookie = await cookieFor(t.app, FAMILY);
    const token = cookie.split('=')[1] ?? '';
    await t.app.close();
    const file = await readFile(path.join(t.dataDir, 'sessions.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).toMatch(/"tokenHash": "[0-9a-f]{64}"/);

    const restarted = await createTestApp({ dataDir: t.dataDir, clock: t.clock });
    t = restarted;
    const res = await t.app.inject({ url: '/api/session', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('mama');
  });

  it('expires after 30 days of inactivity but slides with use', async () => {
    const cookie = await cookieFor(t.app, FAMILY);
    t.clock.advance(29 * DAY);
    const used = await t.app.inject({ url: '/api/session', headers: { cookie } });
    expect(used.statusCode).toBe(200);
    expect(used.cookies.find((c) => c.name === 'fd_session')?.maxAge).toBe(30 * 24 * 60 * 60);
    t.clock.advance(29 * DAY);
    expect((await t.app.inject({ url: '/api/session', headers: { cookie } })).statusCode).toBe(200);
    t.clock.advance(30 * DAY + 1000);
    expect((await t.app.inject({ url: '/api/session', headers: { cookie } })).statusCode).toBe(401);
  });

  it('invalidates sessions after a password change or user removal', async () => {
    const familyCookie = await cookieFor(t.app, FAMILY);
    const adminCookie = await cookieFor(t.app, ADMIN);
    t.clock.advance(1000);
    const store = createUserStore(t.dataDir, { clock: t.clock, reloadIntervalMs: 0 });
    const mama = await store.findByUsername('mama');
    const papa = await store.findByUsername('papa');
    if (!mama || !papa) throw new Error('fixture users missing');
    await store.update(mama.id, {
      passwordHash: await hashPassword('another-password-2'),
      passwordChangedAt: t.clock().toISOString(),
    });
    await store.remove(papa.id);
    expect((await t.app.inject({ url: '/api/session', headers: { cookie: familyCookie } })).statusCode).toBe(
      401,
    );
    expect((await t.app.inject({ url: '/api/session', headers: { cookie: adminCookie } })).statusCode).toBe(
      401,
    );
    expect((await login(t.app, 'mama', 'another-password-2')).res.statusCode).toBe(200);
  });

  it('keeps at most 20 sessions per user, dropping the oldest', async () => {
    const dir = await makeTempDir();
    try {
      const clock = createFakeClock();
      const store = createSessionStore(dir, { clock });
      await store.load();
      const tokens: string[] = [];
      for (let i = 0; i < MAX_SESSIONS_PER_USER + 1; i += 1) {
        clock.advance(1000);
        tokens.push((await store.create('user-1')).token);
      }
      expect(store.count()).toBe(MAX_SESSIONS_PER_USER);
      expect(store.lookup(tokens[0] ?? '')).toBeUndefined();
      expect(store.lookup(tokens[MAX_SESSIONS_PER_USER] ?? '')).toBeDefined();
    } finally {
      await removeDir(dir);
    }
  });

  it('sees users added while the server runs (users.json reload)', async () => {
    await addUser(t.dataDir, t.clock, { username: 'babushka', password: 'grandma-password-1' });
    expect((await login(t.app, 'babushka', 'grandma-password-1')).res.statusCode).toBe(200);
  });
});
