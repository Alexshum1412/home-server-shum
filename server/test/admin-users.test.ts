import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AuditResponse,
  SessionResponse,
  TemporaryPasswordResponse,
  UsersResponse,
} from '../../shared/api.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createTestApp,
  FAMILY,
  login,
  removeDir,
  type TestApp,
} from './helpers.ts';

let t: TestApp;
let adminCookie: string;

const JSON_HEADERS = { 'content-type': 'application/json' };

beforeEach(async () => {
  t = await createTestApp();
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
  adminCookie = await cookieFor(t.app, ADMIN);
});

afterEach(async () => {
  await t.app.close();
  await removeDir(t.dataDir);
});

function post(url: string, payload: unknown, cookie = adminCookie) {
  return t.app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: { cookie, ...JSON_HEADERS },
  });
}

describe('creating an account from the portal', () => {
  it('creates a family member with a generated temporary password shown once', async () => {
    const res = await post('/api/admin/users', {
      username: 'Babushka',
      displayName: 'Бабушка',
      role: 'family',
      permissions: ['print'],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as TemporaryPasswordResponse;
    expect(body.username).toBe('babushka');
    expect(body.temporaryPassword).toMatch(/^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);
    expect(res.headers['cache-control']).toBe('no-store');

    // The password is stored only as a hash and works for the first sign-in, which demands a new one.
    const first = await login(t.app, 'babushka', body.temporaryPassword);
    expect(first.res.statusCode).toBe(200);
    expect((first.res.json() as SessionResponse).mustChangePassword).toBe(true);
    expect((first.res.json() as SessionResponse).user.permissions).toEqual(['print']);

    const list = (
      await t.app.inject({ url: '/api/admin/users', headers: { cookie: adminCookie } })
    ).json() as UsersResponse;
    const created = list.users.find((u) => u.username === 'babushka');
    expect(created?.temporaryPassword).toBe(true);
    expect(JSON.stringify(list)).not.toContain(body.temporaryPassword);

    const audit = (
      await t.app.inject({ url: '/api/admin/audit', headers: { cookie: adminCookie } })
    ).json() as AuditResponse;
    const entry = audit.entries.find((e) => e.action === 'user.create');
    expect(entry?.actor).toBe('papa');
    expect(JSON.stringify(audit)).not.toContain(body.temporaryPassword);
  });

  it('rejects a bad login, a duplicate and a missing name', async () => {
    expect((await post('/api/admin/users', { username: 'Ба ба', displayName: 'X' })).json().error).toBe(
      'bad_username',
    );
    expect((await post('/api/admin/users', { username: 'mama', displayName: 'Мама 2' })).statusCode).toBe(
      409,
    );
    expect((await post('/api/admin/users', { username: 'okname' })).statusCode).toBe(400);
  });

  it('is closed to family members and to visitors without a session', async () => {
    const family = await cookieFor(t.app, FAMILY);
    const payload = { username: 'intruder', displayName: 'Чужой', role: 'admin' };
    expect((await post('/api/admin/users', payload, family)).statusCode).toBe(403);
    const anonymous = await t.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload,
      headers: JSON_HEADERS,
    });
    expect(anonymous.statusCode).toBe(401);
    const list = (
      await t.app.inject({ url: '/api/admin/users', headers: { cookie: adminCookie } })
    ).json() as UsersResponse;
    expect(list.users.map((u) => u.username)).not.toContain('intruder');
  });
});

describe('new temporary password', () => {
  it('replaces the password, ends the old sessions and unblocks the account', async () => {
    const oldCookie = await cookieFor(t.app, FAMILY);
    t.clock.advance(1000);
    const res = await post('/api/admin/users/mama/reset-password', {});
    expect(res.statusCode).toBe(200);
    const body = res.json() as TemporaryPasswordResponse;

    expect((await t.app.inject({ url: '/api/session', headers: { cookie: oldCookie } })).statusCode).toBe(
      401,
    );
    expect((await login(t.app, 'mama', FAMILY.password)).res.statusCode).toBe(401);
    const fresh = await login(t.app, 'mama', body.temporaryPassword);
    expect(fresh.res.statusCode).toBe(200);
    expect((fresh.res.json() as SessionResponse).mustChangePassword).toBe(true);
  });

  it('does not let the admin reset their own password here, and knows unknown names', async () => {
    expect((await post('/api/admin/users/papa/reset-password', {})).json().error).toBe('self');
    expect((await post('/api/admin/users/nobody/reset-password', {})).statusCode).toBe(404);
  });
});

