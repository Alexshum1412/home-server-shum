import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  DownloadCheckResponse,
  DownloadDestination,
  DownloadsResponse,
  DownloadTaskView,
} from '../../../shared/api.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { createSlidingWindowLimiter } from '../auth/rate-limit.ts';
import { hasPermission } from '../auth/users.ts';
import type { Config } from '../config.ts';
import { sendError } from '../lib/http.ts';
import type { Clock } from '../lib/time.ts';
import { DownloadError, type DownloadManager, statfsFree } from './manager.ts';
import type { TorrentManager } from './torrents.ts';

export interface DownloadRouteDeps {
  config: Config;
  clock: Clock;
  guards: Guards;
  downloads: DownloadManager;
  torrents: TorrentManager;
}

const NO_RIGHT =
  'Загрузки доступны по разрешению администратора. Попросите его выполнить на сервере: scripts\\user.cmd allow <ваш логин> downloads';

const checkSchema = z.object({ url: z.string().min(1).max(4096) });
const addSchema = z.object({
  checkId: z.string().uuid(),
  destination: z.enum(['personal', 'movies', 'series', 'cartoons', 'music']).default('personal'),
});
const ID_RE = /^([0-9a-f-]{36}|t-[0-9a-f]{40})$/;
const TORRENT_FILE_MAX = 4 * 1024 * 1024;

/** Reads a request body into memory, refusing more than `limit` bytes. */
async function readLimited(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += piece.length;
    if (total > limit)
      throw new DownloadError(413, 'too_large', 'Файл .torrent слишком большой (больше 4 МБ).');
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

export function registerDownloadRoutes(app: FastifyInstance, deps: DownloadRouteDeps): void {
  const { config, guards, downloads, torrents } = deps;
  // Every check makes an outgoing request (or asks the torrent client): bounded per user.
  const checkLimiter = createSlidingWindowLimiter({ limit: 30, windowMs: 10 * 60_000, clock: deps.clock });

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof DownloadError) return sendError(reply, error.status, error.code, error.message);
    throw error;
  }

  function allowed(request: FastifyRequest): boolean {
    return hasPermission(currentUser(request), 'downloads');
  }

  function throttled(reply: FastifyReply, key: string) {
    const limit = checkLimiter.check(key);
    if (!limit.allowed) {
      reply.header('Retry-After', String(limit.retryAfterSec));
      return sendError(
        reply,
        429,
        'too_many_requests',
        'Слишком много проверок подряд. Подождите несколько минут.',
      );
    }
    checkLimiter.hit(key);
    return null;
  }

  app.get('/api/downloads', { preHandler: guards.requireUser }, async (request) => {
    const user = currentUser(request);
    const permitted = allowed(request);
    const owner = user.role === 'admin' ? null : user.username;
    const tasks: DownloadTaskView[] = permitted
      ? [...downloads.list(owner), ...(await torrents.list(owner))].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        )
      : [];
    const body: DownloadsResponse = {
      allowed: permitted,
      tasks,
      limits: {
        maxFileBytes: config.downloadMaxFileBytes,
        minFreeBytes: config.minFreeBytes,
        freeBytes: permitted ? await statfsFree(config.filesDir).catch(() => null) : null,
      },
      folderLabel: 'Файлы → Личное → Загрузки',
      torrentEngine: permitted ? await torrents.engine() : { state: 'ok', message: '', hint: null },
    };
    return body;
  });

  app.post('/api/downloads/check', { preHandler: guards.requireUser }, async (request, reply) => {
    if (!allowed(request)) return sendError(reply, 403, 'forbidden', NO_RIGHT);
    const parsed = checkSchema.safeParse(request.body);
    if (!parsed.success)
      return sendError(reply, 400, 'bad_url', 'Вставьте ссылку на файл или магнитную ссылку.');
    const user = currentUser(request);
    const limited = throttled(reply, user.username);
    if (limited) return limited;
    try {
      if (/^magnet:/i.test(parsed.data.url.trim())) {
        return await torrents.checkMagnet(user.username, parsed.data.url);
      }
      const probe = await downloads.probe(user.username, parsed.data.url);
      const body: DownloadCheckResponse = {
        ...probe,
        kind: 'link',
        status: 'ready',
        error: null,
        files: [],
        willDownload: null,
        destinations: [{ id: 'personal', label: 'Файлы → Личное → Загрузки' }],
      };
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** A .torrent file from the phone or the computer: read here, checked here, then (and only then) given to the client. */
  app.put(
    '/api/downloads/torrent-file',
    { preHandler: guards.requireUser, config: { rawUpload: true } },
    async (request, reply) => {
      try {
        if (!allowed(request)) return sendError(reply, 403, 'forbidden', NO_RIGHT);
        const user = currentUser(request);
        const limited = throttled(reply, user.username);
        if (limited) return limited;
        const length = Number(request.headers['content-length'] ?? Number.NaN);
        if (!Number.isFinite(length) || length <= 0 || length > TORRENT_FILE_MAX) {
          return sendError(reply, 413, 'too_large', 'Файл .torrent должен быть не больше 4 МБ.');
        }
        const bytes = await readLimited(request.body as NodeJS.ReadableStream, TORRENT_FILE_MAX);
        const name = String((request.query as { name?: string }).name ?? 'файл.torrent').slice(0, 120);
        return await torrents.checkFile(user.username, bytes, name);
      } catch (error) {
        reply.header('Connection', 'close');
        return fail(reply, error);
      }
    },
  );

  app.get('/api/downloads/check/:id', { preHandler: guards.requireUser }, async (request, reply) => {
    if (!allowed(request)) return sendError(reply, 403, 'forbidden', NO_RIGHT);
    const { id } = request.params as { id: string };
    const view = ID_RE.test(id) ? torrents.getCheck(currentUser(request).username, id) : null;
    if (!view) return sendError(reply, 404, 'not_found', 'Проверка устарела — проверьте ещё раз.');
    return view;
  });

  app.post('/api/downloads', { preHandler: guards.requireUser }, async (request, reply) => {
    if (!allowed(request)) return sendError(reply, 403, 'forbidden', NO_RIGHT);
    const parsed = addSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Сначала проверьте ссылку.');
    const owner = currentUser(request).username;
    try {
      if (torrents.isTorrentCheck(parsed.data.checkId)) {
        return await torrents.add(owner, parsed.data.checkId, parsed.data.destination as DownloadDestination);
      }
      return await downloads.add(owner, parsed.data.checkId);
    } catch (error) {
      return fail(reply, error);
    }
  });

  for (const action of ['pause', 'resume', 'cancel', 'remove', 'retry'] as const) {
    app.post(`/api/downloads/:id/${action}`, { preHandler: guards.requireUser }, async (request, reply) => {
      if (!allowed(request)) return sendError(reply, 403, 'forbidden', NO_RIGHT);
      const { id } = request.params as { id: string };
      if (!ID_RE.test(id)) return sendError(reply, 404, 'not_found', 'Такой загрузки нет.');
      const user = currentUser(request);
      const actor = { username: user.username, isAdmin: user.role === 'admin' };
      try {
        if (torrents.owns(id)) {
          const view = await torrents.act(id, action, actor);
          return view ?? reply.code(204).send();
        }
        if (action === 'remove') {
          await downloads.remove(id, actor);
          return reply.code(204).send();
        }
        // A failed link download is retried by «resume»: the same range request.
        return await downloads[action === 'retry' ? 'resume' : action](id, actor);
      } catch (error) {
        return fail(reply, error);
      }
    });
  }
}
