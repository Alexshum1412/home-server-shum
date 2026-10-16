/*
 * Service worker of «Семейный сервер».
 * Caches only the app shell and hashed build assets. API responses are never
 * cached: everything under /api/ always goes to the network.
 */
const CACHE = 'family-shell-v3';
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

/**
 * Page navigations. Every page is the same app shell, so it is stored once under '/',
 * and only when the answer really is the HTML page (not /robots.txt or an icon opened in a tab).
 * Offline, or a 5xx from Tailscale Serve while the portal is down → the cached shell,
 * which then shows its own «Нет связи с домашним сервером» screen.
 */
async function navigation(request) {
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
  if (cacheable(response) && isHtml(response)) await cache.put('/', response.clone());
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(request));
});
