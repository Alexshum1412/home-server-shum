import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DownloadCheckResponse, DownloadsResponse } from '../../../shared/api.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { createSlidingWindowLimiter } from '../auth/rate-limit.ts';
import { hasPermission } from '../auth/users.ts';
import type { Config } from '../config.ts';
import { sendError } from '../lib/http.ts';
import type { Clock } from '../lib/time.ts';
import { DownloadError, type DownloadManager, statfsFree } from './manager.ts';

export interface DownloadRouteDeps {
  config: Config;
  clock: Clock;
  guards: Guards;
  downloads: DownloadManager;
}

const NO_RIGHT =
  'Загрузки доступны по разрешению администратора. Попросите его выполнить на сервере: scripts\\user.cmd allow <ваш логин> downloads';

const checkSchema = z.object({ url: z.string().min(1).max(2048) });
const addSchema = z.object({ checkId: z.string().uuid() });
const ID_RE = /^[0-9a-f-]{36}$/;

export function registerDownloadRoutes(app: FastifyInstance, deps: DownloadRouteDeps): void {
  const { config, guards, downloads } = deps;
  // Every check makes an outgoing request: bounded per user.
  const checkLimiter = createSlidingWindowLimiter({ limit: 30, windowMs: 10 * 60_000, clock: deps.clock });

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof DownloadError) return sendError(reply, error.status, error.code, error.message);
    throw error;
  }

  function allowed(request: FastifyRequest): boolean {
    return hasPermission(currentUser(request), 'downloads');
  }

  app.get('/api/downloads', { preHandler: guards.requireUser }, async (request) => {
    const user = currentUser(request);
    const permitted = allowed(request);
    const body: DownloadsResponse = {
      allowed: permitted,
      tasks: permitted ? downloads.list(user.role === 'admin' ? null : user.username) : [],
      limits: {
        maxFileBytes: config.downloadMaxFileBytes,
        minFreeBytes: config.minFreeBytes,
        freeBytes: permitted ? await statfsFree(config.filesDir).catch(() => null) : null,
      },
      folderLabel: 'Файлы → Личное → Загрузки',
    };
    return body;
  });

  app.post('/api/downloads/check', { preHandler: guards.requireUser }, async (request, reply) => {
    if (!allowed(request)) return sendError(reply, 403, 'forbidden', NO_RIGHT);
    const parsed = checkSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_url', 'Вставьте ссылку на файл.');
    const user = currentUser(request);
    const limit = checkLimiter.check(user.username);
    if (!limit.allowed) {
      reply.header('Retry-After', String(limit.retryAfterSec));
      return sendError(
        reply,
        429,
        'too_many_requests',
        'Слишком много проверок подряд. Подождите несколько минут.',
      );
    }
    checkLimiter.hit(user.username);
    try {
      const body: DownloadCheckResponse = await downloads.probe(user.username, parsed.data.url);
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/downloads', { preHandler: guards.requireUser }, async (request, reply) => {
    if (!allowed(request)) return sendError(reply, 403, 'forbidden', NO_RIGHT);
    const parsed = addSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Сначала проверьте ссылку.');
    try {
      return await downloads.add(currentUser(request).username, parsed.data.checkId);
    } catch (error) {
      return fail(reply, error);
    }
  });

  for (const action of ['pause', 'resume', 'cancel', 'remove'] as const) {
    app.post(`/api/downloads/:id/${action}`, { preHandler: guards.requireUser }, async (request, reply) => {
      if (!allowed(request)) return sendError(reply, 403, 'forbidden', NO_RIGHT);
      const { id } = request.params as { id: string };
      if (!ID_RE.test(id)) return sendError(reply, 404, 'not_found', 'Такой загрузки нет.');
      const user = currentUser(request);
      const actor = { username: user.username, isAdmin: user.role === 'admin' };
      try {
        if (action === 'remove') {
          await downloads.remove(id, actor);
          return reply.code(204).send();
        }
        return await downloads[action](id, actor);
      } catch (error) {
        return fail(reply, error);
      }
    });
  }
}
