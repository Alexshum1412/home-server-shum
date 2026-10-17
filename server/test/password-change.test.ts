import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionResponse, UsersResponse } from '../../shared/api.ts';
import { generatePassword, hashPassword, TEMPORARY_PASSWORD_TTL_MS } from '../src/auth/passwords.ts';
import { createUserStore } from '../src/auth/users.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createTestApp,
  type FakeClock,
  login,
  makeTempDir,
  REPO_ROOT,
  removeDir,
  type TestApp,
} from './helpers.ts';

// Throwaway test-only credentials; they exist only in temp data directories.
const TEMP_PW = 'Temp1-Abcde-Fghij-Kmnpq';
const OWN_PW = 'own-chosen-password-7';

let t: TestApp;

async function addTemporaryUser(role: 'admin' | 'family', expiresInMs = TEMPORARY_PASSWORD_TTL_MS) {
  const store = createUserStore(t.dataDir, { clock: t.clock, reloadIntervalMs: 0 });
  return store.add({
    username: 'owner',
    displayName: 'Хозяин',
    role,
    passwordHash: await hashPassword(TEMP_PW),
    temporaryUntil: new Date(t.clock().getTime() + expiresInMs).toISOString(),
  });
}

function changePassword(cookie: string | undefined, currentPassword: string, newPassword: string) {
  return t.app.inject({
    method: 'POST',
    url: '/api/password',
    headers: cookie ? { cookie } : {},
    payload: { currentPassword, newPassword },
  });
}

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.app.close();
  await removeDir(t.dataDir);
});

describe('generated passwords', () => {
  it('are 4 groups of 5 unambiguous characters and never repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const pw = generatePassword();
      expect(pw).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{5}(-[a-km-zA-HJ-NP-Z2-9]{5}){3}$/);
      seen.add(pw);
    }
    expect(seen.size).toBe(200);
  });
});

