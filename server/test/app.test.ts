import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import net from 'node:net';
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
      `http://localhost:${t.config.port}`,
      `http://127.0.0.1:${t.config.port}`,
      `http://[::1]:${t.config.port}`,
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
    const payload = { username: 'nobody', password: 'wrong-password' };
    // Tailscale Serve: raw Host is the loopback port, X-Forwarded-Host the tailnet name.
    const viaProxy = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        origin: 'https://server-home.tail89d77e.ts.net',
        'x-forwarded-host': 'server-home.tail89d77e.ts.net',
      },
      payload,
    });
    expect(viaProxy.statusCode).toBe(401);
    // From a LAN peer the header is ignored, so it cannot vouch for a foreign Origin either.
    const direct = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'https://family.example.ts.net', 'x-forwarded-host': 'family.example.ts.net' },
      payload,
      remoteAddress: '192.168.1.50',
    });
    expect(direct.statusCode).toBe(403);
  });
});

describe('host allowlist (DNS rebinding)', () => {
  const REBIND_HOST = 'rebind.attacker.test:8070';
  const BAD_HOST_BODY = { error: 'bad_host', message: 'Запрос отклонён: неизвестный адрес сервера.' };

  it('answers 421 to a foreign Host even with a matching Origin, on every kind of request', async () => {
    await addUser(t.dataDir, t.clock, ADMIN);
    const headers = { host: REBIND_HOST, origin: `http://${REBIND_HOST}` };
    const requests = [
      { method: 'GET' as const, url: '/api/health' },
      { method: 'GET' as const, url: '/api/setup-state' },
      { method: 'GET' as const, url: '/' },
      { method: 'GET' as const, url: '/api/nope' },
      { method: 'HEAD' as const, url: '/api/health' },
      { method: 'OPTIONS' as const, url: '/api/login' },
      {
        method: 'POST' as const,
        url: '/api/login',
        payload: { username: ADMIN.username, password: ADMIN.password },
      },
    ];
    for (const request of requests) {
      const label = `${request.method} ${request.url}`;
      const res = await t.app.inject({ ...request, headers });
      expect(res.statusCode, label).toBe(421);
      expect(res.headers['content-security-policy'], label).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-content-type-options'], label).toBe('nosniff');
      expect(res.cookies, label).toHaveLength(0);
      if (request.method !== 'HEAD') {
        expect(res.json(), label).toEqual(BAD_HOST_BODY);
        expect(res.body, label).not.toContain('attacker');
      }
    }
    expect(await t.app.dashboard.audit.readLatest(10)).toEqual([]);
    expect(t.app.dashboard.sessions.count()).toBe(0);
  });

  it('keeps a rebinding page with a rotating X-Forwarded-For away from /api/login', async () => {
    for (let i = 0; i < 40; i += 1) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/login',
        headers: {
          host: REBIND_HOST,
          origin: `http://${REBIND_HOST}`,
          'x-forwarded-for': `203.0.113.${i}`,
        },
        payload: { username: `guess${i}`, password: `wrong-password-${i}` },
      });
      expect(res.statusCode, `attempt ${i}`).toBe(421);
    }
    // Nothing reached the login handler: no failures counted, no forged addresses audited.
    expect(await t.app.dashboard.audit.readLatest(100)).toEqual([]);
    expect(t.app.dashboard.limiter.byUser.check('guess0').allowed).toBe(true);
  });

  it('accepts the portal own addresses, case-insensitively', async () => {
    const port = t.config.port;
    const allowed: Array<Record<string, string>> = [
      { host: `127.0.0.1:${port}` },
      { host: `localhost:${port}` },
      { host: `LocalHost:${port}` },
      { host: `[::1]:${port}` },
      // Tailscale Serve may forward the tailnet name as the raw Host...
      { host: 'server-home.tail89d77e.ts.net' },
      { host: 'Server-Home.tail89d77e.ts.net' },
      { host: 'server-home.tail89d77e.ts.net:443' },
      // ...or the loopback port with the tailnet name in X-Forwarded-Host.
      { host: `127.0.0.1:${port}`, 'x-forwarded-host': 'server-home.tail89d77e.ts.net' },
      // npm run dev: the Vite dev server forwards the browser's Host unchanged.
      { host: '127.0.0.1:5173' },
      { host: 'localhost:5173' },
    ];
    for (const headers of allowed) {
      const res = await t.app.inject({ url: '/api/health', headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(200);
    }
  });

  it('rejects other ports, unknown names and a foreign X-Forwarded-Host from the proxy', async () => {
    const port = t.config.port;
    const rejected: Array<{ headers: Record<string, string>; remoteAddress?: string }> = [
      { headers: { host: `127.0.0.1:${port + 1}` } },
      { headers: { host: 'localhost:80' } },
      { headers: { host: 'localhost' } },
      { headers: { host: '127.0.0.1' } },
      { headers: { host: `server-home.tail89d77e.ts.net:${port}` } },
      { headers: { host: `127.0.0.1:${port}.evil.test` } },
      { headers: { host: `192.168.1.10:${port}` } }, // LAN_URL is not configured
      { headers: { host: `127.0.0.1:${port}`, 'x-forwarded-host': 'evil.test' } },
      {
        headers: {
          host: `127.0.0.1:${port}`,
          'x-forwarded-host': 'evil.test, server-home.tail89d77e.ts.net',
        },
      },
      {
        headers: {
          host: `127.0.0.1:${port}`,
          'x-forwarded-host': 'server-home.tail89d77e.ts.net, evil.test',
        },
      },
      // The dev-server address is accepted only from the local Vite proxy.
      { headers: { host: '127.0.0.1:5173' }, remoteAddress: '192.168.1.50' },
    ];
    for (const { headers, remoteAddress } of rejected) {
      const res = await t.app.inject({ url: '/api/health', headers, remoteAddress });
      expect(res.statusCode, JSON.stringify(headers)).toBe(421);
      expect(res.json().error).toBe('bad_host');
    }
  });

  it('allows the LAN address only when LAN_URL is set, and the tailnet name only with PUBLIC_URL', async () => {
    const lan = await createTestApp({ env: { LAN_URL: 'http://192.168.1.10:8070', PUBLIC_URL: '' } });
    dirs.push(lan.dataDir);
    try {
      const ok = await lan.app.inject({ url: '/api/health', headers: { host: '192.168.1.10:8070' } });
      expect(ok.statusCode).toBe(200);
      const tailnet = await lan.app.inject({
        url: '/api/health',
        headers: { host: 'server-home.tail89d77e.ts.net' },
      });
      expect(tailnet.statusCode).toBe(421);
    } finally {
      await lan.app.close();
    }
  });

  it('checks the raw Host header on a real socket, and rejects a request without one', async () => {
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const address = t.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    const send = (head: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(address.port, '127.0.0.1', () => socket.end(`${head}\r\n\r\n`));
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          text += chunk;
        });
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
      });
    const port = t.config.port;
    expect(await send('GET /api/health HTTP/1.0')).toMatch(/^HTTP\/1\.1 421 /);
    expect(await send(`GET /api/health HTTP/1.1\r\nHost: ${REBIND_HOST}\r\nConnection: close`)).toMatch(
      /^HTTP\/1\.1 421 /,
    );
    expect(await send(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close`)).toMatch(
      /^HTTP\/1\.1 200 /,
    );
  });
});

describe('startup cleanup', () => {
  it('removes temp files left by an interrupted atomic write in the data dir, and nothing else', async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const old = new Date(Date.now() - 10 * 60_000);
    const orphans = ['.users.json.4242.0123456789ab.tmp', '.sessions.json.17.abcdef012345.tmp'];
    // Same pattern but brand new: may be a write in progress (e.g. scripts\user.cmd), so it stays.
    const fresh = '.services.json.4242.fedcba987654.tmp';
    const others = [
      'notes.tmp',
      'users.json.tmp',
      '.users.json.tmp',
      '.users.json.4242.0123456789ab.tmp.bak',
    ];
    const nested = path.join('logs', '.x.json.1.0123456789ab.tmp');
    const folder = '.folder.json.1.0123456789ab.tmp';
    await mkdir(path.join(dir, 'logs'));
    await mkdir(path.join(dir, folder));
    for (const name of [...orphans, fresh, ...others, nested]) await writeFile(path.join(dir, name), 'x');
    for (const name of [...orphans, ...others, nested, folder]) await utimes(path.join(dir, name), old, old);

    const started = await createTestApp({ dataDir: dir });
    await started.app.close();

    const left = new Set(await readdir(dir));
    for (const name of orphans) expect(left.has(name), name).toBe(false);
    for (const name of [fresh, ...others, folder, 'logs']) expect(left.has(name), name).toBe(true);
    expect(await readdir(path.join(dir, 'logs'))).toEqual([path.basename(nested)]);
  });
});

describe('request logging', () => {
  it('writes nothing for ordinary requests; a 5xx gets one line without query string or headers', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const stream = { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) };
    const logged = await createTestApp({ logger: { level: 'info', stream } });
    dirs.push(logged.dataDir);
    try {
      logged.app.get('/api/boom', async () => {
        throw new Error('boom');
      });
      for (const url of ['/api/health?token=abc', '/api/session', '/api/nope']) {
        await logged.app.inject({ url, headers: { cookie: 'fd_session=x' } });
      }
      expect(lines.filter((line) => line.reqId !== undefined)).toEqual([]);

      await logged.app.inject({ url: '/api/boom?secret=1', headers: { cookie: 'fd_session=x' } });
      const responseLines = lines.filter((line) => line.statusCode === 500);
      expect(responseLines).toHaveLength(1);
      expect(responseLines[0]).toMatchObject({ method: 'GET', url: '/api/boom', statusCode: 500 });
      const text = JSON.stringify(lines);
      expect(text).not.toContain('secret=1');
      expect(text).not.toContain('fd_session');
    } finally {
      await logged.app.close();
    }
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
