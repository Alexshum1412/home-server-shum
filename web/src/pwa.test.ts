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
  waitUntil(promise: Promise<unknown>): void;
}

/** Runs public/sw.js against fake `self`, `caches` and `fetch`; the cache is keyed by path. */
function loadServiceWorker(network: (request: FakeRequest) => Promise<Response>) {
  const handlers = new Map<string, (event: FetchEvent) => void>();
  const store = new Map<string, Response>();
  const keyOf = (request: Pick<FakeRequest, 'url'> | string) =>
    new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
  const cache = {
    match: async (request: FakeRequest | string) => store.get(keyOf(request))?.clone(),
    put: async (request: FakeRequest | string, response: Response) => {
      store.set(keyOf(request), response);
    },
    addAll: async () => {},
    keys: async () => [...store.keys()].map((path) => ({ url: ORIGIN + path })),
    delete: async (request: Pick<FakeRequest, 'url'> | string) => store.delete(keyOf(request)),
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

  /** Dispatches a fetch event; resolves with the answer once the work the worker asked to wait for is done. */
  async function dispatch(path: string, mode: string): Promise<Response> {
    let responded: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    handlers.get('fetch')?.({
      request: { url: ORIGIN + path, method: 'GET', mode },
      respondWith: (response) => {
        responded = response;
      },
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    if (!responded) throw new Error(`The service worker did not answer ${path}`);
    const response = await responded;
    await Promise.all(pending);
    return response;
  }

  const navigate = (path: string) => dispatch(path, 'navigate');
  /** A subresource request made by the page (script, stylesheet, font). */
  const load = (path: string) => dispatch(path, 'cors');

  return { store, fetch, navigate, load };
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

describe('service worker: hashed assets of old builds', () => {
  const FONT = '/assets/onest-cyrillic-wght-normal-F1.woff2';

  /** The built shell: like Vite's index.html, it links one script and one stylesheet. */
  const shell = (build: string) =>
    `<!doctype html><title>Семейный сервер</title>` +
    `<script type="module" crossorigin src="/assets/index-${build}.js"></script>` +
    `<link rel="stylesheet" crossorigin href="/assets/index-${build}.css">`;

  /** A static server that serves one build at a time; the stylesheet of every build uses the same font. */
  function server(initialBuild: string) {
    const current = { build: initialBuild };
    const network = async (request: FakeRequest) => {
      const path = new URL(request.url).pathname;
      if (request.mode === 'navigate') return basic(html(shell(current.build)));
      const type = path.endsWith('.css')
        ? 'text/css'
        : path.endsWith('.js')
          ? 'text/javascript'
          : 'font/woff2';
      const body = path.endsWith('.css') ? `@font-face{src:url(${FONT}) format("woff2")}` : 'x';
      return basic(new Response(body, { status: 200, headers: { 'content-type': type } }));
    };
    return { current, sw: loadServiceWorker(network) };
  }

  const assetsIn = (store: Map<string, Response>) =>
    [...store.keys()].filter((key) => key.startsWith('/assets/')).sort();

  it('drops the files of the old build once a new shell is stored, keeping the ones it links to', async () => {
    const { current, sw } = server('A1');
    await sw.navigate('/');
    for (const path of ['/assets/index-A1.js', '/assets/index-A1.css', FONT]) await sw.load(path);
    // The new build is deployed; one of its files is already cached (e.g. loaded by another tab).
    current.build = 'A2';
    await sw.load('/assets/index-A2.js');

    await sw.navigate('/');

    expect(assetsIn(sw.store)).not.toContain('/assets/index-A1.js');
    expect(assetsIn(sw.store)).not.toContain('/assets/index-A1.css');
    expect(assetsIn(sw.store)).toContain('/assets/index-A2.js');
    expect(sw.store.has('/')).toBe(true);
  });

  it('keeps the fonts that the cached stylesheet of the current build uses', async () => {
    const { sw } = server('A2');
    await sw.navigate('/');
    for (const path of ['/assets/index-A2.js', '/assets/index-A2.css', FONT]) await sw.load(path);

    await sw.navigate('/system');

    expect(assetsIn(sw.store)).toEqual([FONT, '/assets/index-A2.css', '/assets/index-A2.js'].sort());
  });

  it('cleans nothing when the shell comes from the cache (offline or a 5xx)', async () => {
    const { current, sw } = server('A1');
    await sw.navigate('/');
    await sw.load('/assets/index-A1.js');
    current.build = 'A2';
    sw.store.set('/assets/stale-Z9.js', new Response('x'));
    sw.fetch.mockImplementation(async () => basic(new Response('Bad gateway', { status: 502 })));
    await sw.navigate('/');
    sw.fetch.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    await sw.navigate('/');
    expect(assetsIn(sw.store)).toEqual(['/assets/index-A1.js', '/assets/stale-Z9.js']);
  });
});

describe('index.html', () => {
  it('keeps the iOS status bar readable in the light theme', () => {
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />');
    expect(indexHtml).not.toContain('black-translucent');
  });
});
