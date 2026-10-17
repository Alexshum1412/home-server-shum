import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionResponse } from '../../shared/api.ts';
import { loadConfig } from '../src/config.ts';
import { isPrivateLanAddress, type LanListeners, listenOnLan } from '../src/lan.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, removeDir, type TestApp } from './helpers.ts';

/** A free TCP port on the loopback alias used as a stand-in for the home-network address. */
async function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host, port: 0 }, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** GET with an explicit Host header (fetch() does not let a script choose it). */
function get(host: string, port: number, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const request = http.request(
      { host, port, path: '/api/health', method: 'GET', headers: { host: hostHeader } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', () => resolve({ status: 0, body: '' }));
    request.end();
  });
}

describe('LAN_BIND configuration', () => {
  it('is off by default and derives the portal address from a bound address', () => {
    expect(loadConfig({}, 'win32').lanBind).toEqual([]);
    const config = loadConfig({ LAN_BIND: '192.168.1.252', PORT: '8070' }, 'win32');
    expect(config.lanBind).toEqual(['192.168.1.252']);
    expect(config.lanUrl).toBe('http://192.168.1.252:8070');
    expect(Object.isFrozen(config.lanBind)).toBe(true);
  });

  it('keeps an explicit LAN_URL and accepts several addresses', () => {
    const config = loadConfig(
      { LAN_BIND: '192.168.1.252, 10.0.0.5;192.168.1.252', LAN_URL: 'http://server-home.local:8070/' },
      'win32',
    );
    expect(config.lanBind).toEqual(['192.168.1.252', '10.0.0.5']);
    expect(config.lanUrl).toBe('http://server-home.local:8070');
  });

  it.each(['0.0.0.0', '::', '8.8.8.8', '100.116.219.8', '192.168.1.999', 'server-home', '172.32.0.1'])(
    'refuses %s: only private addresses of the home network are allowed',
    (address) => {
      expect(() => loadConfig({ LAN_BIND: address }, 'win32')).toThrow(/LAN_BIND/);
    },
  );

  it('recognises private addresses', () => {
    for (const ok of ['192.168.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '127.0.0.2']) {
      expect(isPrivateLanAddress(ok), ok).toBe(true);
    }
    for (const bad of ['0.0.0.0', '169.254.1.1', '100.64.0.1', '172.15.0.1', '1.1.1.1', '192.169.0.1', '']) {
      expect(isPrivateLanAddress(bad), bad).toBe(false);
    }
  });
});

describe('listening on the home-network address', () => {
  let t: TestApp | null = null;
  let lan: LanListeners | null = null;

  afterEach(async () => {
    await lan?.close();
    await t?.app.close();
    if (t) await removeDir(t.dataDir);
    t = null;
    lan = null;
  });

  it('answers on its own address, refuses foreign Host names and reports an unavailable address', async () => {
    const port = await freePort('127.0.0.2');
    t = await createTestApp({ env: { LAN_BIND: '127.0.0.2', PORT: String(port) } });
    await t.app.ready();
    lan = await listenOnLan(t.app, ['127.0.0.2', '10.254.254.1'], port);
    expect(lan.bound).toEqual(['127.0.0.2']);
    expect(lan.failed.map((item) => item.address)).toEqual(['10.254.254.1']);
    expect(lan.failed[0]?.reason).toMatch(/нет на этом компьютере|не удалось|EADDR|address/i);

    const own = await get('127.0.0.2', port, `127.0.0.2:${port}`);
    expect(own.status).toBe(200);
    expect(JSON.parse(own.body).status).toBe('ok');
    // DNS rebinding through the home-network address is refused like on the loopback one.
    expect((await get('127.0.0.2', port, `evil.example:${port}`)).status).toBe(421);
    expect((await get('127.0.0.2', port, `192.168.1.1:${port}`)).status).toBe(421);
  });

  it('shows the address only while it is really listening, and the reason only to administrators', async () => {
    const port = await freePort('127.0.0.2');
    t = await createTestApp({ env: { LAN_BIND: '127.0.0.2', PORT: String(port) } });
    await addUser(t.dataDir, t.clock, ADMIN);
    await addUser(t.dataDir, t.clock, FAMILY);
    const admin = await cookieFor(t.app, ADMIN);
    const family = await cookieFor(t.app, FAMILY);
    const connection = async (cookie: string) =>
      (await t?.app.inject({ url: '/api/connection', headers: { cookie } }))?.json() as ConnectionResponse;

    // Nothing is listening yet (the IP changed, the adapter is down): no address is advertised.
    t.app.dashboard.lan.failed = [{ address: '127.0.0.2', reason: 'порт на этом адресе уже занят' }];
    expect((await connection(family)).lanUrl).toBeNull();
    expect((await connection(family)).lanProblem).toBeNull();
    expect((await connection(admin)).lanProblem).toContain('127.0.0.2');

    t.app.dashboard.lan.bound = ['127.0.0.2'];
    t.app.dashboard.lan.failed = [];
    expect((await connection(family)).lanUrl).toBe(`http://127.0.0.2:${port}`);
    expect((await connection(admin)).lanProblem).toBeNull();
  });

  it('does not advertise a manually set LAN_URL as failed when LAN_BIND is not used', async () => {
    t = await createTestApp({ env: { LAN_URL: 'http://192.168.1.10:8070' } });
    await addUser(t.dataDir, t.clock, FAMILY);
    const family = await cookieFor(t.app, FAMILY);
    const body = (
      await t.app.inject({ url: '/api/connection', headers: { cookie: family } })
    ).json() as ConnectionResponse;
    expect(body.lanUrl).toBe('http://192.168.1.10:8070');
  });
});
