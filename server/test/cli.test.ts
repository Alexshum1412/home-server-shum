import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionResponse } from '../../shared/api.ts';
import {
  createTestApp,
  type FakeClock,
  login,
  makeTempDir,
  REPO_ROOT,
  removeDir,
  type TestApp,
} from './helpers.ts';

const CLI = path.join(REPO_ROOT, 'server', 'src', 'cli', 'users.ts');

// Throwaway test-only credentials; they exist only in temp data directories.
const ADMIN_PW = 'cli-admin-password-1';
const FAMILY_PW = 'cli-family-password-1';
const NEW_PW = 'cli-changed-password-2';
const SHORT_PW = 'short-pw1';
const SECRETS = [ADMIN_PW, FAMILY_PW, NEW_PW, SHORT_PW, 'scrypt$'];

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let dataDir: string;
let outputs: string[];
let apps: TestApp[];

beforeEach(async () => {
  dataDir = await makeTempDir('fd-cli-');
  outputs = [];
  apps = [];
});

afterEach(async () => {
  for (const t of apps) await t.app.close();
  await removeDir(dataDir);
  // Whatever happened in the test, the CLI never printed a password or a hash.
  const all = outputs.join('\n');
  for (const secret of SECRETS) expect(all).not.toContain(secret);
});

/** Minimal environment: the real data directory (%LOCALAPPDATA%\FamilyDashboard) is unreachable. */
function cliEnv(dir: string): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: dir,
    LOCALAPPDATA: dir,
    DASHBOARD_DATA_DIR: dir,
  };
}

