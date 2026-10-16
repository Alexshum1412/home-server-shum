import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../src/app.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createTestApp,
  login,
  makeTempDir,
  removeDir,
  type TestApp,
} from './helpers.ts';

let t: TestApp;
const dirs: string[] = [];

beforeEach(async () => {
  t = await createTestApp();
  dirs.push(t.dataDir);
});

afterEach(async () => {
  await t.app.close();
  for (const dir of dirs.splice(0)) await removeDir(dir);
});

describe('runtime basics', () => {
  it('GET /api/health is public and returns only status, version and time', async () => {
    const res = await t.app.inject({ url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['status', 'time', 'version']);
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.time).toBe('2026-10-16T10:00:00.000Z');
  });

  it('puts security headers on every response, including errors and pages', async () => {
    for (const url of ['/api/health', '/api/does-not-exist', '/system', '/api/services']) {
      const res = await t.app.inject({ url });
      expect(res.headers['content-security-policy'], url).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
      expect(res.headers['cross-origin-opener-policy'], url).toBe('same-origin');
      expect(res.headers['x-robots-tag'], url).toBe('noindex, nofollow');
      expect(String(res.headers['permissions-policy']), url).toContain('camera=()');
    }
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
  });

  it('uses exactly the Content-Security-Policy agreed in design D6', async () => {
    const res = await t.app.inject({ url: '/api/health' });
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
    const permissions = String(res.headers['permissions-policy']);
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()']) {
      expect(permissions).toContain(feature);
    }
  });

  it('marks every API response Cache-Control: no-store', async () => {
    for (const url of ['/api/health', '/api/setup-state', '/api/nope', '/api/session']) {
      const res = await t.app.inject({ url });
      expect(res.headers['cache-control'], url).toBe('no-store');
    }
  });

  it('marks percent-encoded API paths no-store too (the router decodes them)', async () => {
    await addUser(t.dataDir, t.clock, ADMIN);
    const cookie = await cookieFor(t.app, ADMIN);
    const session = await t.app.inject({ url: '/%61pi/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.username).toBe(ADMIN.username);
    expect(session.headers['cache-control']).toBe('no-store');
    const unknown = await t.app.inject({ url: '/%61pi/nope', headers: { cookie } });
    expect(unknown.headers['cache-control']).toBe('no-store');
  });

  it('answers unknown /api paths with a JSON 404', async () => {
    const res = await t.app.inject({ url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ error: 'not_found' });
    const post = await t.app.inject({ method: 'POST', url: '/api/nope', payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.json().error).toBe('not_found');
  });

  it('never leaks internal errors', async () => {
    t.app.get('/api/boom', async () => {
      throw new Error('secret internal detail at C:\\path');
    });
    const res = await t.app.inject({ url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: 'Внутренняя ошибка сервера' });
    expect(res.body).not.toContain('secret');
  });
});

describe('request guards', () => {
  it('rejects bodies over 64 KiB with 413', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'x', password: 'y'.repeat(70 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('payload_too_large');
  });

  it('rejects non-JSON state-changing requests with 415', async () => {
    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { 'content-type': contentType },
        payload: 'username=a&password=b',
      });
      expect(res.statusCode, contentType).toBe(415);
      expect(res.json().error).toBe('unsupported_media_type');
    }
    const noType = await t.app.inject({ method: 'POST', url: '/api/logout' });
    expect(noType.statusCode).toBe(415);
  });

  it('accepts JSON with an empty body (logout)', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"username": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_json');
  });

  it('rejects a foreign Origin with 403 and performs no action', async () => {
    await addUser(t.dataDir, t.clock, ADMIN);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'https://evil.example' },
      payload: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden_origin');
    expect(res.cookies).toHaveLength(0);
    expect(await t.app.dashboard.audit.readLatest(10)).toEqual([]);
  });

  it('guards percent-encoded API paths too: foreign origin, cross-site and non-JSON do nothing', async () => {
    await addUser(t.dataDir, t.clock, ADMIN);
    const cookie = await cookieFor(t.app, ADMIN);
    for (const url of ['/%61pi/logout', '/%61pi/services/refresh', '/%61pi/login']) {
      const res = await t.app.inject({
        method: 'POST',
        url,
        headers: { cookie, origin: 'https://evil.example', 'content-type': 'text/plain' },
        payload: 'x',
      });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error, url).toBe('forbidden_origin');
    }
    const crossSite = await t.app.inject({
      method: 'POST',
      url: '/%61pi/logout',
      headers: { cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    });
    expect(crossSite.statusCode).toBe(403);
    const textPlain = await t.app.inject({
      method: 'POST',
      url: '/%61pi/logout',
      headers: { cookie, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(textPlain.statusCode).toBe(415);
    // No side effect: the session survives and nothing but the sign-in was audited.
    expect(t.app.dashboard.sessions.count()).toBe(1);
    expect((await t.app.inject({ url: '/api/session', headers: { cookie } })).statusCode).toBe(200);
    expect((await t.app.dashboard.audit.readLatest(10)).map((e) => e.action)).toEqual(['login.success']);
  });

  it('rejects Sec-Fetch-Site: cross-site', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts the portal own origins', async () => {
    const origins = [
      'http://localhost', // inject() uses Host: localhost:80
      `http://127.0.0.1:${t.config.port}`,
      'https://server-home.tail89d77e.ts.net',
    ];
    for (const origin of origins) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { username: 'nobody', password: 'wrong-password' },
      });
      expect(res.statusCode, origin).toBe(401);
    }
  });

  it('honours X-Forwarded-Host only from the loopback proxy', async () => {
    const headers = { origin: 'https://family.example.ts.net', 'x-forwarded-host': 'family.example.ts.net' };
    const payload = { username: 'nobody', password: 'wrong-password' };
    const viaProxy = await t.app.inject({ method: 'POST', url: '/api/login', headers, payload });
    expect(viaProxy.statusCode).toBe(401);
    const direct = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload,
      remoteAddress: '192.168.1.50',
    });
    expect(direct.statusCode).toBe(403);
  });
});

