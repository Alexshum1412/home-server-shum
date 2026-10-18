import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionResponse, SessionResponse } from '../../shared/api.ts';
import { publicRouteAllowed } from '../src/lib/channel.ts';
import { ADMIN, addUser, createTestApp, FAMILY, login, removeDir, type TestApp } from './helpers.ts';

const PUBLIC_HOST = 'family.example.org';
const OUTSIDE = { host: PUBLIC_HOST };

let t: TestApp;

async function start(env: Record<string, string> = {}) {
  t = await createTestApp({ env: { PUBLIC_HTTPS_URL: `https://${PUBLIC_HOST}`, ...env } });
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
}

afterEach(async () => {
  await t.app.close();
  await removeDir(t.dataDir);
});

describe('the open-internet address (a protected tunnel)', () => {
  beforeEach(() => start());

  it('knows which way a request came in', async () => {
    const { cookie } = await login(t.app, FAMILY.username, FAMILY.password);
    const get = async (headers: Record<string, string>) =>
      (
        await t.app.inject({ url: '/api/session', headers: { cookie: cookie ?? '', ...headers } })
      ).json<SessionResponse>().channel;
    expect(await get({})).toBe('private');
    expect(await get(OUTSIDE)).toBe('public');
    // the tunnel keeps the public name even when it passes through the local proxy
    expect(await get({ 'x-forwarded-host': PUBLIC_HOST, host: PUBLIC_HOST })).toBe('public');
    // a header of the tunnel's edge can only make a request more restricted
    expect(await get({ 'cf-ray': '8a1b2c3d4e5f-AMS' })).toBe('public');
  });

  it('refuses an unknown name, so a wrong tunnel set-up fails closed', async () => {
    const res = await t.app.inject({ url: '/api/health', headers: { host: 'other.example.net' } });
    expect(res.statusCode).toBe(421);
  });

  it('lets the family sign in, but never as the administrator', async () => {
    const family = await login(t.app, FAMILY.username, FAMILY.password, OUTSIDE);
    expect(family.res.statusCode).toBe(200);
    expect(family.res.json<SessionResponse>().channel).toBe('public');
    expect(family.res.headers['set-cookie']).toMatch(/Secure/i);

    const admin = await login(t.app, ADMIN.username, ADMIN.password, OUTSIDE);
    expect(admin.res.statusCode).toBe(403);
    expect(admin.res.json<{ error: string }>().error).toBe('admin_not_public');
    expect(admin.cookie).toBeUndefined();
    // a wrong password is still told as an ordinary failure: the outsider learns nothing about the account
    const wrong = await login(t.app, ADMIN.username, 'not-the-password', OUTSIDE);
    expect(wrong.res.statusCode).toBe(401);
    // at home the same administrator signs in as usual
    expect((await login(t.app, ADMIN.username, ADMIN.password)).res.statusCode).toBe(200);
  });

  it('keeps the family features and closes everything that changes the server', async () => {
    const { cookie } = await login(t.app, FAMILY.username, FAMILY.password, OUTSIDE);
    const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
      t.app.inject({ method, url, payload, headers: { ...OUTSIDE, cookie: cookie ?? '' } });
    expect((await call('GET', '/api/chat/conversations')).statusCode).toBe(200);
    expect((await call('GET', '/api/notifications')).statusCode).toBe(200);
    expect((await call('GET', '/api/downloads')).statusCode).toBeLessThan(500);
    for (const [method, url] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/diagnostics'],
      ['POST', '/api/services/refresh'],
      ['POST', '/api/downloads'],
      ['POST', '/api/downloads/check'],
    ] as const) {
      const res = await call(method, url, method === 'POST' ? {} : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('channel_restricted');
    }
    // the same requests are not stopped by the channel at home
    const home = await t.app.inject({ url: '/api/connection', headers: { cookie: cookie ?? '' } });
    expect(home.json<ConnectionResponse>().channel).toBe('private');
    expect(home.json<ConnectionResponse>().publicHttpsUrl).toBe(`https://${PUBLIC_HOST}`);
  });

  it('keeps outside attempts apart from the family at home', async () => {
    for (let i = 0; i < 12; i++) await login(t.app, FAMILY.username, 'wrong-password-12', OUTSIDE);
    const blocked = await login(t.app, FAMILY.username, FAMILY.password, OUTSIDE);
    expect(blocked.res.statusCode).toBe(429);
    // the same person at home is not locked out by strangers on the internet
    expect((await login(t.app, FAMILY.username, FAMILY.password)).res.statusCode).toBe(200);
  });

  it('does not turn a blocked route into an open one with an encoded path', async () => {
    const { cookie } = await login(t.app, FAMILY.username, FAMILY.password, OUTSIDE);
    const res = await t.app.inject({
      url: '/api/%61dmin/users',
      headers: { ...OUTSIDE, cookie: cookie ?? '' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('what the open-internet address may reach', () => {
  const stream = { publicAllowMediaStream: false };
  it('is a list: whatever is not named stays closed', () => {
    expect(publicRouteAllowed('GET', '/api/chat/conversations', stream)).toBe(true);
    expect(publicRouteAllowed('POST', '/api/chat/conversations/:id/messages', stream)).toBe(true);
    expect(publicRouteAllowed('POST', '/api/olivia/ask', stream)).toBe(true);
    expect(publicRouteAllowed('GET', '/api/admin/audit', stream)).toBe(false);
    expect(publicRouteAllowed('POST', '/api/admin/olivia/actions/:id', stream)).toBe(false);
    expect(publicRouteAllowed('POST', '/api/downloads/:id/cancel', stream)).toBe(false);
    expect(publicRouteAllowed('POST', '/api/something-new', stream)).toBe(false);
    expect(publicRouteAllowed('GET', '/api/something-new', stream)).toBe(false);
    expect(publicRouteAllowed('GET', '/api/chatty', stream)).toBe(false); // whole path segments only
    expect(publicRouteAllowed('GET', '/', stream)).toBe(true); // the page itself
  });

  it('streams films only when the owner allowed it', () => {
    expect(publicRouteAllowed('GET', '/api/catalog/stream/:id', { publicAllowMediaStream: false })).toBe(
      false,
    );
    expect(publicRouteAllowed('GET', '/api/catalog/stream/:id', { publicAllowMediaStream: true })).toBe(true);
    expect(publicRouteAllowed('GET', '/api/catalog/image/:id', stream)).toBe(true);
  });
});

describe('administrator on the open internet, when the owner allows it', () => {
  beforeEach(() => start({ PUBLIC_ALLOW_ADMIN_LOGIN: '1' }));
  it('may sign in, but the administration stays closed', async () => {
    const { res, cookie } = await login(t.app, ADMIN.username, ADMIN.password, OUTSIDE);
    expect(res.statusCode).toBe(200);
    const users = await t.app.inject({
      url: '/api/admin/users',
      headers: { ...OUTSIDE, cookie: cookie ?? '' },
    });
    expect(users.statusCode).toBe(403);
  });
});

describe('PUBLIC_HTTPS_URL', () => {
  it('takes a real https name only', async () => {
    const { loadConfig } = await import('../src/config.ts');
    expect(loadConfig({ PUBLIC_HTTPS_URL: 'https://family.example.org' }).publicHttpsUrl).toBe(
      'https://family.example.org',
    );
    expect(loadConfig({}).publicHttpsUrl).toBeNull();
    for (const bad of [
      'http://family.example.org',
      'https://203.0.113.5',
      'https://server-home.tail89d77e.ts.net',
      'https://nas.local',
      'https://user:pass@family.example.org',
      'https://localhost',
    ]) {
      expect(() => loadConfig({ PUBLIC_HTTPS_URL: bad }), bad).toThrow();
    }
  });
});
