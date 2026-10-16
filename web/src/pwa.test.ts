import { beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../index.html?raw';
import swSource from '../public/sw.js?raw';

const ORIGIN = 'https://server-home.example.ts.net';
const SHELL_HTML = '<!doctype html><title>Семейный сервер</title>';

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

interface FetchEvent {
  request: FakeRequest;
  respondWith(response: Promise<Response>): void;
}

/** Runs public/sw.js against fake `self`, `caches` and `fetch`; the cache is keyed by path. */
function loadServiceWorker(network: (request: FakeRequest) => Promise<Response>) {
  const handlers = new Map<string, (event: FetchEvent) => void>();
  const store = new Map<string, Response>();
  const keyOf = (request: FakeRequest | string) =>
    new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
  const cache = {
    match: async (request: FakeRequest | string) => store.get(keyOf(request))?.clone(),
    put: async (request: FakeRequest | string, response: Response) => {
      store.set(keyOf(request), response);
    },
    addAll: async () => {},
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: FetchEvent) => void) => handlers.set(type, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const caches = { open: async () => cache, keys: async () => [], delete: async () => true };
  const fetch = vi.fn(network);
  // The worker is a plain script (not a module): run its source with the fakes as its globals.
  new Function('self', 'caches', 'fetch', swSource)(self, caches, fetch);

  async function navigate(path: string): Promise<Response> {
    let responded: Promise<Response> | undefined;
    handlers.get('fetch')?.({
      request: { url: ORIGIN + path, method: 'GET', mode: 'navigate' },
      respondWith: (response) => {
        responded = response;
      },
    });
    if (!responded) throw new Error(`The service worker did not answer ${path}`);
    return responded;
  }

  return { store, fetch, navigate };
}

const html = (body = SHELL_HTML) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

// Response.type is 'default' when constructed in Node; a same-origin browser fetch gives 'basic'.
function basic(response: Response): Response {
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

describe('service worker: page navigations', () => {
  let answer: () => Promise<Response>;
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => {
    answer = async () => basic(html());
    sw = loadServiceWorker(() => answer());
  });

  async function cacheShell() {
    await sw.navigate('/');
    expect(sw.store.has('/')).toBe(true);
  }

  it('stores the HTML shell under «/»', async () => {
    await cacheShell();
  });

  it('serves the cached shell when the network is gone', async () => {
    await cacheShell();
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    const response = await sw.navigate('/system');
    expect(await response.text()).toBe(SHELL_HTML);
  });

  for (const status of [502, 503, 504]) {
    it(`serves the cached shell when Tailscale Serve answers ${status} (portal is down)`, async () => {
      await cacheShell();
      answer = async () =>
        basic(new Response('Bad gateway', { status, headers: { 'content-type': 'text/plain' } }));
      const response = await sw.navigate('/cinema');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(SHELL_HTML);
    });
  }

  it('passes a 5xx through when no shell is cached yet', async () => {
    answer = async () => basic(new Response('Bad gateway', { status: 502 }));
    const response = await sw.navigate('/');
    expect(response.status).toBe(502);
  });

  it('never stores a non-HTML page (robots.txt, an icon) as the app shell', async () => {
    await cacheShell();
    answer = async () =>
      basic(
        new Response('User-agent: *\nDisallow: /', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    await sw.navigate('/robots.txt');
    answer = async () =>
      basic(new Response('PNG', { status: 200, headers: { 'content-type': 'image/png' } }));
    await sw.navigate('/icons/icon-192.png');
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    const response = await sw.navigate('/');
    expect(await response.text()).toBe(SHELL_HTML);
  });
});

describe('index.html', () => {
  it('keeps the iOS status bar readable in the light theme', () => {
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />');
    expect(indexHtml).not.toContain('black-translucent');
  });
});
