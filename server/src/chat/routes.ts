import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { createSlidingWindowLimiter } from '../auth/rate-limit.ts';
import { sendError } from '../lib/http.ts';
import { parseByteRange } from '../lib/range.ts';
import type { Clock } from '../lib/time.ts';
import { ChatError, type ChatService, MESSAGE_MAX } from './service.ts';

export interface ChatRouteDeps {
  chat: ChatService;
  guards: Guards;
  audit: AuditLog;
  clock: Clock;
}

const idParam = z.string().max(40);
const clientIdSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
  .nullish();

const sendBody = z.object({ text: z.string().max(MESSAGE_MAX * 2), clientId: clientIdSchema });
const directBody = z.object({ userId: z.string().max(64) });
const groupBody = z.object({ title: z.string().max(200), memberIds: z.array(z.string().max(64)).max(30) });
const titleBody = z.object({ title: z.string().max(200) });
const membersBody = z.object({ memberIds: z.array(z.string().max(64)).min(1).max(30) });
const memberBody = z.object({ userId: z.string().max(64) });
const readBody = z.object({ seq: z.number().int().min(0) });
const messagesQuery = z.object({
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
const attachmentQuery = z.object({
  name: z.string().min(1).max(200),
  size: z.coerce.number().int().min(1),
  text: z
    .string()
    .max(MESSAGE_MAX * 2)
    .default(''),
  clientId: clientIdSchema,
});

/** Same as the files: only types a browser shows without running anything. Everything else downloads. */
const INLINE_MIME =
  /^(image\/(jpeg|png|gif|webp|avif|heic)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|aac|ogg|wav|flac))$/;
const ATTACHMENT_CSP =
  "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  const { chat, guards } = deps;
  const sendLimiter = createSlidingWindowLimiter({ limit: 60, windowMs: 60_000, clock: deps.clock });
  const createLimiter = createSlidingWindowLimiter({ limit: 20, windowMs: 10 * 60_000, clock: deps.clock });

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof ChatError) return sendError(reply, error.status, error.code, error.message);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      return sendError(reply, 409, 'busy', 'Файл занят другой программой или нет доступа. Попробуйте позже.');
    }
    throw error;
  }

  function throttled(
    reply: FastifyReply,
    limiter: ReturnType<typeof createSlidingWindowLimiter>,
    key: string,
  ) {
    const check = limiter.check(key);
    if (check.allowed) {
      limiter.hit(key);
      return null;
    }
    reply.header('Retry-After', String(check.retryAfterSec));
    return sendError(reply, 429, 'too_many_requests', 'Слишком часто. Подождите немного.');
  }

  app.get('/api/chat/conversations', { preHandler: guards.requireUser }, async (request) => {
    return chat.list(currentUser(request));
  });

  app.post('/api/chat/conversations/direct', { preHandler: guards.requireUser }, async (request, reply) => {
    const body = directBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request', 'Выберите человека.');
    try {
      return await chat.openDirect(currentUser(request), body.data.userId);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/chat/conversations/group', { preHandler: guards.requireUser }, async (request, reply) => {
    const me = currentUser(request);
    const limited = throttled(reply, createLimiter, me.id);
    if (limited) return limited;
    const body = groupBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request', 'Назовите группу и выберите людей.');
    try {
      return await chat.createGroup(me, body.data.title, body.data.memberIds);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(
    '/api/chat/conversations/:id/rename',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const id = idParam.safeParse((request.params as { id: string }).id);
      const body = titleBody.safeParse(request.body);
      if (!id.success || !body.success) return sendError(reply, 400, 'bad_request', 'Назовите группу.');
      try {
        return await chat.rename(currentUser(request), id.data, body.data.title);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/chat/conversations/:id/members',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const id = idParam.safeParse((request.params as { id: string }).id);
      const body = membersBody.safeParse(request.body);
      if (!id.success || !body.success) return sendError(reply, 400, 'bad_request', 'Выберите людей.');
      try {
        return await chat.addMembers(currentUser(request), id.data, body.data.memberIds);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/chat/conversations/:id/members/remove',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const id = idParam.safeParse((request.params as { id: string }).id);
      const body = memberBody.safeParse(request.body);
      if (!id.success || !body.success) return sendError(reply, 400, 'bad_request', 'Выберите человека.');
      try {
        return await chat.removeMember(currentUser(request), id.data, body.data.userId);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/chat/conversations/:id/leave',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const id = idParam.safeParse((request.params as { id: string }).id);
      if (!id.success) return sendError(reply, 404, 'not_found', 'Такого чата нет.');
      try {
        await chat.leave(currentUser(request), id.data);
        return reply.code(204).send();
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get(
    '/api/chat/conversations/:id/messages',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const id = idParam.safeParse((request.params as { id: string }).id);
      const query = messagesQuery.safeParse(request.query);
      if (!id.success || !query.success) return sendError(reply, 400, 'bad_request', 'Некорректный запрос.');
      try {
        return await chat.messages(
          currentUser(request),
          id.data,
          query.data.before ?? null,
          query.data.limit,
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post(
    '/api/chat/conversations/:id/messages',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const me = currentUser(request);
      const id = idParam.safeParse((request.params as { id: string }).id);
      const body = sendBody.safeParse(request.body);
      if (!id.success || !body.success) return sendError(reply, 400, 'bad_request', 'Напишите сообщение.');
      const limited = throttled(reply, sendLimiter, me.id);
      if (limited) return limited;
      try {
        return await chat.send(me, id.data, body.data.text, body.data.clientId ?? null);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put(
    '/api/chat/conversations/:id/attachment',
    { preHandler: guards.requireUser, config: { rawUpload: true } },
    async (request, reply) => {
      const me = currentUser(request);
      try {
        const id = idParam.safeParse((request.params as { id: string }).id);
        const query = attachmentQuery.safeParse(request.query);
        if (!id.success || !query.success)
          return sendError(reply, 400, 'bad_request', 'Не указаны имя или размер файла.');
        const limited = throttled(reply, sendLimiter, me.id);
        if (limited) return limited;
        const length = Number(request.headers['content-length'] ?? Number.NaN);
        if (!Number.isFinite(length) || length !== query.data.size) {
          return sendError(reply, 411, 'length_required', 'Размер файла не совпадает с переданным.');
        }
        return await chat.sendAttachment(
          me,
          id.data,
          {
            name: query.data.name,
            size: query.data.size,
            text: query.data.text,
            clientId: query.data.clientId ?? null,
          },
          request.body as NodeJS.ReadableStream,
        );
      } catch (error) {
        // The rest of a refused upload is not read: the connection closes after the answer.
        reply.header('Connection', 'close');
        return fail(reply, error);
      }
    },
  );

  app.post('/api/chat/conversations/:id/read', { preHandler: guards.requireUser }, async (request, reply) => {
    const id = idParam.safeParse((request.params as { id: string }).id);
    const body = readBody.safeParse(request.body);
    if (!id.success || !body.success) return sendError(reply, 400, 'bad_request', 'Некорректный запрос.');
    try {
      await chat.markRead(currentUser(request), id.data, body.data.seq);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(
    '/api/chat/conversations/:id/messages/:messageId/delete',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const params = request.params as { id: string; messageId: string };
      const id = idParam.safeParse(params.id);
      const messageId = idParam.safeParse(params.messageId);
      if (!id.success || !messageId.success)
        return sendError(reply, 404, 'not_found', 'Такого сообщения нет.');
      try {
        await chat.deleteMessage(currentUser(request), id.data, messageId.data);
        return reply.code(204).send();
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get(
    '/api/chat/conversations/:id/messages/:messageId/file',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const params = request.params as { id: string; messageId: string };
      const id = idParam.safeParse(params.id);
      const messageId = idParam.safeParse(params.messageId);
      if (!id.success || !messageId.success)
        return sendError(reply, 404, 'not_found', 'Такого вложения нет.');
      try {
        const { file, stat, name, mime } = await chat.openAttachment(
          currentUser(request),
          id.data,
          messageId.data,
        );
        const wantInline = (request.query as { inline?: string }).inline === '1' && INLINE_MIME.test(mime);
        reply.header('Content-Type', wantInline ? mime : 'application/octet-stream');
        reply.header('Content-Disposition', disposition(wantInline ? 'inline' : 'attachment', name));
        reply.header('Content-Security-Policy', ATTACHMENT_CSP);
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
          return reply.send(createReadStream(file, { start: range.start, end: range.end }));
        }
        reply.header('Content-Length', String(stat.size));
        return reply.send(createReadStream(file));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