describe('static UI and SPA fallback', () => {
  it('serves the app shell for deep links and caches assets forever', async () => {
    const webRoot = await makeTempDir('fd-web-');
    dirs.push(webRoot);
    await mkdir(path.join(webRoot, 'assets'));
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>shell-marker</title>');
    await writeFile(path.join(webRoot, 'assets', 'app-123.js'), 'console.log(1)');
    await writeFile(path.join(webRoot, 'sw.js'), 'self.addEventListener("fetch", () => {})');
    const web = await createTestApp({ webRoot });
    dirs.push(web.dataDir);
    try {
      for (const url of ['/', '/system', '/admin/users', '/services/media?x=1']) {
        const res = await web.app.inject({ url });
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).toContain('shell-marker');
        expect(res.headers['content-type'], url).toContain('text/html');
        expect(res.headers['cache-control'], url).toBe('no-cache');
        expect(res.headers['content-security-policy'], url).toBe(CONTENT_SECURITY_POLICY);
      }
      const asset = await web.app.inject({ url: '/assets/app-123.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      const sw = await web.app.inject({ url: '/sw.js' });
      expect(sw.statusCode).toBe(200);
      expect(sw.headers['cache-control']).toBe('no-cache');
      const missingAsset = await web.app.inject({ url: '/assets/missing-999.js' });
      expect(missingAsset.statusCode).toBe(404);
      const api = await web.app.inject({ url: '/api/unknown' });
      expect(api.statusCode).toBe(404);
      expect(api.json().error).toBe('not_found');
    } finally {
      await web.app.close();
    }
  });

  it('explains how to build the UI when dist/web is missing, while the API still works', async () => {
    const res = await t.app.inject({ url: '/system' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Интерфейс ещё не собран. Выполните: npm.cmd run build');
    expect(res.body).not.toContain('<script');
    expect(res.body).not.toContain('style=');
    const health = await t.app.inject({ url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });
});

describe('session cookie attributes', () => {
  it('is HttpOnly, SameSite=Strict, Path=/, 30 days, not Secure over plain local HTTP', async () => {
    await addUser(t.dataDir, t.clock, ADMIN);
    const { res } = await login(t.app, ADMIN.username, ADMIN.password);
    const cookie = res.cookies.find((c) => c.name === 'fd_session');
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(cookie?.path).toBe('/');
    expect(cookie?.maxAge).toBe(30 * 24 * 60 * 60);
    expect(cookie?.secure).toBeFalsy();
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is Secure behind the HTTPS tailnet proxy', async () => {
    await addUser(t.dataDir, t.clock, ADMIN);
    const viaForwardedProto = await login(t.app, ADMIN.username, ADMIN.password, {
      'x-forwarded-proto': 'https',
    });
    expect(viaForwardedProto.res.cookies.find((c) => c.name === 'fd_session')?.secure).toBe(true);
    const viaTsNetHost = await login(t.app, ADMIN.username, ADMIN.password, {
      host: 'server-home.tail89d77e.ts.net',
    });
    expect(viaTsNetHost.res.cookies.find((c) => c.name === 'fd_session')?.secure).toBe(true);
  });
});
