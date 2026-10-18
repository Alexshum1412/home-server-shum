import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallConfigResponse } from '../../shared/api.ts';
import { createCloudflareTurn, parseIceServers } from '../src/calls/cloudflare-turn.ts';
import { loadConfig } from '../src/config.ts';
import {
  ADMIN,
  addUser,
  cookieFor,
  createFakeClock,
  createTestApp,
  FAMILY,
  makeTempDir,
  removeDir,
  type TestApp,
} from './helpers.ts';

const KEY_ID = 'a'.repeat(32);

describe('relay servers from Cloudflare', () => {
  it('reads both shapes of the answer and drops addresses that are not STUN or TURN', () => {
    const list = parseIceServers({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'https://evil.example/x'] },
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443'],
          username: 'u',
          credential: 'c',
        },
        { urls: ['http://not-turn'] },
      ],
    });
    expect(list).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443'],
        username: 'u',
        credential: 'c',
      },
    ]);
    expect(
      parseIceServers({ iceServers: { urls: 'turn:t.example:3478', username: 'u', credential: 'c' } }),
    ).toHaveLength(1);
    expect(parseIceServers(null)).toEqual([]);
    expect(parseIceServers({ iceServers: 'x' })).toEqual([]);
  });

  describe('credentials', () => {
    let dir: string;
    let tokenFile: string;
    beforeEach(async () => {
      dir = await makeTempDir('fd-cf-');
      tokenFile = path.join(dir, 'cf-turn.token');
      await writeFile(tokenFile, 'secret-token-value\n');
    });
    afterEach(() => removeDir(dir));

    const answer = (servers: unknown) =>
      new Response(JSON.stringify({ iceServers: servers }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    it('asks once, sends the token only as a bearer header, and reuses the answer until it runs low', async () => {
      const clock = createFakeClock();
      const seen: Array<{ url: string; auth: string | null; body: string }> = [];
      const turn = createCloudflareTurn({
        settings: { keyId: KEY_ID, tokenFile, ttlSec: 3600 },
        clock,
        fetch: async (url, init) => {
          seen.push({
            url: String(url),
            auth: new Headers(init?.headers).get('authorization'),
            body: String(init?.body),
          });
          return answer([{ urls: ['turn:t.example:3478'], username: 'u', credential: 'c' }]);
        },
      });
      expect(await turn.iceServers()).toHaveLength(1);
      expect(await turn.iceServers()).toHaveLength(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`,
      );
      expect(seen[0]?.auth).toBe('Bearer secret-token-value');
      expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ ttl: 3600 });
      clock.advance(3600 * 800); // past three quarters of the lifetime
      await turn.iceServers();
      expect(seen).toHaveLength(2);
    });

    it('answers null, without throwing and without leaking the token, when Cloudflare or the file fails', async () => {
      const messages: string[] = [];
      const clock = createFakeClock();
      const down = createCloudflareTurn({
        settings: { keyId: KEY_ID, tokenFile, ttlSec: 3600 },
        clock,
        fetch: async () => new Response('no', { status: 503 }),
        onError: (message) => messages.push(message),
      });
      expect(await down.iceServers()).toBeNull();
      const noFile = createCloudflareTurn({
        settings: { keyId: KEY_ID, tokenFile: path.join(dir, 'missing'), ttlSec: 3600 },
        clock,
        fetch: async () => answer([]),
        onError: (message) => messages.push(message),
      });
      expect(await noFile.iceServers()).toBeNull();
      expect(messages).toHaveLength(2);
      expect(messages.join(' ')).not.toContain('secret-token-value');
    });
  });

  it('rejects half-set or odd settings at start-up', () => {
    expect(() => loadConfig({ CALLS_CF_TURN_KEY_ID: KEY_ID })).toThrow(/CALLS_CF_TURN_TOKEN_FILE/);
    expect(() =>
      loadConfig({ CALLS_CF_TURN_KEY_ID: 'short', CALLS_CF_TURN_TOKEN_FILE: 'C:\\secrets\\t' }),
    ).toThrow(/CALLS_CF_TURN_KEY_ID/);
    expect(() =>
      loadConfig({ CALLS_CF_TURN_KEY_ID: KEY_ID, CALLS_CF_TURN_TOKEN_FILE: 'relative/path' }),
    ).toThrow(/полный путь/);
    expect(loadConfig({}).calls.cloudflare).toBeNull();
  });
});

describe('the call configuration a browser receives', () => {
  let t: TestApp;
  let dir: string;
  afterEach(async () => {
    await t.app.close();
    await removeDir(t.dataDir);
    await removeDir(dir);
  });

  it('adds the Cloudflare relay to the list and never shows the token', async () => {
    dir = await makeTempDir('fd-cf2-');
    await mkdir(dir, { recursive: true });
    const tokenFile = path.join(dir, 'cf.token');
    await writeFile(tokenFile, 'top-secret-token');
    t = await createTestApp({
      env: {
        CALLS_CF_TURN_KEY_ID: KEY_ID,
        CALLS_CF_TURN_TOKEN_FILE: tokenFile,
        CALLS_STUN_URLS: 'stun:stun.example.org:3478',
      },
      callsFetch: async () =>
        new Response(
          JSON.stringify({
            iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'user', credential: 'pass' }],
          }),
          { status: 200 },
        ),
    });
    await addUser(t.dataDir, t.clock, ADMIN);
    await addUser(t.dataDir, t.clock, FAMILY);
    const cookie = await cookieFor(t.app, FAMILY);
    const res = await t.app.inject({ url: '/api/calls/config', headers: { cookie } });
    const body = res.json<CallConfigResponse>();
    expect(body.relay).toBe('turn');
    expect(body.iceServers.map((server) => server.urls[0])).toEqual([
      'stun:stun.example.org:3478',
      'turn:turn.cloudflare.com:3478',
    ]);
    expect(res.body).not.toContain('top-secret-token');
  });

  it('keeps working without a relay when Cloudflare is down', async () => {
    dir = await makeTempDir('fd-cf3-');
    const tokenFile = path.join(dir, 'cf.token');
    await writeFile(tokenFile, 'x');
    t = await createTestApp({
      env: { CALLS_CF_TURN_KEY_ID: KEY_ID, CALLS_CF_TURN_TOKEN_FILE: tokenFile },
      callsFetch: async () => new Response('down', { status: 502 }),
    });
    await addUser(t.dataDir, t.clock, FAMILY);
    const cookie = await cookieFor(t.app, FAMILY);
    const res = await t.app.inject({ url: '/api/calls/config', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json<CallConfigResponse>()).toMatchObject({ relay: 'none', iceServers: [] });
  });
});