describe('temporary password: first sign-in', () => {
  it('signs in, but every API except session/password/logout answers 403 until the password is changed', async () => {
    await addTemporaryUser('admin');
    const { res, cookie } = await login(t.app, 'owner', TEMP_PW);
    expect(res.statusCode).toBe(200);
    expect((res.json() as SessionResponse).mustChangePassword).toBe(true);

    const session = await t.app.inject({ url: '/api/session', headers: { cookie: cookie ?? '' } });
    expect(session.statusCode).toBe(200);
    expect((session.json() as SessionResponse).mustChangePassword).toBe(true);

    for (const url of ['/api/services', '/api/system', '/api/connection', '/api/admin/users']) {
      const blocked = await t.app.inject({ url, headers: { cookie: cookie ?? '' } });
      expect(blocked.statusCode, url).toBe(403);
      expect(blocked.json().error).toBe('password_change_required');
    }
  });

  it('replaces the temporary password: new session works, the old one and other devices are signed out', async () => {
    await addTemporaryUser('admin');
    const first = await login(t.app, 'owner', TEMP_PW);
    const second = await login(t.app, 'owner', TEMP_PW);
    t.clock.advance(1000);

    const res = await changePassword(first.cookie, TEMP_PW, OWN_PW);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as SessionResponse;
    expect(body.mustChangePassword).toBe(false);
    const fresh = res.cookies.find((c) => c.name === 'fd_session');
    expect(fresh?.httpOnly).toBe(true);
    expect(fresh?.sameSite).toBe('Strict');
    const freshCookie = `fd_session=${fresh?.value}`;

    expect((await t.app.inject({ url: '/api/services', headers: { cookie: freshCookie } })).statusCode).toBe(
      200,
    );
    expect(
      (await t.app.inject({ url: '/api/admin/users', headers: { cookie: freshCookie } })).statusCode,
    ).toBe(200);
    for (const old of [first.cookie, second.cookie]) {
      expect((await t.app.inject({ url: '/api/session', headers: { cookie: old ?? '' } })).statusCode).toBe(
        401,
      );
    }
    // The temporary password is gone for good; the own one signs in without the extra step.
    expect((await login(t.app, 'owner', TEMP_PW)).res.statusCode).toBe(401);
    const again = await login(t.app, 'owner', OWN_PW);
    expect((again.res.json() as SessionResponse).mustChangePassword).toBe(false);

    const stored = JSON.parse(await readFile(path.join(t.dataDir, 'users.json'), 'utf8')).users[0];
    expect(stored.mustChangePassword).toBe(false);
    expect(stored.passwordExpiresAt).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(OWN_PW);

    const audit = await readFile(path.join(t.dataDir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"action":"password.change"');
    expect(audit).not.toContain(OWN_PW);
    expect(audit).not.toContain(TEMP_PW);
  });

  it('refuses an expired temporary password only after it matched', async () => {
    await addTemporaryUser('family', 60_000);
    t.clock.advance(61_000);
    const expired = await login(t.app, 'owner', TEMP_PW);
    expect(expired.res.statusCode).toBe(403);
    expect(expired.res.json().error).toBe('temporary_password_expired');
    expect(expired.cookie).toBeUndefined();
    // A wrong password still gets the plain answer: nothing about the account leaks.
    const wrong = await login(t.app, 'owner', 'not-the-password-1');
    expect(wrong.res.statusCode).toBe(401);
    expect(wrong.res.json().error).toBe('invalid_credentials');
  });

  it('lists the temporary password state for the admin without any hash', async () => {
    await addUser(t.dataDir, t.clock, ADMIN);
    await addTemporaryUser('family');
    const cookie = await cookieFor(t.app, ADMIN);
    const res = await t.app.inject({ url: '/api/admin/users', headers: { cookie } });
    const users = (res.json() as UsersResponse).users;
    expect(users.find((u) => u.username === 'papa')).toMatchObject({
      temporaryPassword: false,
      passwordExpiresAt: null,
    });
    expect(users.find((u) => u.username === 'owner')?.temporaryPassword).toBe(true);
    expect(res.body).not.toContain('scrypt$');
  });
});

describe('POST /api/password', () => {
  beforeEach(async () => {
    await addUser(t.dataDir, t.clock, ADMIN);
  });

  it('needs a session', async () => {
    const res = await changePassword(undefined, ADMIN.password, OWN_PW);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong current password, a weak or unchanged new one', async () => {
    const cookie = await cookieFor(t.app, ADMIN);
    const wrong = await changePassword(cookie, 'wrong-password-123', OWN_PW);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe('wrong_password');

    const short = await changePassword(cookie, ADMIN.password, 'short');
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toBe('weak_password');

    const same = await changePassword(cookie, ADMIN.password, ADMIN.password);
    expect(same.statusCode).toBe(400);
    expect(same.json().message).toMatch(/отличаться/);

    const asLogin = await changePassword(cookie, ADMIN.password, 'papa');
    expect(asLogin.statusCode).toBe(400);

    const empty = await changePassword(cookie, '', OWN_PW);
    expect(empty.statusCode).toBe(400);

    // Nothing changed: the original password still signs in.
    expect((await login(t.app, ADMIN.username, ADMIN.password)).res.statusCode).toBe(200);
  });

  it('limits guesses of the current password like failed sign-ins', async () => {
    const cookie = await cookieFor(t.app, ADMIN);
    let last = await changePassword(cookie, 'wrong-password-0', OWN_PW);
    for (let i = 1; i < 12; i += 1) last = await changePassword(cookie, `wrong-password-${i}`, OWN_PW);
    expect(last.statusCode).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
    // The correct password is refused too while the limit holds.
    expect((await changePassword(cookie, ADMIN.password, OWN_PW)).statusCode).toBe(429);
  });

  it('is protected by the origin check like every other change', async () => {
    const cookie = await cookieFor(t.app, ADMIN);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/password',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { currentPassword: ADMIN.password, newPassword: OWN_PW },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden_origin');
  });
});

describe('users CLI --generate-password', { timeout: 60_000 }, () => {
  let dataDir: string;
  let apps: TestApp[];

  beforeEach(async () => {
    dataDir = await makeTempDir('fd-cli-gen-');
    apps = [];
  });

  afterEach(async () => {
    for (const a of apps) await a.app.close();
    await removeDir(dataDir);
  });

  function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(REPO_ROOT, 'server', 'src', 'cli', 'users.ts'), ...args],
        {
          cwd: REPO_ROOT,
          env: {
            SystemRoot: process.env.SystemRoot,
            PATH: process.env.PATH,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            USERPROFILE: dataDir,
            LOCALAPPDATA: dataDir,
            DASHBOARD_DATA_DIR: dataDir,
          },
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
  }

  function printedPassword(stdout: string): string {
    const match = /Временный пароль:\s+(\S+)/.exec(stdout);
    if (!match?.[1]) throw new Error(`no password in output: ${stdout}`);
    return match[1];
  }

  it('creates an admin with a one-time password that must be replaced at the first sign-in', async () => {
    const res = await runCli(['add', 'alex', '--name', 'Алекс', '--role', 'admin', '--generate-password']);
    expect(res.code, res.stderr).toBe(0);
    const password = printedPassword(res.stdout);
    expect(res.stdout).toContain('показан один раз');

    const stored = JSON.parse(await readFile(path.join(dataDir, 'users.json'), 'utf8')).users[0];
    expect(stored).toMatchObject({ username: 'alex', role: 'admin', mustChangePassword: true });
    const ttl = Date.parse(stored.passwordExpiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(TEMPORARY_PASSWORD_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(TEMPORARY_PASSWORD_TTL_MS);
    expect(JSON.stringify(stored)).not.toContain(password);

    const list = await runCli(['list']);
    expect(list.stdout).toMatch(/alex\s+Алекс\s+администратор.*временный, до/);
    expect(list.stdout).not.toContain(password);

    const realClock = Object.assign(() => new Date(), { advance: () => undefined }) as FakeClock;
    const app = await createTestApp({ dataDir, clock: realClock });
    apps.push(app);
    const signed = await login(app.app, 'alex', password);
    expect(signed.res.statusCode).toBe(200);
    expect((signed.res.json() as SessionResponse).mustChangePassword).toBe(true);
  });

  it('passwd --generate-password resets a forgotten password to a new temporary one', async () => {
    expect((await runCli(['add', 'mama', '--name', 'Мама', '--generate-password'])).code).toBe(0);
    const reset = await runCli(['passwd', 'mama', '--generate-password']);
    expect(reset.code, reset.stderr).toBe(0);
    const password = printedPassword(reset.stdout);
    const stored = JSON.parse(await readFile(path.join(dataDir, 'users.json'), 'utf8')).users[0];
    expect(stored.mustChangePassword).toBe(true);
    expect(stored.role).toBe('family');

    const realClock = Object.assign(() => new Date(), { advance: () => undefined }) as FakeClock;
    const app = await createTestApp({ dataDir, clock: realClock });
    apps.push(app);
    expect((await login(app.app, 'mama', password)).res.statusCode).toBe(200);
  });

  it('refuses --generate-password together with --password-stdin', async () => {
    const res = await runCli(['add', 'mama', '--generate-password', '--password-stdin']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('что-то одно');
  });
});
