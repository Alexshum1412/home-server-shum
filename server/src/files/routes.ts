import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FileListResponse, StorageRoot, StorageSpace, UploadResponse } from '../../../shared/api.ts';
import type {
  AlbumsResponse,
  HashQueryResponse,
  TrashResponse,
  UploadSessionState,
} from '../../../shared/storage-extras.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import { parseByteRange } from '../lib/range.ts';
import type { HashIndex } from './hashes.ts';
import type { Quota } from './quota.ts';
import { OffsetMismatch, type UploadSessions } from './sessions.ts';
import { contentTypeFor, type Location, type Storage, StorageError } from './storage.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** PUT with a raw application/octet-stream body and the header X-Upload: 1 (see app.ts). */
    rawUpload?: boolean;
  }
}

export interface FileRouteDeps {
  storage: Storage;
  guards: Guards;
  audit: AuditLog;
  freeBytes: (dir: string) => Promise<number | null>;
  maxUploadBytes: number;
  sessions: UploadSessions;
  hashes: HashIndex;
  quota: Quota;
}

const rootSchema = z.enum(['files', 'photos']);
const locSchema = z.object({
  space: z.enum(['personal', 'shared']),
  path: z.string().max(400).default(''),
});

/** Safe file name for Content-Disposition: ASCII fallback plus RFC 5987 UTF-8. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Sandboxed: a file opened directly can never run scripts or reach the portal's cookies. */
const FILE_CSP =
  "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const { storage, guards, audit } = deps;

  function location(request: FastifyRequest, source: unknown): Location {
    const root = rootSchema.safeParse((request.params as { root?: string }).root);
    const loc = locSchema.safeParse(source);
    if (!root.success || !loc.success) throw new StorageError(400, 'bad_request', 'Некорректный путь.');
    return { root: root.data, space: loc.data.space, path: loc.data.path.replace(/\\/g, '/') };
  }

  function fail(reply: FastifyReply, error: unknown) {
    // A piece that does not begin where the server's copy ends: the true position goes with the refusal.
    if (error instanceof OffsetMismatch) {
      return reply
        .code(409)
        .send({ error: error.code, message: error.message, receivedBytes: error.receivedBytes });
    }
    if (error instanceof StorageError) return sendError(reply, error.status, error.code, error.message);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return sendError(reply, 404, 'not_found', 'Такого файла или папки нет.');
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      return sendError(reply, 409, 'busy', 'Файл занят другой программой или нет доступа. Попробуйте позже.');
    }
    throw error;
  }

  /** Shared-space actions are logged with names; personal ones without (they are private). */
  async function log(
    request: FastifyRequest,
    action: 'file.upload' | 'file.trash' | 'file.rename' | 'file.mkdir',
    loc: Location,
    name: string,
  ) {
    const where = `${loc.root === 'photos' ? 'Фото' : 'Файлы'}, ${loc.space === 'shared' ? 'общее' : 'личное'}`;
    await audit.write({
      action,
      actor: currentUser(request).username,
      ip: request.ip,
      detail: loc.space === 'shared' ? `${where}: ${loc.path ? `${loc.path}/` : ''}${name}` : where,
    });
  }

  app.get('/api/storage/:root/list', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const loc = location(request, request.query);
      const user = currentUser(request).username;
      const entries = await storage.list(loc, user);
      const body: FileListResponse = {
        root: loc.root as StorageRoot,
        space: loc.space as StorageSpace,
        path: loc.path,
        entries,
        freeBytes: await deps.freeBytes(storage.rootDir(loc.root)).catch(() => null),
        maxUploadBytes: deps.maxUploadBytes,
        // The own space only: the shared one belongs to the family and has no limit of a person.
        quota: loc.space === 'personal' ? await deps.quota.state(user) : null,
      };
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/storage/:root/file', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const query = request.query as Record<string, string | undefined>;
      const loc = location(request, query);
      const { file, stat, name } = await storage.openFile(loc, currentUser(request).username);
      const type = contentTypeFor(name);
      const inline = query.inline === '1' && type.inline;
      reply.header('Content-Type', inline ? type.type : 'application/octet-stream');
      reply.header('Content-Disposition', disposition(inline ? 'inline' : 'attachment', name));
      reply.header('Content-Security-Policy', FILE_CSP);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', 'private, no-store');
      const range = parseByteRange(request.headers.range, stat.size);
      if (range === 'invalid') {
        reply.header('Content-Range', `bytes */${stat.size}`);
        return reply.code(416).send();
      }
      if (range) {
        reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        reply.header('Content-Length', String(range.end - range.start + 1));
        return reply.send(storage.stream(file, { start: range.start, end: range.end }));
      }
      reply.header('Content-Length', String(stat.size));
      return reply.send(storage.stream(file));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/storage/:root/thumb', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const loc = location(request, request.query);
      const { file, stat } = await storage.openThumb(loc, currentUser(request).username);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Content-Length', String(stat.size));
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(storage.stream(file));
    } catch (error) {
      return fail(reply, error);
    }
  });

  const nameBody = locSchema.extend({ name: z.string().min(1).max(200) });

  app.post('/api/storage/:root/mkdir', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const parsed = nameBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Укажите имя папки.');
      const loc = location(request, parsed.data);
      const name = await storage.mkdir(loc, currentUser(request).username, parsed.data.name);
      await log(request, 'file.mkdir', loc, name);
      return { name };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/storage/:root/rename', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const parsed = nameBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Укажите новое имя.');
      const loc = location(request, parsed.data);
      const name = await storage.rename(loc, currentUser(request).username, parsed.data.name);
      await log(request, 'file.rename', loc, name);
      return { name };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/storage/:root/trash', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const parsed = locSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не указан файл.');
      const loc = location(request, parsed.data);
      await storage.trash(loc, currentUser(request).username);
      await log(request, 'file.trash', loc, '');
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  const uploadQuery = locSchema.extend({
    name: z.string().min(1).max(200),
    size: z.coerce.number().int().min(0),
    /** JPEG: take the place of shooting and the camera's notes out (1), or keep the file as it is (0, the default of this older way). */
    strip: z.enum(['0', '1']).optional(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  });

  app.put(
    '/api/storage/:root/upload',
    { preHandler: guards.requireUser, config: { rawUpload: true } },
    async (request, reply) => {
      try {
        const parsed = uploadQuery.safeParse(request.query);
        if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не указаны имя или размер файла.');
        const loc = location(request, parsed.data);
        const length = Number(request.headers['content-length'] ?? Number.NaN);
        if (!Number.isFinite(length) || length !== parsed.data.size) {
          return sendError(reply, 411, 'length_required', 'Размер файла не совпадает с переданным.');
        }
        const result: UploadResponse = await storage.upload(
          loc,
          currentUser(request).username,
          parsed.data.name,
          parsed.data.size,
          request.body as NodeJS.ReadableStream,
          {
            strip: parsed.data.strip === '1',
            ...(parsed.data.sha256 ? { expectedSha256: parsed.data.sha256 } : {}),
          },
        );
        await log(request, 'file.upload', loc, result.name);
        return result;
      } catch (error) {
        // The rest of a refused upload is not read: the connection closes after the answer.
        reply.header('Connection', 'close');
        return fail(reply, error);
      }
    },
  );

  app.put(
    '/api/storage/:root/thumb',
    { preHandler: guards.requireUser, config: { rawUpload: true } },
    async (request, reply) => {
      try {
        const parsed = locSchema.extend({ name: z.string().min(1).max(200) }).safeParse(request.query);
        if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не указана фотография.');
        const loc = location(request, parsed.data);
        const length = Number(request.headers['content-length'] ?? Number.NaN);
        await storage.saveThumb(
          loc,
          currentUser(request).username,
          parsed.data.name,
          request.body as NodeJS.ReadableStream,
          length,
        );
        return reply.code(204).send();
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
  // --- uploads that survive a broken connection ----------------------------------------------------

  const sessionBody = locSchema.extend({
    name: z.string().min(1).max(200),
    size: z.number().int().min(0),
    strip: z.boolean().optional(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  });
  const idParams = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/) });

  app.post('/api/storage/:root/session', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const parsed = sessionBody.safeParse(request.body);
      if (!parsed.success)
        return sendError(reply, 400, 'bad_request', 'Не указаны имя, размер или место файла.');
      const loc = location(request, parsed.data);
      const state: UploadSessionState = await deps.sessions.start(currentUser(request).username, loc.root, {
        space: loc.space,
        path: loc.path,
        name: parsed.data.name,
        size: parsed.data.size,
        ...(parsed.data.strip === undefined ? {} : { strip: parsed.data.strip }),
        ...(parsed.data.sha256 ? { sha256: parsed.data.sha256 } : {}),
      });
      return state;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/storage/:root/session/:id', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const { root } = request.params as { root: string };
      const id = idParams.safeParse(request.params);
      if (!id.success || !rootSchema.safeParse(root).success) {
        return sendError(reply, 404, 'not_found', 'Такой передачи нет.');
      }
      return await deps.sessions.status(currentUser(request).username, root as StorageRoot, id.data.id);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put(
    '/api/storage/:root/session/:id',
    { preHandler: guards.requireUser, config: { rawUpload: true } },
    async (request, reply) => {
      try {
        const { root } = request.params as { root: string };
        const id = idParams.safeParse(request.params);
        const query = z.object({ offset: z.coerce.number().int().min(0) }).safeParse(request.query);
        if (!id.success || !rootSchema.safeParse(root).success) {
          return sendError(reply, 404, 'not_found', 'Такой передачи нет.');
        }
        if (!query.success) return sendError(reply, 400, 'bad_request', 'Не указано, с какого байта кусок.');
        const length = Number(request.headers['content-length'] ?? Number.NaN);
        const have = await deps.sessions.append(
          currentUser(request).username,
          root as StorageRoot,
          id.data.id,
          query.data.offset,
          length,
          request.body as NodeJS.ReadableStream,
        );
        return { receivedBytes: have };
      } catch (error) {
        reply.header('Connection', 'close');
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/storage/:root/session/:id/finish',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      try {
        const { root } = request.params as { root: string };
        const id = idParams.safeParse(request.params);
        if (!id.success || !rootSchema.safeParse(root).success) {
          return sendError(reply, 404, 'not_found', 'Такой передачи нет.');
        }
        const me = currentUser(request).username;
        const state = await deps.sessions.status(me, root as StorageRoot, id.data.id);
        const result: UploadResponse = await deps.sessions.finish(me, root as StorageRoot, id.data.id);
        // The place is not in the answer of the session, but the journal of the shared space names the file.
        await audit.write({
          action: 'file.upload',
          actor: me,
          ip: request.ip,
          detail: `${root === 'photos' ? 'Фото' : 'Файлы'}: ${state.name}`.slice(0, 300),
        });
        return result;
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/storage/:root/session/:id/cancel',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      try {
        const { root } = request.params as { root: string };
        const id = idParams.safeParse(request.params);
        if (!id.success || !rootSchema.safeParse(root).success) return reply.code(204).send();
        await deps.sessions.cancel(currentUser(request).username, root as StorageRoot, id.data.id);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof StorageError && error.status === 404) return reply.code(204).send();
        return fail(reply, error);
      }
    },
  );

  // --- «это фото у нас уже есть» ----------------------------------------------------------------------

  app.post('/api/storage/photos/hashes', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const parsed = z
        .object({
          space: z.enum(['personal', 'shared']),
          hashes: z
            .array(z.string().regex(/^[0-9a-f]{64}$/))
            .min(1)
            .max(200),
        })
        .safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не указаны фотографии для проверки.');
      const answer: HashQueryResponse = await deps.hashes.query(
        parsed.data.space,
        currentUser(request).username,
        parsed.data.hashes,
      );
      return answer;
    } catch (error) {
      return fail(reply, error);
    }
  });

  // --- the trash, put back, move, albums --------------------------------------------------------------

  app.get('/api/storage/:root/trash', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const loc = location(request, { ...(request.query as object), path: '' });
      const body: TrashResponse = {
        entries: await storage.listTrash(loc.root, loc.space, currentUser(request).username),
      };
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/storage/:root/restore', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const parsed = locSchema.extend({ id: z.string().min(1).max(300) }).safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не указано, что вернуть.');
      const loc = location(request, { ...parsed.data, path: '' });
      const result = await storage.restore(
        loc.root,
        loc.space,
        currentUser(request).username,
        parsed.data.id,
      );
      await log(request, 'file.rename', { ...loc, path: result.folder }, result.name);
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/storage/:root/move', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const parsed = locSchema.extend({ to: z.string().max(400).default('') }).safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не указано, что и куда переместить.');
      const loc = location(request, parsed.data);
      const result = await storage.move(
        loc,
        currentUser(request).username,
        parsed.data.to.replace(/\\/g, '/'),
      );
      await log(request, 'file.rename', { ...loc, path: result.folder }, result.name);
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/storage/photos/albums', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const parsed = z.object({ space: z.enum(['personal', 'shared']) }).safeParse(request.query);
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не указано, чьи альбомы.');
      const body: AlbumsResponse = {
        albums: await storage.albums(parsed.data.space, currentUser(request).username),
      };
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });
}
