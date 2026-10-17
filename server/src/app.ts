import { promises as fsp } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
  LogController,
} from 'fastify';
import type { ConnectionResponse, HealthResponse } from '../../shared/api.ts';
import { registerAdminRoutes } from './admin/routes.ts';
import { type AuditLog, createAuditLog } from './audit/log.ts';
import { createGuards, currentUser, type Guards } from './auth/guards.ts';
import { createLoginTimes, type LoginTimes } from './auth/logins.ts';
import { createLoginLimiter, type LoginLimiter } from './auth/rate-limit.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { createSessionStore, type SessionStore } from './auth/sessions.ts';
import { createUserStore, type UserStore } from './auth/users.ts';
import type { Config } from './config.ts';
import { createDownloadManager, type DownloadManager, statfsFree } from './downloads/manager.ts';
import { registerDownloadRoutes } from './downloads/routes.ts';
import { registerFileRoutes } from './files/routes.ts';
import { createStorage } from './files/storage.ts';
import { isApiPath, sendError, urlPath } from './lib/http.ts';
import { removeStaleTempFiles } from './lib/json-store.ts';
import { type Clock, isoNow, systemClock } from './lib/time.ts';
import { readAppVersion } from './lib/version.ts';
import { createMediaLibrary } from './media/library.ts';
import { registerMediaRoutes } from './media/routes.ts';
import type { ActionDeps } from './olivia/actions.ts';
import type { LlmFetch } from './olivia/llm.ts';
import { registerOliviaRoutes } from './olivia/routes.ts';
import { createCalendarStore } from './planner/calendar.ts';
import { createNotes } from './planner/notes.ts';
import { registerPlannerRoutes } from './planner/routes.ts';
import type { IppTransport } from './print/ipp.ts';
import { createPrintQueue } from './print/queue.ts';
import { registerPrintRoutes } from './print/routes.ts';
import { createServiceRegistry, type FetchLike, type ServiceRegistry } from './services/checker.ts';
import { registerServiceRoutes } from './services/routes.ts';
import { DEFAULT_WEB_ROOT, registerStatic, sendSpaFallback } from './static.ts';
import { createSystemCollector, type ProbeTimeouts, type SystemCollector } from './system/collector.ts';
import { createDefaultProbes, type SystemProbes } from './system/probes.ts';
import { registerSystemRoutes } from './system/routes.ts';

export const BODY_LIMIT = 64 * 1024;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** Tailscale Serve proxies to the loopback port; only loopback peers may set X-Forwarded-*. */
const TRUSTED_PROXIES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const TRUSTED_PROXY_SET = new Set(TRUSTED_PROXIES);

/**
 * `npm run dev`: the Vite dev server (vite.config.ts, 127.0.0.1:5173, changeOrigin: false) forwards
 * the browser's own Host. Accepted only from a loopback peer; a DNS-rebinding page can never send
 * a loopback name as Host (its Host is the attacker's domain), so this opens nothing.
 */
const DEV_UI_HOSTS = new Set(['127.0.0.1:5173', 'localhost:5173']);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AppContext {
  config: Config;
  clock: Clock;
  version: string;
  startedAt: string;
  users: UserStore;
  logins: LoginTimes;
  sessions: SessionStore;
  audit: AuditLog;
  limiter: LoginLimiter;
  registry: ServiceRegistry;
  collector: SystemCollector;
  guards: Guards;
  downloads: DownloadManager;
  /** What the extra home-network listeners (LAN_BIND) actually did; filled in by index.ts. */
  lan: { bound: string[]; failed: Array<{ address: string; reason: string }> };
}

export type DashboardApp = FastifyInstance & { dashboard: AppContext };

