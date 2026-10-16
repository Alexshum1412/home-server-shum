import { promises as fsp } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import type { ConnectionResponse, HealthResponse } from '../../shared/api.ts';
import { registerAdminRoutes } from './admin/routes.ts';
import { type AuditLog, createAuditLog } from './audit/log.ts';
import { createGuards, type Guards } from './auth/guards.ts';
import { createLoginLimiter, type LoginLimiter } from './auth/rate-limit.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { createSessionStore, type SessionStore } from './auth/sessions.ts';
import { createUserStore, type UserStore } from './auth/users.ts';
import type { Config } from './config.ts';
import { isApiPath, sendError, urlPath } from './lib/http.ts';
import { type Clock, isoNow, systemClock } from './lib/time.ts';
import { readAppVersion } from './lib/version.ts';
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

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AppContext {
  config: Config;
  clock: Clock;
  version: string;
  startedAt: string;
  users: UserStore;
  sessions: SessionStore;
  audit: AuditLog;
  limiter: LoginLimiter;
  registry: ServiceRegistry;
  collector: SystemCollector;
  guards: Guards;
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

function allowedOrigins(config: Config): Set<string> {
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
  for (const url of [config.publicUrl, config.lanUrl]) {
    if (url) origins.add(new URL(url).origin);
  }
  return origins;
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
    bodyLimit: BODY_LIMIT,
    trustProxy: TRUSTED_PROXIES,
  });
  const log = app.log;

  // --- stores and background components -----------------------------------------------------
  const users = createUserStore(config.dataDir, {
    clock,
    reloadIntervalMs: options.usersReloadIntervalMs,
    onLoadError: (message) => log.error(message),
  });
  await users.reload().catch((error: unknown) => log.error((error as Error).message));
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
  const context: AppContext = {
    config,
    clock,
    version,
    startedAt,
    users,
    sessions,
    audit,
    limiter,
    registry,
    collector,
    guards,
  };
  app.decorate('dashboard', context);

  // --- HTTP plumbing ------------------------------------------------------------------------
  await app.register(fastifyCookie);

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

  const fixedOrigins = allowedOrigins(config);
  // CSRF / origin guard runs before the body is read, so a rejected request does nothing.
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method) || !isApiPath(urlPath(request.url))) return;
    const fetchSite = request.headers['sec-fetch-site'];
    const origin = request.headers.origin;
    if (
      fetchSite === 'cross-site' ||
      (origin !== undefined && !isAllowedOrigin(origin, request, fixedOrigins))
    ) {
      return sendError(reply, 403, 'forbidden_origin', 'Запрос отклонён: он отправлен с другого сайта.');
    }
    if (!isJsonContentType(request.headers['content-type'])) {
      return sendError(
        reply,
        415,
        'unsupported_media_type',
        'Сервер принимает только JSON (Content-Type: application/json).',
      );
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (isApiPath(urlPath(request.url))) reply.header('Cache-Control', 'no-store');
    return payload;
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

  app.get('/api/connection', { preHandler: guards.requireUser }, async () => {
    const body: ConnectionResponse = {
      tailnetUrl: config.publicUrl,
      lanUrl: config.lanUrl,
      localUrl: `http://127.0.0.1:${config.port}`,
    };
    return body;
  });

  registerAuthRoutes(app, { config, clock, users, sessions, audit, limiter, guards });
  registerServiceRoutes(app, { registry, guards, audit, clock });
  registerSystemRoutes(app, { collector, guards });
  registerAdminRoutes(app, { config, clock, version, guards, audit, users, registry, collector });
  await registerStatic(app, webRoot);

  // --- lifecycle ----------------------------------------------------------------------------
  app.addHook('onClose', async () => {
    registry.stop();
    collector.stop();
    await sessions.flush();
    await audit.idle();
  });

  if (options.startBackground) {
    app.addHook('onReady', async () => {
      registry.start();
      collector.start();
    });
  }

  // `dashboard` was added with app.decorate() above; the cast only makes it visible to TypeScript.
  return app as unknown as DashboardApp;
}
