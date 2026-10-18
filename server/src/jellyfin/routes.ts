import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  CatalogDetailResponse,
  CatalogHomeResponse,
  CatalogItemsResponse,
} from '../../../shared/api.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import { type JellyfinClient, JellyfinError, type Resume } from './client.ts';
import type { ProgressStore } from './progress.ts';

export interface CatalogRouteDeps {
  guards: Guards;
  client: JellyfinClient;
  progress: ProgressStore;
  /** Jellyfin's own address for the family (tailnet), or null. */
  jellyfinUrl: () => string | null;
}

const ID = z.string().regex(/^[0-9a-fA-F]{32}$/);
const itemsQuery = z.object({
  library: ID.optional(),
  q: z.string().trim().max(100).optional(),
  genre: z.string().trim().max(60).optional(),
  sort: z.enum(['name', 'added', 'year']).default('name'),
  start: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(48),
});
const progressBody = z.object({
  id: ID,
  positionSec: z.number().min(0).max(1_000_000),
  durationSec: z.number().min(0).max(1_000_000),
});
const imageQuery = z.object({ w: z.coerce.number().int().min(64).max(800).default(320) });

/** Only these may be passed on to the browser as they are; anything else is a plain download. */
const PASS_THROUGH = /^(video|audio)\//;
const FILE_CSP = "sandbox; default-src 'none'; media-src 'self'";

export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogRouteDeps): void {
  const { guards, client, progress } = deps;

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof JellyfinError) return sendError(reply, error.status, error.code, error.message);
    throw error;
  }

  const resumeFor =
    (userId: string) =>
    (id: string): Resume | undefined =>
      progress.get(userId, id.toLowerCase());

  app.get('/api/catalog', { preHandler: guards.requireUser }, async (request) => {
    const me = currentUser(request);
    const reason = await client.availability();
    const empty: CatalogHomeResponse = {
      available: false,
      reason,
      libraries: [],
      continueWatching: [],
      latest: [],
      genres: [],
      jellyfinUrl: deps.jellyfinUrl(),
    };
    if (reason !== null) return empty;
    try {
      const resume = resumeFor(me.id);
      const [libraries, latest, genres, continueWatching] = await Promise.all([
        client.libraries(),
        client.list({ sort: 'added', start: 0, limit: 18 }, resume),
        client.genres().catch(() => []),
        client.byIds(progress.continueIds(me.id, 12), resume),
      ]);
      const body: CatalogHomeResponse = {
        available: true,
        reason: null,
        libraries: libraries.filter((library) => library.kind !== 'other'),
        continueWatching,
        latest: latest.items,
        genres,
        jellyfinUrl: deps.jellyfinUrl(),
      };
      return body;
    } catch (error) {
      if (error instanceof JellyfinError) return { ...empty, reason: error.message };
      throw error;
    }
  });

  app.get('/api/catalog/items', { preHandler: guards.requireUser }, async (request, reply) => {
    const query = itemsQuery.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, 'bad_request', 'Некорректный запрос.');
    try {
      const page = await client.list(
        {
          sort: query.data.sort,
          start: query.data.start,
          limit: query.data.limit,
          ...(query.data.library ? { parentId: query.data.library } : {}),
          ...(query.data.q ? { search: query.data.q } : {}),
          ...(query.data.genre ? { genre: query.data.genre } : {}),
        },
        resumeFor(currentUser(request).id),
      );
      const body: CatalogItemsResponse = { items: page.items, total: page.total, start: query.data.start };
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/catalog/items/:id', { preHandler: guards.requireUser }, async (request, reply) => {
    const id = ID.safeParse((request.params as { id: string }).id);
    if (!id.success) return sendError(reply, 404, 'not_found', 'Такого фильма или файла в медиатеке нет.');
    try {
      const detail = await client.detail(id.data.toLowerCase(), resumeFor(currentUser(request).id));
      const body: CatalogDetailResponse = { ...detail, jellyfinUrl: deps.jellyfinUrl() };
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Posters. Public artwork of the family's own library; still only for signed-in people. */
  app.get('/api/catalog/image/:id', { preHandler: guards.requireUser }, async (request, reply) => {
    const id = ID.safeParse((request.params as { id: string }).id);
    const query = imageQuery.safeParse(request.query);
    if (!id.success || !query.success) return sendError(reply, 404, 'not_found', 'Нет картинки.');
    try {
      const image = await client.image(id.data.toLowerCase(), query.data.w);
      const type = image.headers.get('content-type') ?? '';
      if (!/^image\/(jpeg|png|webp)$/.test(type) || !image.body)
        return sendError(reply, 404, 'not_found', 'Нет картинки.');
      reply.header('Content-Type', type);
      reply.header('Cache-Control', 'private, max-age=3600');
      reply.header('Content-Security-Policy', "default-src 'none'");
      return reply.send(Readable.fromWeb(image.body as never));
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** The file itself for a browser that can play it; Jellyfin's key stays on the server. */
  app.get('/api/catalog/stream/:id', { preHandler: guards.requireUser }, async (request, reply) => {
    const id = ID.safeParse((request.params as { id: string }).id);
    if (!id.success) return sendError(reply, 404, 'not_found', 'Такого файла в медиатеке нет.');
    const aborter = new AbortController();
    reply.raw.on('close', () => aborter.abort());
    try {
      // The page says whether it is an audio file; the type is double-checked by the content type below.
      const wantsAudio = (request.query as { as?: string }).as === 'audio';
      const upstream = await client.stream(
        id.data.toLowerCase(),
        wantsAudio ? 'audio' : 'video',
        request.headers.range,
        aborter.signal,
      );
      const type = upstream.headers.get('content-type') ?? '';
      if (!upstream.body) return sendError(reply, 404, 'not_found', 'Такого файла в медиатеке нет.');
      reply.code(upstream.status === 206 ? 206 : 200);
      reply.header('Content-Type', PASS_THROUGH.test(type) ? type : 'application/octet-stream');
      for (const name of ['content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name);
        if (value) reply.header(name, value);
      }
      reply.header('Content-Security-Policy', FILE_CSP);
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(Readable.fromWeb(upstream.body as never));
    } catch (error) {
      if (aborter.signal.aborted) return reply;
      return fail(reply, error);
    }
  });

  app.post('/api/catalog/progress', { preHandler: guards.requireUser }, async (request, reply) => {
    const body = progressBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request', 'Некорректные данные.');
    progress.put(
      currentUser(request).id,
      body.data.id.toLowerCase(),
      body.data.positionSec,
      body.data.durationSec,
    );
    return reply.code(204).send();
  });
}