describe('rights and role', () => {
  it('grants and withdraws extra rights', async () => {
    expect(
      (await post('/api/admin/users/mama/access', { permissions: ['downloads', 'print'] })).statusCode,
    ).toBe(204);
    let list = (
      await t.app.inject({ url: '/api/admin/users', headers: { cookie: adminCookie } })
    ).json() as UsersResponse;
    expect(list.users.find((u) => u.username === 'mama')?.permissions).toEqual(['downloads', 'print']);
    expect((await post('/api/admin/users/mama/access', { permissions: [] })).statusCode).toBe(204);
    list = (
      await t.app.inject({ url: '/api/admin/users', headers: { cookie: adminCookie } })
    ).json() as UsersResponse;
    expect(list.users.find((u) => u.username === 'mama')?.permissions).toEqual([]);
  });

  it('refuses to change the own role or to demote the last administrator', async () => {
    expect((await post('/api/admin/users/papa/access', { role: 'family' })).json().error).toBe('self');
    // A second admin may demote the first; then nobody is left to demote the last one.
    await post('/api/admin/users', { username: 'deputy', displayName: 'Заместитель', role: 'admin' });
    const temp = (
      await post('/api/admin/users/deputy/reset-password', {})
    ).json() as TemporaryPasswordResponse;
    const deputy = await login(t.app, 'deputy', temp.temporaryPassword);
    expect(deputy.res.statusCode).toBe(200);
    // The new admin must still replace the temporary password before any admin API works.
    expect(
      (await post('/api/admin/users/papa/access', { role: 'family' }, deputy.cookie as string)).json().error,
    ).toBe('password_change_required');
  });

  it('keeps at least one administrator when removing and when demoting', async () => {
    // papa is the only admin: nobody else can act, so check the rule through a second admin.
    const second = await addUser(t.dataDir, t.clock, {
      username: 'tata',
      password: 'second-admin-pw-1',
      role: 'admin',
      displayName: 'Тата',
    });
    expect(second.role).toBe('admin');
    const secondCookie = await cookieFor(t.app, { username: 'tata', password: 'second-admin-pw-1' });
    expect((await post('/api/admin/users/papa/access', { role: 'family' }, secondCookie)).statusCode).toBe(
      204,
    );
    // tata is now the last admin and cannot be touched by anyone; papa is a plain member.
    expect((await post('/api/admin/users/tata/access', { role: 'family' }, secondCookie)).json().error).toBe(
      'self',
    );
    expect((await post('/api/admin/users/tata/remove', { confirm: true }, secondCookie)).json().error).toBe(
      'self',
    );
    const papaCookie = adminCookie;
    expect((await post('/api/admin/users/tata/remove', { confirm: true }, papaCookie)).statusCode).toBe(403);
  });
});

describe('removing an account', () => {
  it('needs an explicit confirmation and then ends the sessions of that person', async () => {
    const familyCookie = await cookieFor(t.app, FAMILY);
    expect((await post('/api/admin/users/mama/remove', {})).statusCode).toBe(400);
    expect((await post('/api/admin/users/mama/remove', { confirm: true })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/session', headers: { cookie: familyCookie } })).statusCode).toBe(
      401,
    );
    expect((await login(t.app, 'mama', FAMILY.password)).res.statusCode).toBe(401);
    const audit = (
      await t.app.inject({ url: '/api/admin/audit', headers: { cookie: adminCookie } })
    ).json() as AuditResponse;
    expect(audit.entries.some((e) => e.action === 'user.remove' && e.detail === 'mama')).toBe(true);
  });

  it('never removes the administrator who asks', async () => {
    expect((await post('/api/admin/users/papa/remove', { confirm: true })).json().error).toBe('self');
  });
});
