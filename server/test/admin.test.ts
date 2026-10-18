import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditResponse, DiagnosticsResponse, UsersResponse } from '../../shared/api.ts';
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

const ADMIN_URLS = ['/api/admin/audit', '/api/admin/users', '/api/admin/diagnostics'] as const;

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

describe('admin API access', () => {
  it('answers 401 to anonymous visitors', async () => {
    for (const url of ADMIN_URLS) {
      const res = await t.app.inject({ url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error, url).toBe('unauthorized');
    }
  });

  it('answers 403 to family members and returns no data', async () => {
    const cookie = await cookieFor(t.app, FAMILY);
    for (const url of ADMIN_URLS) {
      const res = await t.app.inject({ url, headers: { cookie } });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toEqual({
        error: 'forbidden',
        message: 'Этот раздел доступен только администратору.',
      });
      expect(res.headers['content-disposition'], url).toBeUndefined();
    }
  });

  it('answers 200 to the admin', async () => {
    const cookie = await cookieFor(t.app, ADMIN);
    for (const url of ADMIN_URLS) {
      const res = await t.app.inject({ url, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain('application/json');
      expect(res.headers['cache-control'], url).toBe('no-store');
    }
  });

  it('has no write methods except account management (admin-users.test.ts)', async () => {
    const cookie = await cookieFor(t.app, ADMIN);
    for (const url of ADMIN_URLS) {
      for (const method of ['PUT', 'DELETE'] as const) {
        const res = await t.app.inject({ method, url, headers: { cookie }, payload: {} });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
    }
    for (const url of ['/api/admin/audit', '/api/admin/diagnostics']) {
      const res = await t.app.inject({ method: 'POST', url, headers: { cookie }, payload: {} });
      expect(res.statusCode, `POST ${url}`).toBe(404);
    }
  });
});

describe('GET /api/admin/audit', () => {
  it('returns recent entries newest first with time, action, actor and address', async () => {
    await cookieFor(t.app, FAMILY);
    const cookie = await cookieFor(t.app, ADMIN);
    const res = await t.app.inject({ url: '/api/admin/audit', headers: { cookie } });
    const { entries } = res.json() as AuditResponse;
    expect(entries.map((e) => [e.action, e.actor])).toEqual([
      ['login.success', 'papa'],
      ['login.success', 'mama'],
    ]);
    expect(entries[0]).toEqual({
      time: '2026-10-16T10:00:00.000Z',
      action: 'login.success',
      actor: 'papa',
      ip: '127.0.0.1',
      detail: null,
    });
  });

  it('clamps the limit parameter to 1..500 (default 100)', async () => {
    const cookie = await cookieFor(t.app, ADMIN);
    const spy = vi.spyOn(t.app.dashboard.audit, 'readLatest');
    const cases: Array<[string, number]> = [
      ['', 100],
      ['?limit=5', 5],
      ['?limit=500', 500],
      ['?limit=100000', 500],
      ['?limit=0', 1],
      ['?limit=-3', 100],
      ['?limit=abc', 100],
    ];
    for (const [query, expected] of cases) {
      spy.mockClear();
      const res = await t.app.inject({ url: `/api/admin/audit${query}`, headers: { cookie } });
      expect(res.statusCode, query).toBe(200);
      expect(spy, query).toHaveBeenCalledWith(expected);
    }
    spy.mockRestore();
  });

  it('never returns more than 500 entries', async () => {
    const dir = await makeTempDir();
    const line = (i: number) =>
      JSON.stringify({
        time: '2026-10-15T00:00:00.000Z',
        action: 'logout',
        actor: `u${i}`,
        ip: null,
        detail: null,
      });
    await writeFile(
      path.join(dir, 'audit.jsonl'),
      `${Array.from({ length: 700 }, (_, i) => line(i)).join('\n')}\n`,
    );
    const big = await createTestApp({ dataDir: dir });
    try {
      await addUser(dir, big.clock, ADMIN);
      const cookie = await cookieFor(big.app, ADMIN);
      const res = await big.app.inject({ url: '/api/admin/audit?limit=100000', headers: { cookie } });
      const { entries } = res.json() as AuditResponse;
      expect(entries).toHaveLength(500);
      expect(entries[0]?.action).toBe('login.success');
      expect(entries[1]?.actor).toBe('u699');
    } finally {
      await big.app.close();
      await removeDir(dir);
    }
  });
});

describe('GET /api/admin/users', () => {
  it('lists users read-only without password hashes', async () => {
    const cookie = await cookieFor(t.app, ADMIN);
    const res = await t.app.inject({ url: '/api/admin/users', headers: { cookie } });
    expect(res.body).not.toContain('scrypt$');
    expect(res.body).not.toContain('passwordHash');
    expect(res.body).not.toContain('passwordChangedAt');
    const { users } = res.json() as UsersResponse;
    expect(users.map((u) => [u.username, u.displayName, u.role])).toEqual([
      ['papa', 'Папа', 'admin'],
      ['mama', 'Мама', 'family'],
    ]);
    for (const user of users) {
      expect(Object.keys(user).sort()).toEqual([
        'createdAt',
        'disabled',
        'displayName',
        'id',
        'lastLoginAt',
        'passwordExpiresAt',
        'permissions',
        'role',
        'sessions',
        'temporaryPassword',
        'username',
      ]);
    }
    expect(users.find((u) => u.username === 'papa')?.lastLoginAt).toBe('2026-10-16T10:00:00.000Z');
    expect(users.find((u) => u.username === 'mama')?.lastLoginAt).toBeNull();
  });
});

describe('GET /api/admin/diagnostics', () => {
  it('downloads a JSON report without secrets and audits the export', async () => {
    await t.app.dashboard.collector.collectAll();
    const familyCookie = await cookieFor(t.app, FAMILY);
    const cookie = await cookieFor(t.app, ADMIN);
    const token = cookie.split('=')[1] ?? '';
    const familyToken = familyCookie.split('=')[1] ?? '';
    expect(token).toHaveLength(43);

    const res = await t.app.inject({ url: '/api/admin/diagnostics', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="family-dashboard-diagnostics-2026-10-16.json"',
    );
    expect(res.headers['content-type']).toContain('application/json');

    const raw = res.body;
    expect(raw).not.toContain('scrypt$');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(familyToken);
    expect(raw).not.toContain('fd_session');
    expect(raw).not.toContain(ADMIN.password);
    expect(raw).not.toContain(FAMILY.password);
    // The stored session hashes never leave the server either.
    const sessionsFile = await readFile(path.join(t.dataDir, 'sessions.json'), 'utf8');
    const hashes = sessionsFile.match(/[a-f0-9]{64}/g) ?? [];
    expect(hashes.length).toBeGreaterThanOrEqual(2);
    for (const hash of hashes) expect(raw).not.toContain(hash);

    const body = res.json() as DiagnosticsResponse;
    expect(body.generatedAt).toBe('2026-10-16T10:00:00.000Z');
    expect(body.app).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      node: process.version,
      platform: process.platform,
      demo: false,
    });
    expect(body.config).toMatchObject({ host: '127.0.0.1', port: 8070, userCount: 2, demo: false });
    // Backup settings are paths and numbers only (no file contents).
    expect(body.config).toMatchObject({
      // The test app puts the backup place inside its throwaway data folder (never the real disks).
      backupTargets: t.config.backupTargets.join(';'),
      backupKeep: 14,
      backupExtraFiles: null,
      gitExe: 'git',
    });
    expect(typeof body.config.backupRepoDir).toBe('string');
    expect(body.system.server.hostname).toBe('TEST-SERVER');
    expect(Array.isArray(body.services)).toBe(true);

    const [latest] = await t.app.dashboard.audit.readLatest(1);
    expect(latest).toMatchObject({ action: 'diagnostics.export', actor: 'papa', ip: '127.0.0.1' });
  });
});
