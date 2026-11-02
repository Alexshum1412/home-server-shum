import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import { type Dossier, extensionOf, MEDIA_TYPES } from './dossier.ts';
import { THEMES } from './questions.ts';

const ID = /^[A-Za-z0-9_-]{6,64}$/;
const FILE = /^[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/;

export function registerFamilyRoutes(app: FastifyInstance, deps: { dossier: Dossier; guards: Guards }): void {
  const { dossier, guards } = deps;
  const fail = (reply: Parameters<typeof sendError>[0], error: unknown) => {
    const status = (error as { statusCode?: number }).statusCode;
    return sendError(
      reply,
      typeof status === 'number' && status >= 400 && status < 500 ? status : 500,
      status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'failed',
      status ? (error as Error).message : 'Не получилось сохранить: попробуйте ещё раз.',
    );
  };

  app.get('/api/family', { preHandler: guards.requireUser }, async (request, reply) => {
    const me = currentUser(request);
    const state = await dossier.state(me.username);
    return reply.header('cache-control', 'no-store').send({
      ...state,
      themes: THEMES,
      total: dossier.questionCount,
      copies: me.role === 'admin' ? dossier.copyStatus() : null,
      isAdmin: me.role === 'admin',
    });
  });

  app.post('/api/family/settings', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не понял, включить или выключить.');
    await dossier.setEnabled(currentUser(request).username, parsed.data.enabled);
    return { ok: true };
  });

  app.post('/api/family/ask', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = z
      .object({ another: z.boolean().optional() })
      .strict()
      .safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не понял запрос.');
    const question = await dossier.askNow(currentUser(request).username, parsed.data.another === true);
    return { question };
  });

  app.post('/api/family/skip', { preHandler: guards.requireUser }, async (request) => {
    await dossier.skip(currentUser(request).username);
    return { ok: true };
  });

  app.post('/api/family/answer', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = z
      .object({ text: z.string().max(20_000), qid: z.string().max(40).optional() })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Ответ слишком длинный или неверный.');
    try {
      return await dossier.answer(currentUser(request).username, {
        text: parsed.data.text,
        ...(parsed.data.qid ? { qid: parsed.data.qid } : {}),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/family/text', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = z
      .object({ entry: z.string().regex(ID), text: z.string().min(1).max(20_000) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не понял запрос.');
    const entry = await dossier.addText(currentUser(request).username, parsed.data.entry, parsed.data.text);
    return entry ?? sendError(reply, 404, 'not_found', 'Такой записи нет.');
  });

  app.post('/api/family/entries/:id/delete', { preHandler: guards.requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ID.test(id)) return sendError(reply, 404, 'not_found', 'Такой записи нет.');
    const me = currentUser(request);
    const ok = await dossier.remove(me.username, id, me.role === 'admin');
    return ok ? { ok: true } : sendError(reply, 404, 'not_found', 'Такой записи нет.');
  });

  const uploadQuery = z.object({
    entry: z.string().regex(ID),
    name: z.string().min(1).max(160),
    size: z.coerce.number().int().positive(),
  });
  app.put(
    '/api/family/media',
    { preHandler: guards.requireUser, config: { rawUpload: true } },
    async (request, reply) => {
      const parsed = uploadQuery.safeParse(request.query);
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не указаны запись или файл.');
      const length = Number(request.headers['content-length'] ?? Number.NaN);
      if (length !== parsed.data.size)
        return sendError(reply, 411, 'length_required', 'Размер файла не совпадает.');
      try {
        return await dossier.attach(
          currentUser(request).username,
          parsed.data.entry,
          parsed.data.name,
          parsed.data.size,
          request.body as NodeJS.ReadableStream,
        );
      } catch (error) {
        reply.header('Connection', 'close');
        return fail(reply, error);
      }
    },
  );

  app.get('/api/family/media/:entry/:file', { preHandler: guards.requireUser }, async (request, reply) => {
    const { entry, file } = request.params as { entry: string; file: string };
    if (!ID.test(entry) || !FILE.test(file)) return sendError(reply, 404, 'not_found', 'Файла нет.');
    const found = await dossier.mediaPath(entry, file);
    const me = currentUser(request);
    if (!found || (found.owner !== me.username && me.role !== 'admin'))
      return sendError(reply, 404, 'not_found', 'Файла нет.');
    const info = await stat(found.path).catch(() => null);
    if (!info) return sendError(reply, 404, 'not_found', 'Файла нет.');
    reply.header('content-type', MEDIA_TYPES[extensionOf(file)] ?? 'application/octet-stream');
    reply.header('content-length', String(info.size));
    reply.header('cache-control', 'private, max-age=3600');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(found.path));
  });

  // The family's archive: the administrator reads everything that was said (it is said on the page).
  app.get('/api/family/archive', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const who = z
      .string()
      .max(60)
      .optional()
      .safeParse((request.query as { user?: string }).user);
    return reply.header('cache-control', 'no-store').send({
      people: await dossier.overview(),
      entries: who.success && who.data ? await dossier.entriesOf(who.data) : [],
      copies: dossier.copyStatus(),
    });
  });

  app.post('/api/family/copy', { preHandler: guards.requireAdmin }, async () => ({
    copies: await dossier.copyNow(),
  }));
}
