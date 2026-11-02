import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import type { Reports } from './service.ts';

export function registerReportRoutes(app: FastifyInstance, deps: { reports: Reports; guards: Guards }): void {
  const { reports, guards } = deps;

  // A report on a button of the portal (Olivia makes the same ones on request).
  app.post('/api/reports', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = z
      .object({ kind: z.enum(['server', 'week']) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не понял, какой отчёт нужен.');
    const me = currentUser(request);
    if (parsed.data.kind === 'server' && me.role !== 'admin')
      return sendError(reply, 403, 'forbidden', 'Отчёт о сервере доступен администратору.');
    if (!reports.available())
      return sendError(
        reply,
        503,
        'unavailable',
        'Составить отчёт не получилось: на сервере нет браузера Chrome.',
      );
    const made = await reports.make(me, parsed.data.kind);
    return made ?? sendError(reply, 500, 'failed', 'Отчёт не получился, попробуйте ещё раз.');
  });

  app.get('/api/reports/:id/:ext', { preHandler: guards.requireUser }, async (request, reply) => {
    const { id, ext } = request.params as { id: string; ext: string };
    if (ext !== 'png' && ext !== 'pdf') return sendError(reply, 404, 'not_found', 'Такого отчёта нет.');
    const file = await reports.file(currentUser(request), id, ext);
    if (!file) return sendError(reply, 404, 'not_found', 'Такого отчёта нет.');
    reply.header('content-type', ext === 'png' ? 'image/png' : 'application/pdf');
    reply.header(
      'content-disposition',
      `${ext === 'pdf' ? 'attachment' : 'inline'}; filename="otchet-${id}.${ext}"`,
    );
    reply.header('cache-control', 'private, max-age=600');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(file));
  });
}
