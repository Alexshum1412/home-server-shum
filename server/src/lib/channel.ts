/**
 * Two ways in: the private one (Tailscale, the home network, this PC) and the public one (a protected
 * HTTPS tunnel on the open internet, PUBLIC_HTTPS_URL). A tunnel only carries the request to this
 * PC — it is not a login. Through the public way the portal offers ordinary family features only:
 * nothing of the administration, no restart/restore/print/download-start, no diagnostics.
 *
 * The decision is made on the address the request came to and on the headers a tunnel's edge adds
 * (Cloudflare's «cf-*»). A header can only make a request MORE restricted: a person on the tailnet who
 * sends «cf-ray» on purpose just loses the administration for that one request.
 */
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';

export type Channel = 'private' | 'public';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const EDGE_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cf-access-jwt-assertion'];

const known = new WeakMap<FastifyRequest, Channel>();

/** The host the browser asked for: the trusted local proxy's X-Forwarded-Host when present, else Host. */
function effectiveHost(request: FastifyRequest): string {
  const fromProxy = LOOPBACK.has(request.socket.remoteAddress ?? '');
  const forwarded = request.headers['x-forwarded-host'];
  if (fromProxy && forwarded !== undefined) {
    const first = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded).split(',')[0] ?? '';
    return first.trim().toLowerCase();
  }
  return (request.headers.host ?? '').trim().toLowerCase();
}

export function requestChannel(request: FastifyRequest, config: Pick<Config, 'publicHttpsUrl'>): Channel {
  const cached = known.get(request);
  if (cached) return cached;
  let channel: Channel = 'private';
  if (EDGE_HEADERS.some((name) => request.headers[name] !== undefined)) channel = 'public';
  else if (config.publicHttpsUrl !== null) {
    const publicHost = new URL(config.publicHttpsUrl).host.toLowerCase();
    const host = effectiveHost(request);
    if (host === publicHost || host === `${publicHost}:443`) channel = 'public';
  }
  known.set(request, channel);
  return channel;
}

/** Whether a path prefix covers the route pattern (whole path segments only). */
function covers(prefix: string, route: string): boolean {
  return route === prefix || route.startsWith(`${prefix}/`);
}

/** Looking at things: chat, calls, notifications, files and photos, the cinema, calendar, Olivia's status. */
const READ = [
  '/api/health',
  '/api/session',
  '/api/sessions',
  '/api/setup-state',
  '/api/connection',
  '/api/chat',
  '/api/calls',
  '/api/events',
  '/api/notifications',
  '/api/storage',
  '/api/catalog',
  '/api/calendar',
  '/api/notes',
  '/api/olivia/status',
  '/api/downloads',
  '/api/services',
  '/api/system',
  '/api/print',
];

/** Doing things in one's own account: signing in and out, writing messages, keeping files, asking Olivia. */
const WRITE = [
  '/api/login',
  '/api/logout',
  '/api/password',
  '/api/sessions',
  '/api/chat',
  '/api/calls',
  '/api/notifications',
  '/api/storage',
  '/api/catalog/progress',
  '/api/calendar',
  '/api/notes',
  '/api/olivia/ask',
];

/** Films are large: a tunnel of a free plan is not meant for video, so streaming is off unless the owner turns it on. */
const STREAM = ['/api/catalog/stream', '/api/media/file'];

export const PUBLIC_RESTRICTED_MESSAGE =
  'Это действие недоступно через внешний адрес. Откройте портал через Tailscale или домашнюю сеть.';

/**
 * Whether the public way may reach this API route. Everything not listed is closed — a route added
 * later stays closed on the open internet until someone lists it here on purpose.
 */
export function publicRouteAllowed(
  method: string,
  route: string,
  config: Pick<Config, 'publicAllowMediaStream'>,
): boolean {
  if (!route.startsWith('/api')) return true;
  if (STREAM.some((prefix) => covers(prefix, route)))
    return config.publicAllowMediaStream && (method === 'GET' || method === 'HEAD');
  const list = method === 'GET' || method === 'HEAD' ? READ : WRITE;
  return list.some((prefix) => covers(prefix, route));
}