function runCli(args: string[], input = ''): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: cliEnv(dataDir),
      windowsHide: true,
    });
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
    child.stdin.on('error', () => undefined); // the CLI may exit before reading stdin
    child.on('error', reject);
    child.on('close', (code) => {
      outputs.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function addViaCli(username: string, name: string, role: 'admin' | 'family', password: string) {
  const res = await runCli(
    ['add', username, '--name', name, '--role', role, '--password-stdin'],
    `${password}\n`,
  );
  expect(res.code, res.stderr).toBe(0);
  return res;
}

async function seed(): Promise<void> {
  await addViaCli('papa', 'Папа', 'admin', ADMIN_PW);
  await addViaCli('mama', 'Мама', 'family', FAMILY_PW);
}

async function storedUsers(): Promise<Array<{ username: string; role: string; passwordHash: string }>> {
  return JSON.parse(await readFile(path.join(dataDir, 'users.json'), 'utf8')).users;
}

/** App on the same data dir with the real clock, so CLI timestamps and sessions compare correctly. */
async function appOnDataDir(): Promise<TestApp> {
  const realClock = Object.assign(() => new Date(), { advance: () => undefined }) as FakeClock;
  const t = await createTestApp({ dataDir, clock: realClock });
  apps.push(t);
  return t;
}

describe('users CLI', { timeout: 60_000 }, () => {
  it('adds an admin and a family member via --password-stdin and lists them without hashes', async () => {
    const added = await addViaCli('papa', 'Папа', 'admin', ADMIN_PW);
    expect(added.stdout).toContain('«papa» (Папа, роль: администратор) создан');
    await addViaCli('Mama', 'Мама', 'family', FAMILY_PW);

    const stored = await storedUsers();
    expect(stored.map((u) => [u.username, u.role])).toEqual([
      ['papa', 'admin'],
      ['mama', 'family'],
    ]);
    for (const user of stored) expect(user.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/);

    const list = await runCli(['list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/papa\s+Папа\s+администратор/);
    expect(list.stdout).toMatch(/mama\s+Мама\s+семья/);
    expect(list.stdout).toContain('не входил');

    const t = await appOnDataDir();
    expect((await login(t.app, 'papa', ADMIN_PW)).res.statusCode).toBe(200);
    const family = await login(t.app, 'mama', FAMILY_PW);
    expect((family.res.json() as SessionResponse).user.role).toBe('family');
  });

  it('rejects a duplicate or invalid login name', async () => {
    await seed();
    const duplicate = await runCli(['add', 'papa', '--password-stdin'], `${NEW_PW}\n`);
    expect(duplicate.code).not.toBe(0);
    expect(duplicate.stderr).toContain('уже существует');
    const invalid = await runCli(['add', 'папа', '--password-stdin'], `${NEW_PW}\n`);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain('Недопустимый логин');
    expect(await storedUsers()).toHaveLength(2);
  });

  it('rejects a password shorter than 10 characters', async () => {
    const res = await runCli(['add', 'papa', '--role', 'admin', '--password-stdin'], `${SHORT_PW}\n`);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('Пароль слишком короткий: нужно не меньше 10 символов.');
    const list = await runCli(['list']);
    expect(list.stdout).toContain('Пользователей пока нет');
  });

  it('rejects a password equal to the login name', async () => {
    const res = await runCli(['add', 'grandmother', '--password-stdin'], 'GrandMother\n');
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('Пароль не должен совпадать с логином.');
    expect(res.stdout + res.stderr).not.toContain('GrandMother');
  });

  it('refuses to read a password from a non-terminal without --password-stdin', async () => {
    const res = await runCli(['add', 'papa', '--role', 'admin'], `${ADMIN_PW}\n`);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--password-stdin');
  });

  it('passwd changes the password and ends existing sessions', async () => {
    await seed();
    const t = await appOnDataDir();
    const before = await login(t.app, 'mama', FAMILY_PW);
    expect(before.res.statusCode).toBe(200);
    const oldCookie = before.cookie ?? '';
    expect((await t.app.inject({ url: '/api/session', headers: { cookie: oldCookie } })).statusCode).toBe(
      200,
    );

    const passwd = await runCli(['passwd', 'mama', '--password-stdin'], `${NEW_PW}\n`);
    expect(passwd.code, passwd.stderr).toBe(0);
    expect(passwd.stdout).toContain('Пароль пользователя «mama» изменён');

    expect((await t.app.inject({ url: '/api/session', headers: { cookie: oldCookie } })).statusCode).toBe(
      401,
    );
    expect((await login(t.app, 'mama', FAMILY_PW)).res.statusCode).toBe(401);
    const after = await login(t.app, 'mama', NEW_PW);
    expect(after.res.statusCode).toBe(200);
    const fresh = await t.app.inject({ url: '/api/session', headers: { cookie: after.cookie ?? '' } });
    expect(fresh.statusCode).toBe(200);
  });

  it('passwd applies the password policy and reports unknown users', async () => {
    await seed();
    const short = await runCli(['passwd', 'mama', '--password-stdin'], `${SHORT_PW}\n`);
    expect(short.code).not.toBe(0);
    const unknown = await runCli(['passwd', 'nobody', '--password-stdin'], `${NEW_PW}\n`);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('«nobody» не найден');
  });

  it('changes a role, effective immediately for the signed-in user', async () => {
    await seed();
    const t = await appOnDataDir();
    const { cookie } = await login(t.app, 'mama', FAMILY_PW);
    const promote = await runCli(['role', 'mama', 'admin']);
    expect(promote.code, promote.stderr).toBe(0);
    expect(promote.stdout).toContain('изменена на «администратор»');
    expect((await storedUsers()).find((u) => u.username === 'mama')?.role).toBe('admin');
    const session = await t.app.inject({ url: '/api/session', headers: { cookie: cookie ?? '' } });
    expect((session.json() as SessionResponse).user.role).toBe('admin');
    const admin = await t.app.inject({ url: '/api/admin/users', headers: { cookie: cookie ?? '' } });
    expect(admin.statusCode).toBe(200);

    const bad = await runCli(['role', 'mama', 'owner']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('family или admin');
  });

  it('refuses to demote or remove the last admin', async () => {
    await seed();
    const demote = await runCli(['role', 'papa', 'family']);
    expect(demote.code).not.toBe(0);
    expect(demote.stderr).toContain('Нельзя снять роль с последнего администратора');
    const remove = await runCli(['remove', 'papa', '--yes']);
    expect(remove.code).not.toBe(0);
    expect(remove.stderr).toContain('Нельзя удалить последнего администратора');
    expect((await storedUsers()).map((u) => [u.username, u.role])).toEqual([
      ['papa', 'admin'],
      ['mama', 'family'],
    ]);

    // With a second admin, the first one can be demoted.
    expect((await runCli(['role', 'mama', 'admin'])).code).toBe(0);
    expect((await runCli(['role', 'papa', 'family'])).code).toBe(0);
  });

  it('removes a user only with --yes, and the removed user can no longer sign in', async () => {
    await seed();
    const t = await appOnDataDir();
    const { cookie } = await login(t.app, 'mama', FAMILY_PW);

    const withoutYes = await runCli(['remove', 'mama']);
    expect(withoutYes.code).toBe(2);
    expect(withoutYes.stderr).toContain('--yes');
    expect(await storedUsers()).toHaveLength(2);

    const removed = await runCli(['remove', 'mama', '--yes']);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain('«mama» удалён');
    expect((await storedUsers()).map((u) => u.username)).toEqual(['papa']);
    expect((await runCli(['list'])).stdout).not.toContain('mama');

    expect((await t.app.inject({ url: '/api/session', headers: { cookie: cookie ?? '' } })).statusCode).toBe(
      401,
    );
    expect((await login(t.app, 'mama', FAMILY_PW)).res.statusCode).toBe(401);
  });

  it('fails clearly on unknown commands and options', async () => {
    const unknown = await runCli(['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Неизвестная команда');
    const option = await runCli(['list', '--password=x']);
    expect(option.code).toBe(2);
    expect(option.stderr).toContain('Неизвестный параметр');
  });
});