export interface BuildAppOptions {
  config: Config;
  /** Defaults to pino at `config.logLevel` with secret redaction; tests pass `false`. */
  logger?: FastifyServerOptions['logger'];
  clock?: Clock;
  /** fetch used by service health checks. */
  fetch?: FetchLike;
  probes?: SystemProbes;
  probeTimeouts?: Partial<ProbeTimeouts>;
  /** Start periodic service checks and system probes (index.ts: true, tests: false). */
  startBackground?: boolean;
  /** Built UI directory (default <repo>/dist/web). */
  webRoot?: string;
  /** How often users.json is checked for changes (default 2 s). */
  usersReloadIntervalMs?: number;
  /** Addresses the download queue may contact (tests allow loopback; default: public internet only). */
  downloadAllowAddress?: (address: string) => boolean;
  /** Replaces the supervisor and backup process behind «Оливия»'s actions (tests). */
  oliviaActionDeps?: Partial<ActionDeps>;
  /** Talks to a fake printer in tests. */
  ippTransport?: IppTransport;
  /** Replaces the call to the local language model (tests). */
  oliviaLlmFetch?: LlmFetch;
  /** Free-space probe for downloads and uploads (tests). */
  freeBytes?: (dir: string) => Promise<number | null>;
}

function defaultLogger(config: Config): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'body.password', '*.password'],
      censor: '[скрыто]',
    },
  };
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mediaType = value.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

/**
 * Whether a request targets the API. The router decodes the path ("/%61pi/session" matches
 * "/api/session"), so this looks at the matched route and at the decoded path, never only at the
 * raw URL. A path that cannot be decoded counts as API, so it errs on the side of no-store.
 */
function isApiRequest(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  if (route !== undefined && isApiPath(route)) return true;
  const raw = urlPath(request.url);
  if (isApiPath(raw)) return true;
  try {
    return isApiPath(decodeURIComponent(raw));
  } catch {
    return true;
  }
}

/** The addresses the portal answers under: its loopback port plus PUBLIC_URL and LAN_URL. */
function portalUrls(config: Config): URL[] {
  const urls = ['127.0.0.1', 'localhost', '[::1]'].map((name) => new URL(`http://${name}:${config.port}`));
  for (const url of [config.publicUrl, config.lanUrl]) {
    if (url) urls.push(new URL(url));
  }
  // Every address the portal is bound to in the home network answers under its own name.
  for (const address of config.lanBind) urls.push(new URL(`http://${address}:${config.port}`));
  return urls;
}

function allowedOrigins(config: Config): Set<string> {
  return new Set(portalUrls(config).map((url) => url.origin));
}

/** Host header values (lowercase) of the portal; a default port may also be spelled out. */
function allowedHosts(config: Config): Set<string> {
  const hosts = new Set<string>();
  for (const url of portalUrls(config)) {
    hosts.add(url.host.toLowerCase());
    if (url.port === '') hosts.add(`${url.hostname}:${url.protocol === 'https:' ? 443 : 80}`.toLowerCase());
  }
  return hosts;
}

/**
 * DNS-rebinding guard: the raw Host header (and X-Forwarded-Host, when the trusted loopback proxy
 * sent one) must name the portal itself. A page on an attacker's domain that resolves to this PC
 * carries that domain as Host, so it is refused before it can reach any route or spoof
 * X-Forwarded-For (which the server trusts from loopback peers).
 */
function isAllowedHost(request: FastifyRequest, hosts: Set<string>): boolean {
  const fromProxy = TRUSTED_PROXY_SET.has(request.socket.remoteAddress ?? '');
  const host = request.headers.host?.trim().toLowerCase();
  if (!host || !(hosts.has(host) || (fromProxy && DEV_UI_HOSTS.has(host)))) return false;
  const forwarded = request.headers['x-forwarded-host'];
  if (forwarded === undefined || !fromProxy) return true;
  const values = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded).split(',');
  return values.every((value) => hosts.has(value.trim().toLowerCase()));
}

/** Origin must be the portal's own host (as seen through the trusted proxy) or a configured address. */
function isAllowedOrigin(origin: string, request: FastifyRequest, fixed: Set<string>): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (fixed.has(url.origin)) return true;
  try {
    // Parse the request host with the origin's scheme so default ports compare equal.
    return new URL(`${url.protocol}//${request.host}`).host === url.host;
  } catch {
    return false;
  }
}

