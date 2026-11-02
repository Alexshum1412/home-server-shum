import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import type { Archive } from './archive.ts';

const ID = /^[A-Za-z0-9_-]{6,64}$/;

export function registerArchiveRoutes(
  app: FastifyInstance,
  deps: { archive: Archive; guards: Guards },
): void {
  const { archive, guards } = deps;

  app.get('/api/archive', { preHandler: guards.requireUser }, async (request, reply) => {
    const me = currentUser(request);
    const q = z
      .string()
      .max(200)
      .optional()
      .safeParse((request.query as { q?: string }).q);
    const query = q.success ? (q.data ?? '').trim() : '';
    return reply.header('cache-control', 'no-store').send({
      pages: await archive.list(me.username),
      hits: query !== '' ? await archive.search(me.username, query, 12) : [],
      query,
    });
  });

  app.post('/api/archive/save', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = z
      .object({ url: z.string().url().max(2000), shared: z.boolean().optional() })
      .strict()
      .safeParse(request.body);
    if (!parsed.success)
      return sendError(reply, 400, 'bad_request', 'Нужна ссылка на страницу (http или https).');
    const page = await archive.save(
      currentUser(request).username,
      parsed.data.url,
      parsed.data.shared === true,
    );
    return (
      page ??
      sendError(
        reply,
        422,
        'unreadable',
        'Не получилось сохранить: страница закрыта, не текстовая или недоступна.',
      )
    );
  });

  app.get('/api/archive/:id', { preHandler: guards.requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ID.test(id)) return sendError(reply, 404, 'not_found', 'Такой страницы нет.');
    const page = await archive.get(currentUser(request).username, id);
    return page ?? sendError(reply, 404, 'not_found', 'Такой страницы нет.');
  });

  // The original HTML only as a download: it is somebody else's page and must never run inside the portal.
  app.get('/api/archive/:id/original', { preHandler: guards.requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ID.test(id)) return sendError(reply, 404, 'not_found', 'Такой страницы нет.');
    const file = await archive.originalPath(currentUser(request).username, id);
    if (!file) return sendError(reply, 404, 'not_found', 'Такой страницы нет.');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="page-${id}.html"`);
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(file));
  });

  app.post('/api/archive/:id/delete', { preHandler: guards.requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ID.test(id)) return sendError(reply, 404, 'not_found', 'Такой страницы нет.');
    const ok = await archive.remove(currentUser(request).username, id);
    return ok ? { ok: true } : sendError(reply, 404, 'not_found', 'Такой страницы нет.');
  });
}
