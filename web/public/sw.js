/*
 * Service worker of «Семейный сервер».
 * Caches only the app shell and hashed build assets. API responses are never
 * cached: everything under /api/ always goes to the network.
 */
const CACHE = 'family-shell-v4';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/favicon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function cacheable(response) {
  // Redirected responses must not be replayed for navigations.
  return response.ok && response.type === 'basic' && !response.redirected;
}

function isHtml(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/html');
}

/** Network first; on success refresh the cached copy; offline → cached copy. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (cacheable(response)) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

/** Paths of the /assets/ files mentioned in a text (the shell HTML, a stylesheet, a script). */
function assetPaths(text) {
  return (text.match(/assets\/[^"'`\s<>()?#,;]+/g) || []).map((match) => `/${match}`);
}

/**
 * Hashed files are never overwritten, so every past build would stay in the cache forever.
 * After a new shell is stored, delete the cached /assets/ files it no longer uses. Kept: the files
 * the shell links to and, through the cached stylesheets and scripts among them, the files those
 * link to (the fonts are referenced only from the stylesheet). Nothing outside /assets/ is touched.
 */
async function pruneAssets(cache, html) {
  // Snapshot first: a file cached after this point belongs to the page being loaded now.
  const requests = await cache.keys();
  const keep = new Set(assetPaths(html));
  const queue = [...keep];
  while (queue.length > 0) {
    const path = queue.pop();
    if (!/\.(css|js)$/.test(path)) continue;
    const cached = await cache.match(path);
    if (!cached) continue;
    for (const nested of assetPaths(await cached.text())) {
      if (keep.has(nested)) continue;
      keep.add(nested);
      queue.push(nested);
    }
  }
  await Promise.all(
    requests
      .filter((request) => {
        const path = new URL(request.url).pathname;
        return path.startsWith('/assets/') && !keep.has(path);
      })
      .map((request) => cache.delete(request)),
  );
}

/**
 * Page navigations. Every page is the same app shell, so it is stored once under '/',
 * and only when the answer really is the HTML page (not /robots.txt or an icon opened in a tab).
 * Offline, or a 5xx from Tailscale Serve while the portal is down → the cached shell,
 * which then shows its own «Нет связи с домашним сервером» screen.
 * `waitUntil` keeps the worker alive for the cleanup without delaying the page.
 */
async function navigation(request, waitUntil) {
  const cache = await caches.open(CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cached = await cache.match('/');
    if (cached) return cached;
    throw error;
  }
  if (response.status >= 500) {
    const cached = await cache.match('/');
    return cached || response;
  }
  if (cacheable(response) && isHtml(response)) {
    const shell = response.clone();
    await cache.put('/', response.clone());
    // Best effort: a failed cleanup only leaves old files in the cache until the next shell.
    waitUntil(
      shell
        .text()
        .then((html) => pruneAssets(cache, html))
        .catch(() => {}),
    );
  }
  return response;
}

/** Hashed files under /assets/ never change: cache first. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) await cache.put(request, response.clone());
  return response;
}

/*
 * Notifications from the server (Web Push). The text is already short and safe to show; a click
 * opens the page named in it (only a path of this site, never another address).
 */
function safePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // The person is looking at the portal right now: the page shows the news itself.
      if (windows.some((client) => client.visibilityState === 'visible' && client.focused)) return;
      await self.registration.showNotification(String(data.title || 'Семейный сервер').slice(0, 120), {
        body: String(data.body || '').slice(0, 300),
        tag: String(data.tag || data.kind || 'family'),
        renotify: true,
        icon: '/icons/icon-192.png',
        badge: '/icons/favicon-32.png',
        data: { url: safePath(data.url) },
        requireInteraction: data.kind === 'call',
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = safePath(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          client.postMessage({ type: 'open', path });
          return;
        }
      }
      await self.clients.openWindow(path);
    })(),
  );
});

/* The browser replaced the subscription (expired, cleared): subscribe again and tell the server. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const key = old?.options?.applicationServerKey;
      if (!key) return;
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      const json = subscription.toJSON();
      await fetch('/api/notifications/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
    })().catch(() => {}),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request, (promise) => event.waitUntil(promise)));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(request));
});
