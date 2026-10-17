import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { MediaListResponse } from '../../../shared/api.ts';
import type { Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import { parseByteRange } from '../lib/range.ts';
import { MediaError, type MediaLibrary } from './library.ts';

export interface MediaRouteDeps {
  library: MediaLibrary;
  guards: Guards;
}

const querySchema = z.object({ path: z.string().max(600).default('') });

/** Sandboxed like family files: a media file can never run scripts in the portal's origin. */
const MEDIA_CSP = "sandbox; default-src 'none'; media-src 'self'; style-src 'unsafe-inline'";

/**
 * Fallback viewer for the media library (P2 alternative way): the signed-in family can browse and
 * play the library's films, music and audiobooks straight from the files, without Jellyfin.
 * Read-only; the same rights as Jellyfin gives the family (every signed-in user sees the library).
 */
export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  const { library, guards } = deps;

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof MediaError) return sendError(reply, error.status, error.code, error.message);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return sendError(reply, 404, 'not_found', 'Такого файла или папки нет.');
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      return sendError(reply, 409, 'busy', 'Файл занят другой программой или нет доступа. Попробуйте позже.');
    }
    throw error;
  }

  app.get('/api/media/list', { preHandler: guards.requireUser }, async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, 'bad_request', 'Некорректный путь.');
    const relative = query.data.path.replace(/\\/g, '/');
    const status = await library.status();
    if (!status.available) {
      const body: MediaListResponse = {
        available: false,
        reason: status.reason,
        path: relative,
        entries: [],
      };
      return body;
    }
    try {
      const body: MediaListResponse = {
        available: true,
        reason: null,
        path: relative,
        entries: await library.list(relative),
      };
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/media/file', { preHandler: guards.requireUser }, async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, 'bad_request', 'Некорректный путь.');
    try {
      const { file, stat, mime, name } = await library.open(query.data.path.replace(/\\/g, '/'));
      const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      reply.header('Content-Type', mime);
      reply.header(
        'Content-Disposition',
        `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      reply.header('Content-Security-Policy', MEDIA_CSP);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', 'private, no-cache');
      const range = parseByteRange(request.headers.range, stat.size);
      if (range === 'invalid') {
        reply.header('Content-Range', `bytes */${stat.size}`);
        return reply.code(416).send();
      }
      if (range) {
        reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        reply.header('Content-Length', String(range.end - range.start + 1));
        return reply.send(library.stream(file, { start: range.start, end: range.end }));
      }
      reply.header('Content-Length', String(stat.size));
      return reply.send(library.stream(file));
    } catch (error) {
      return fail(reply, error);
    }
  });
}
