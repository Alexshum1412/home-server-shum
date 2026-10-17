import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { PrintResponse } from '../../../shared/api.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { hasPermission } from '../auth/users.ts';
import { sendError } from '../lib/http.ts';
import { PrintError, type PrintQueue } from './queue.ts';

export interface PrintRouteDeps {
  guards: Guards;
  queue: PrintQueue;
  maxBytes: number;
}

const NO_RIGHT =
  'Печать доступна по разрешению администратора. Попросите его выполнить на сервере: scripts\\user.cmd allow <ваш логин> print';
const ID_RE = /^[0-9a-f-]{36}$/;
const uploadQuery = z.object({
  name: z.string().min(1).max(200),
  size: z.coerce.number().int().min(1),
  copies: z.coerce.number().int().min(1).max(20).default(1),
  sides: z.enum(['one-sided', 'two-sided-long-edge', 'two-sided-short-edge']).default('one-sided'),
  color: z.enum(['auto', 'monochrome', 'color']).default('auto'),
});
const confirmSchema = z.object({ confirm: z.literal(true) });

export function registerPrintRoutes(app: FastifyInstance, deps: PrintRouteDeps): void {
  const { guards, queue } = deps;

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof PrintError) return sendError(reply, error.status, error.code, error.message);
    throw error;
  }

  app.get('/api/print', { preHandler: guards.requireUser }, async (request) => {
    const user = currentUser(request);
    const allowed = hasPermission(user, 'print');
    const body: PrintResponse = {
      allowed,
      printer: await queue.printerStatus(),
      jobs: allowed ? queue.list(user.role === 'admin' ? null : user.username) : [],
      maxBytes: deps.maxBytes,
    };
    return body;
  });

  app.put(
    '/api/print/jobs',
    { preHandler: guards.requireUser, config: { rawUpload: true } },
    async (request, reply) => {
      const user = currentUser(request);
      if (!hasPermission(user, 'print')) return sendError(reply, 403, 'forbidden', NO_RIGHT);
      const parsed = uploadQuery.safeParse(request.query);
      if (!parsed.success)
        return sendError(reply, 400, 'bad_request', 'Не указаны файл или настройки печати.');
      const length = Number(request.headers['content-length'] ?? Number.NaN);
      if (length !== parsed.data.size)
        return sendError(reply, 411, 'length_required', 'Размер файла не совпадает.');
      try {
        return await queue.prepare(
          user.username,
          parsed.data.name,
          parsed.data.size,
          request.body as NodeJS.ReadableStream,
          {
            copies: parsed.data.copies,
            sides: parsed.data.sides,
            colorMode: parsed.data.color,
          },
        );
      } catch (error) {
        reply.header('Connection', 'close');
        return fail(reply, error);
      }
    },
  );

  for (const action of ['print', 'defer', 'cancel'] as const) {
    app.post(`/api/print/jobs/:id/${action}`, { preHandler: guards.requireUser }, async (request, reply) => {
      const user = currentUser(request);
      if (!hasPermission(user, 'print')) return sendError(reply, 403, 'forbidden', NO_RIGHT);
      const { id } = request.params as { id: string };
      if (!ID_RE.test(id)) return sendError(reply, 404, 'not_found', 'Такого задания нет.');
      if ((action === 'print' || action === 'defer') && !confirmSchema.safeParse(request.body).success) {
        return sendError(reply, 400, 'confirm_required', 'Печать нужно подтвердить.');
      }
      try {
        return await queue[action](id, { username: user.username, isAdmin: user.role === 'admin' });
      } catch (error) {
        return fail(reply, error);
      }
    });
  }
}
