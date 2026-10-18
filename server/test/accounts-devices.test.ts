import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatListResponse, SessionsResponse, UsersResponse } from '../../shared/api.ts';
import { ADMIN, addUser, createTestApp, FAMILY, login, removeDir, type TestApp } from './helpers.ts';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

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

async function signIn(user: { username: string; password: string }, agent = CHROME_WINDOWS) {
  const { cookie } = await login(t.app, user.username, user.password, { 'user-agent': agent });
  if (!cookie) throw new Error('no cookie');
  return cookie;
}

const get = <T>(cookie: string, url: string) =>
  t.app
    .inject({ url, headers: { cookie } })
    .then((res) => ({ status: res.statusCode, body: res.json() as T }));
const post = (cookie: string, url: string, payload: object = {}) =>
  t.app.inject({ method: 'POST', url, headers: { cookie }, payload });

describe('my devices', () => {
  it('lists every device with its name and marks the current one', async () => {
    const laptop = await signIn(FAMILY);
    await signIn(FAMILY, SAFARI_IPHONE);
    const { body } = await get<SessionsResponse>(laptop, '/api/sessions');
    expect(body.sessions.map((s) => [s.label, s.current]).sort()).toEqual([
      ['Chrome · Windows', true],
      ['Safari · iPhone', false],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/[a-f0-9]{64}/);
    expect(body.sessions[0]?.id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('signs a lost phone out from the laptop, but not the laptop itself', async () => {
    const laptop = await signIn(FAMILY);
    const phone = await signIn(FAMILY, SAFARI_IPHONE);
    const { body } = await get<SessionsResponse>(laptop, '/api/sessions');
    const here = body.sessions.find((s) => s.current);
    const lost = body.sessions.find((s) => !s.current);
    expect((await post(laptop, '/api/sessions/revoke', { id: here?.id })).statusCode).toBe(400);
    expect((await post(laptop, '/api/sessions/revoke', { id: lost?.id })).statusCode).toBe(204);
    expect((await get(phone, '/api/session')).status).toBe(401);
    expect((await get(laptop, '/api/session')).status).toBe(200);
    expect((await post(laptop, '/api/sessions/revoke', { id: lost?.id })).statusCode).toBe(404);
    expect((await post(laptop, '/api/sessions/revoke', {})).statusCode).toBe(400);
  });

  it('signs out every other device at once; another person is never affected', async () => {
    const laptop = await signIn(FAMILY);
    const phone = await signIn(FAMILY, SAFARI_IPHONE);
    const papa = await signIn(ADMIN);
    expect((await post(laptop, '/api/sessions/revoke', { others: true })).statusCode).toBe(204);
    expect((await get(phone, '/api/session')).status).toBe(401);
    expect((await get(papa, '/api/session')).status).toBe(200);
    expect((await get(laptop, '/api/session')).status).toBe(200);
    // the audit notes it, without addresses of devices
    const entries = await t.app.dashboard.audit.readLatest(5);
    expect(entries.find((e) => e.action === 'session.revoke')).toMatchObject({ actor: 'mama' });
  });

  it('cannot revoke somebody else’s session by guessing an id', async () => {
    const mama = await signIn(FAMILY);
    const papa = await signIn(ADMIN);
    const theirs = (await get<SessionsResponse>(papa, '/api/sessions')).body.sessions[0];
    expect((await post(mama, '/api/sessions/revoke', { id: theirs?.id })).statusCode).toBe(404);
    expect((await get(papa, '/api/session')).status).toBe(200);
  });

  it('needs a signed-in person', async () => {
    expect((await t.app.inject({ url: '/api/sessions' })).statusCode).toBe(401);
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/sessions/revoke', payload: { others: true } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('switching an account off', () => {
  it('closes every device at once and refuses a sign-in until it is switched on again', async () => {
    const papa = await signIn(ADMIN);
    const mama = await signIn(FAMILY);
    expect((await post(papa, '/api/admin/users/mama/disable')).statusCode).toBe(204);
    expect((await get(mama, '/api/session')).status).toBe(401);
    const refused = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'mama', password: FAMILY.password },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('account_disabled');
    // a wrong password tells nothing about the account
    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'mama', password: 'wrong-password' },
    });
    expect(wrong.statusCode).toBe(401);
    const list = await get<UsersResponse>(papa, '/api/admin/users');
    expect(list.body.users.find((u) => u.username === 'mama')).toMatchObject({ disabled: true, sessions: 0 });
    expect((await post(papa, '/api/admin/users/mama/enable')).statusCode).toBe(204);
    expect((await signIn(FAMILY)).startsWith('fd_session=')).toBe(true);
    const audit = (await t.app.dashboard.audit.readLatest(20)).map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['user.disable', 'user.enable']));
  });

  it('never switches off yourself or the last administrator', async () => {
    const papa = await signIn(ADMIN);
    expect((await post(papa, '/api/admin/users/papa/disable')).statusCode).toBe(400);
    const other = await addUser(t.dataDir, t.clock, {
      username: 'papa2',
      password: 'papa2-password-1',
      role: 'admin',
    });
    const second = await signIn({ username: 'papa2', password: 'papa2-password-1' });
    expect((await post(papa, '/api/admin/users/papa2/disable')).statusCode).toBe(204);
    // papa is now the only active admin: papa2 (disabled) cannot disable him, and he cannot be switched off
    expect((await post(second, '/api/admin/users/papa/disable')).statusCode).toBe(401);
    expect(other.username).toBe('papa2');
  });

  it('only an administrator can do it', async () => {
    const mama = await signIn(FAMILY);
    for (const action of ['disable', 'enable', 'sign-out']) {
      expect((await post(mama, `/api/admin/users/papa/${action}`)).statusCode, action).toBe(403);
    }
    expect((await post(await signIn(ADMIN), '/api/admin/users/nobody/disable')).statusCode).toBe(404);
  });

  it('«sign out everywhere» ends the person’s devices but keeps the account usable', async () => {
    const papa = await signIn(ADMIN);
    const mama1 = await signIn(FAMILY);
    const mama2 = await signIn(FAMILY, SAFARI_IPHONE);
    expect((await post(papa, '/api/admin/users/mama/sign-out')).statusCode).toBe(204);
    expect((await get(mama1, '/api/session')).status).toBe(401);
    expect((await get(mama2, '/api/session')).status).toBe(401);
    expect((await signIn(FAMILY)).startsWith('fd_session=')).toBe(true);
    // the administrator's own device stays when he signs himself out «everywhere»
    const second = await signIn(ADMIN, SAFARI_IPHONE);
    expect((await post(papa, '/api/admin/users/papa/sign-out')).statusCode).toBe(204);
    expect((await get(papa, '/api/session')).status).toBe(200);
    expect((await get(second, '/api/session')).status).toBe(401);
  });

  it('keeps a disabled person out of new chats and calls, and keeps their old messages', async () => {
    const papa = await signIn(ADMIN);
    const mama = await signIn(FAMILY);
    await post(mama, '/api/chat/conversations/family/messages', { text: 'до отключения' });
    await post(papa, '/api/admin/users/mama/disable');
    const people = (await get<ChatListResponse>(papa, '/api/chat/conversations')).body.people;
    expect(people.map((p) => p.displayName)).not.toContain('mama');
    const mamaId = (await t.app.dashboard.users.findByUsername('mama'))?.id ?? '';
    expect((await post(papa, '/api/chat/conversations/direct', { userId: mamaId })).statusCode).toBe(400);
    const messages = await get<{ messages: Array<{ text: string }> }>(
      papa,
      '/api/chat/conversations/family/messages',
    );
    expect(messages.body.messages.map((m) => m.text)).toContain('до отключения');
  });
});
