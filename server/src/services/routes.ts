import type { FastifyInstance } from 'fastify';
import type { RefreshResponse, ServicesResponse } from '../../../shared/api.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import type { ServiceRegistry } from './checker.ts';

export const REFRESH_MIN_INTERVAL_MS = 10_000;

export interface ServiceRouteDeps {
  registry: ServiceRegistry;
  guards: Guards;
  audit: AuditLog;
  clock: Clock;
}

export function registerServiceRoutes(app: FastifyInstance, deps: ServiceRouteDeps): void {
  const { registry, guards, audit, clock } = deps;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;

  const body = (isAdmin: boolean): ServicesResponse => ({
    // Technical detail (HTTP codes, error codes) is for the admin; family members get plain words.
    services: isAdmin
      ? registry.statuses()
      : registry.statuses().map((service) => ({ ...service, detail: null })),
    generatedAt: isoNow(clock),
    configError: isAdmin ? registry.configError() : null,
  });

  app.get('/api/services', { preHandler: guards.requireUser }, async (request) => {
    return body(currentUser(request).role === 'admin');
  });

  app.post('/api/services/refresh', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const now = clock().getTime();
    const waitMs = lastRefreshAt + REFRESH_MIN_INTERVAL_MS - now;
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      reply.header('Retry-After', String(seconds));
      return sendError(
        reply,
        429,
        'too_many_requests',
        `Проверка только что выполнялась. Повторите через ${seconds} с.`,
      );
    }
    lastRefreshAt = now;
    await registry.checkAll();
    await audit.write({ action: 'services.refresh', actor: currentUser(request).username, ip: request.ip });
    const result: RefreshResponse = body(true);
    return result;
  });
}
