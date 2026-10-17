import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_KEY_APP, LIBRARIES, setupJellyfin } from '../src/cli/jellyfin-setup.ts';
import { makeTempDir, removeDir } from './helpers.ts';

const KEY = '0123456789abcdef0123456789abcdef';
let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('fd-jf-');
});
afterEach(async () => {
  await removeDir(dir);
});

/** Minimal in-memory Jellyfin: records every call and answers like the 12.x API. */
function fakeJellyfin(state: { wizardDone: boolean }) {
  const calls: Array<{ method: string; url: string; body: unknown; auth: string }> = [];
  const folders: string[] = [];
  const keys: Array<{ AccessToken: string; AppName: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
    calls.push({ method, url: url.pathname + url.search, body, auth });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    const route = `${method} ${url.pathname}`;
    switch (route) {
      case 'GET /System/Info/Public':
        return json({ Version: '12.2.0', StartupWizardCompleted: state.wizardDone });
      case 'POST /Startup/Complete':
        state.wizardDone = true;
        return new Response(null, { status: 204 });
      case 'POST /Users/AuthenticateByName':
        return json({ AccessToken: 'session-token' });
      case 'GET /Auth/Keys':
        return json({ Items: keys });
      case 'POST /Auth/Keys':
        keys.push({ AccessToken: KEY, AppName: url.searchParams.get('app') ?? '' });
        return new Response(null, { status: 204 });
      case 'GET /Library/VirtualFolders':
        return json(folders.map((Name) => ({ Name })));
      case 'POST /Library/VirtualFolders':
        folders.push(url.searchParams.get('name') ?? '');
        return new Response(null, { status: 204 });
      default:
        if (
          route.startsWith('POST /Startup/') ||
          route === 'GET /Startup/User' ||
          route === 'POST /Library/Refresh'
        ) {
          return new Response(null, { status: 204 });
        }
        return new Response('not found', { status: 404 });
    }
  }) as typeof fetch;
  return { calls, folders, fetchImpl };
}

describe('setupJellyfin', () => {
  it('runs the wizard once, saves an API key, adds libraries without heavy image extraction', async () => {
    const state = { wizardDone: false };
    const jf = fakeJellyfin(state);
    const apiKeyFile = path.join(dir, 'jellyfin-api.json');
    const result = await setupJellyfin({
      baseUrl: 'http://127.0.0.1:8096',
      adminName: 'alex',
      mediaRoot: path.join(dir, 'Media'),
      apiKeyFile,
      fetch: jf.fetchImpl,
    });
    expect(result.wizardCompleted).toBe(true);
    expect(result.adminPassword).toMatch(/^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);
    const user = jf.calls.find((c) => c.url === '/Startup/User' && c.method === 'POST');
    expect(user?.body).toEqual({ Name: 'alex', Password: result.adminPassword });
    expect(jf.calls.find((c) => c.url === '/Startup/RemoteAccess')?.body).toEqual({
      EnableRemoteAccess: false,
    });
    expect(jf.calls.find((c) => c.url === '/Startup/Configuration')?.body).toMatchObject({ UICulture: 'ru' });

    const saved = JSON.parse(await readFile(apiKeyFile, 'utf8'));
    expect(saved).toMatchObject({ apiKey: KEY, app: API_KEY_APP });
    // The admin password itself is never written anywhere.
    expect(JSON.stringify(saved)).not.toContain(result.adminPassword ?? '-');

    expect(jf.folders).toEqual(LIBRARIES.map((l) => l.name));
    const add = jf.calls.find((c) => c.url.startsWith('/Library/VirtualFolders?'));
    expect(add?.body).toMatchObject({
      LibraryOptions: { EnableTrickplayImageExtraction: false, EnableChapterImageExtraction: false },
    });
    // After the key exists, everything else uses it (the admin session token is not kept).
    expect(add?.auth).toContain(`Token="${KEY}"`);
    expect(jf.calls.at(-1)?.url).toBe('/Library/Refresh');
  });

  it('is idempotent: a second run changes nothing and prints no password', async () => {
    const state = { wizardDone: false };
    const jf = fakeJellyfin(state);
    const opts = {
      baseUrl: 'http://127.0.0.1:8096',
      adminName: 'alex',
      mediaRoot: path.join(dir, 'Media'),
      apiKeyFile: path.join(dir, 'jellyfin-api.json'),
      fetch: jf.fetchImpl,
    };
    await setupJellyfin(opts);
    const again = await setupJellyfin(opts);
    expect(again).toEqual({
      wizardCompleted: false,
      adminPassword: null,
      apiKeySaved: false,
      librariesAdded: [],
    });
    expect(jf.folders).toHaveLength(LIBRARIES.length);
    expect(jf.calls.filter((c) => c.url.startsWith('/Library/VirtualFolders?')).length).toBe(
      LIBRARIES.length,
    );
  });

  it('explains what to do when the wizard was completed by hand and there is no key', async () => {
    const jf = fakeJellyfin({ wizardDone: true });
    await expect(
      setupJellyfin({
        baseUrl: 'http://127.0.0.1:8096',
        adminName: 'alex',
        mediaRoot: path.join(dir, 'Media'),
        apiKeyFile: path.join(dir, 'missing.json'),
        fetch: jf.fetchImpl,
      }),
    ).rejects.toThrow(/ключ API/);
  });
});