/**
 * File uploads are the only non-JSON writes: a PUT with a raw application/octet-stream body to a
 * route marked `rawUpload`, carrying the custom header X-Upload: 1. A cross-site page cannot send
 * that header without a CORS preflight (which the portal never allows), and the Origin and
 * Sec-Fetch-Site checks above still apply.
 */
function isRawUpload(request: FastifyRequest): boolean {
  if (request.method !== 'PUT' || request.routeOptions.config?.rawUpload !== true) return false;
  const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  return type === 'application/octet-stream' && request.headers['x-upload'] === '1';
}

function badJsonError(): Error {
  return Object.assign(new Error('Invalid JSON body'), { statusCode: 400, code: 'DASHBOARD_BAD_JSON' });
}

export async function buildApp(options: BuildAppOptions): Promise<DashboardApp> {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  const version = readAppVersion();
  const startedAt = isoNow(clock);
  await fsp.mkdir(config.dataDir, { recursive: true });

  const app = Fastify({
    logger: options.logger === undefined ? defaultLogger(config) : options.logger,
    // No "incoming request"/"request completed" pair per request: with tabs polling every few
    // seconds that grew the log by megabytes a day. Responses are logged by the onResponse hook.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: BODY_LIMIT,
    trustProxy: TRUSTED_PROXIES,
  });
  const log = app.log;

  // A forced stop (scripts\stop.cmd) can interrupt an atomic write and leave its temp file behind.
  const strayTemp = await removeStaleTempFiles(config.dataDir).catch((error: unknown) => {
    log.warn(`Не удалось проверить временные файлы в каталоге данных: ${(error as Error).message}`);
    return [];
  });
  if (strayTemp.length > 0) {
    log.warn(`Удалены временные файлы прерванной записи: ${strayTemp.join(', ')}`);
  }

  // --- stores and background components -----------------------------------------------------
  const users = createUserStore(config.dataDir, {
    clock,
    reloadIntervalMs: options.usersReloadIntervalMs,
    onLoadError: (message) => log.error(message),
  });
  await users.reload().catch((error: unknown) => log.error((error as Error).message));
  const logins = createLoginTimes(config.dataDir, { onError: (message) => log.warn(message) });
  await logins.load();
  const sessions = createSessionStore(config.dataDir, { clock, onError: (message) => log.error(message) });
  await sessions.load();
  const audit = createAuditLog(config.dataDir, { clock, onError: (message) => log.error(message) });
  const limiter = createLoginLimiter(clock);
  const registry = createServiceRegistry({
    config,
    clock,
    fetch: options.fetch ?? fetch,
    onConfigError: (message) => log.warn(message),
  });
  await registry.init();
  const collector = createSystemCollector({
    config,
    clock,
    probes: options.probes ?? createDefaultProbes(config),
    version,
    startedAt,
    servicesConfigError: () => registry.configError(),
    timeouts: options.probeTimeouts,
    onProbeError: (probe, message) => log.warn({ probe }, `Системная проверка не удалась: ${message}`),
  });
  const guards = createGuards({ config, users, sessions });
  const downloads = createDownloadManager({
    dataDir: config.dataDir,
    filesRoot: config.filesDir,
    maxFileBytes: config.downloadMaxFileBytes,
    minFreeBytes: config.minFreeBytes,
    clock,
    allowAddress: options.downloadAllowAddress,
    freeBytes: options.freeBytes,
    log: (message) => log.warn(message),
    onEvent: (event) =>
      void audit.write({ action: event.action, actor: event.actor, ip: null, detail: event.detail }),
  });
  const context: AppContext = {
    config,
    clock,
    version,
    startedAt,
    users,
    logins,
    sessions,
    audit,
    limiter,
    registry,
    collector,
    guards,
    downloads,
    lan: { bound: [], failed: [] },
  };
  app.decorate('dashboard', context);

  // --- HTTP plumbing ------------------------------------------------------------------------
  await app.register(fastifyCookie);

  // Raw uploads: the body stays a stream; the route enforces its own size limit while writing.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  // Own JSON parser: an empty body is accepted as {} (logout/refresh send no payload).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(
        null,
        JSON.parse(text, (key, value: unknown) => {
          if (key === '__proto__') throw badJsonError();
          return value;
        }),
      );
    } catch {
      done(badJsonError(), undefined);
    }
  });

  const hosts = allowedHosts(config);
  // Runs first, for every method and path (health, pages and 404s included). The rejected host is
  // neither logged nor echoed back.
  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request, hosts)) {
      return sendError(reply, 421, 'bad_host', 'Запрос отклонён: неизвестный адрес сервера.');
    }
  });

  const fixedOrigins = allowedOrigins(config);
  // CSRF / origin guard runs before the body is read, so a rejected request does nothing.
  // Applied to EVERY state-changing request, whatever the path: the router decodes the path
  // ("/%61pi/logout" reaches "/api/logout"), so a raw-URL check could be sidestepped, and the
  // portal has no mutating routes outside /api anyway.
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const fetchSite = request.headers['sec-fetch-site'];
    const origin = request.headers.origin;
    if (
      fetchSite === 'cross-site' ||
      (origin !== undefined && !isAllowedOrigin(origin, request, fixedOrigins))
    ) {
      return sendError(reply, 403, 'forbidden_origin', 'Запрос отклонён: он отправлен с другого сайта.');
    }
    if (!isJsonContentType(request.headers['content-type']) && !isRawUpload(request)) {
      return sendError(
        reply,
        415,
        'unsupported_media_type',
        'Сервер принимает только JSON (Content-Type: application/json).',
      );
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    // A route may set a stricter header itself (e.g. the sandbox CSP of served family files).
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    if (isApiRequest(request)) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Only server-side failures reach the log at the default level; 4xx are visible with LOG_LEVEL=debug.
  // Path only: no query string, headers or cookies.
  app.addHook('onResponse', async (request, reply) => {
    const { statusCode } = reply;
    if (statusCode < 400) return;
    const entry = {
      method: request.method,
      url: urlPath(request.url),
      statusCode,
      responseTimeMs: Math.round(reply.elapsedTime),
    };
    if (statusCode >= 500) request.log.error(entry, 'Ответ с ошибкой сервера');
    else request.log.debug(entry, 'Ответ с ошибкой запроса');
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (error.validation) return sendError(reply, 400, 'bad_request', 'Некорректные данные запроса.');
    if (status === 413)
      return sendError(reply, 413, 'payload_too_large', 'Слишком большой запрос: не более 64 КБ.');
    if (status === 415) {
      return sendError(
        reply,
        415,
        'unsupported_media_type',
        'Сервер принимает только JSON (Content-Type: application/json).',
      );
    }
    if (error.code === 'DASHBOARD_BAD_JSON' || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return sendError(reply, 400, 'bad_json', 'Тело запроса не является корректным JSON.');
    }
    if (status === 403) return sendError(reply, 403, 'forbidden', 'Доступ запрещён.');
    if (status === 404) return sendError(reply, 404, 'not_found', 'Не найдено.');
    if (status >= 400 && status < 500) return sendError(reply, status, 'bad_request', 'Некорректный запрос.');
    request.log.error({ err: error }, 'Необработанная ошибка');
    return sendError(reply, 500, 'internal', 'Внутренняя ошибка сервера');
  });

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = urlPath(request.url);
    if (isApiPath(pathname) || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return sendError(reply, 404, 'not_found', 'Такого адреса API нет.');
    }
    return sendSpaFallback(request, reply, webRoot, pathname);
  });

  // --- routes -------------------------------------------------------------------------------
  app.get('/api/health', async () => {
    const body: HealthResponse = { status: 'ok', version, time: isoNow(clock) };
    return body;
  });

  app.get('/api/connection', { preHandler: guards.requireUser }, async (request) => {
    // With LAN_BIND the address is shown only while the portal really listens on it.
    const lanWanted = config.lanBind.length > 0;
    const lanListening = !lanWanted || context.lan.bound.length > 0;
    const isAdmin = currentUser(request).role === 'admin';
    const problem = context.lan.failed.map((item) => `${item.address}: ${item.reason}`).join('; ');
    const body: ConnectionResponse = {
      tailnetUrl: config.publicUrl,
      lanUrl: lanListening ? config.lanUrl : null,
      localUrl: `http://127.0.0.1:${config.port}`,
      lanProblem: isAdmin && lanWanted && problem !== '' ? problem : null,
    };
    return body;
  });

  registerAuthRoutes(app, { config, clock, users, logins, sessions, audit, limiter, guards });
  registerServiceRoutes(app, { registry, guards, audit, clock });
  registerSystemRoutes(app, { collector, guards });
  const freeBytes = options.freeBytes ?? statfsFree;
  const storage = createStorage({
    filesRoot: config.filesDir,
    photosRoot: config.photosDir,
    minFreeBytes: config.minFreeBytes,
    maxUploadBytes: config.uploadMaxFileBytes,
    freeBytes,
  });
  const calendar = createCalendarStore(config.dataDir, { clock });
  const retireAccount = async (username: string): Promise<string> => {
    const moved = await storage.archiveUser(username);
    const events = await calendar.retireOwner(username);
    const parts: string[] = [];
    if (moved.length > 0) parts.push('файлы и фото перенесены в корзину сервера');
    if (events.deleted > 0) parts.push(`личных событий удалено: ${events.deleted}`);
    if (events.kept > 0) parts.push(`общих событий оставлено: ${events.kept}`);
    return parts.join('; ');
  };
  registerAdminRoutes(app, {
    config,
    clock,
    version,
    guards,
    audit,
    users,
    logins,
    registry,
    collector,
    limiter,
    retireAccount,
  });
  registerDownloadRoutes(app, { config, clock, guards, downloads });
  registerFileRoutes(app, { storage, guards, audit, freeBytes, maxUploadBytes: config.uploadMaxFileBytes });
  registerMediaRoutes(app, { library: createMediaLibrary(config.mediaDir), guards });
  registerPlannerRoutes(app, {
    calendar,
    notes: createNotes(storage),
    guards,
    audit,
    clock,
  });
  const printQueue = createPrintQueue({
    dataDir: config.dataDir,
    printerUrl: config.printerIppUrl,
    maxBytes: config.printMaxBytes,
    clock,
    transport: options.ippTransport,
    pollMs: options.ippTransport ? 50 : undefined,
    deferredPollMs: options.ippTransport ? 50 : undefined,
    waitForFirstProbe: options.ippTransport !== undefined,
    onEvent: (event) =>
      void audit.write({ action: event.action, actor: event.actor, ip: null, detail: event.detail }),
  });
  await printQueue.load();
  registerPrintRoutes(app, { guards, queue: printQueue, maxBytes: config.printMaxBytes });
  registerOliviaRoutes(app, {
    config,
    clock,
    guards,
    audit,
    registry,
    collector,
    actionDeps: options.oliviaActionDeps,
    llmFetch: options.oliviaLlmFetch,
  });
  await registerStatic(app, webRoot);

  // --- lifecycle ----------------------------------------------------------------------------
  app.addHook('onClose', async () => {
    registry.stop();
    collector.stop();
    await downloads.stop();
    await printQueue.stop();
    await sessions.flush();
    await audit.idle();
  });

  if (options.startBackground) {
    app.addHook('onReady', async () => {
      registry.start();
      collector.start();
      await downloads.load();
    });
  }

  // `dashboard` was added with app.decorate() above; the cast only makes it visible to TypeScript.
  return app as unknown as DashboardApp;
}
