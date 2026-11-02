import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import type { Archive } from './archive.ts';
import { IMAGE_EXT, type Ocr } from './ocr.ts';

const ID = /^[A-Za-z0-9_-]{6,64}$/;

export function registerArchiveRoutes(
  app: FastifyInstance,
  deps: {
    archive: Archive;
    guards: Guards;
    ocr: Ocr;
    notes: {
      save: (
        space: 'personal',
        username: string,
        name: string,
        text: string,
        revision: null,
      ) => Promise<unknown>;
    };
  },
): void {
  const { archive, guards } = deps;

  // A photo of a document or a page: the text of it, and a note with it (a raw upload like the other uploads).
  app.put(
    '/api/archive/ocr',
    { preHandler: guards.requireUser, config: { rawUpload: true }, bodyLimit: 26 * 1024 * 1024 },
    async (request, reply) => {
      if (!deps.ocr.available())
        return sendError(reply, 503, 'unavailable', 'Распознавание текста на этом сервере не подключено.');
      const name = String((request.query as { name?: string }).name ?? 'scan.png');
      if (!IMAGE_EXT.test(name)) return sendError(reply, 415, 'bad_type', 'Нужна картинка: jpg, png, webp.');
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of request.body as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > 25 * 1024 * 1024) return sendError(reply, 413, 'too_large', 'Картинка слишком большая.');
        chunks.push(chunk);
      }
      const ext = /\.[A-Za-z0-9]+$/.exec(name)?.[0] ?? '.png';
      const text = await deps.ocr.read(Buffer.concat(chunks), ext);
      if (!text)
        return sendError(reply, 422, 'no_text', 'Текст прочитать не получилось: нужно ровное и чёткое фото.');
      const title = await archive.addNote(currentUser(request).username, text);
      return { text, note: title };
    },
  );

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
