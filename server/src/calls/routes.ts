import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { createSlidingWindowLimiter } from '../auth/rate-limit.ts';
import { sendError } from '../lib/http.ts';
import type { Clock } from '../lib/time.ts';
import { CallError, type CallManager } from './manager.ts';

export interface CallRouteDeps {
  calls: CallManager;
  guards: Guards;
  audit: AuditLog;
  clock: Clock;
}

const startBody = z.object({ conversationId: z.string().max(40), video: z.boolean() });
const signalBody = z.object({
  to: z.string().max(64),
  type: z.enum(['offer', 'answer', 'candidate']),
  data: z.unknown(),
});
const idParam = z.string().regex(/^[0-9a-f-]{36}$/);

export function registerCallRoutes(app: FastifyInstance, deps: CallRouteDeps): void {
  const { calls, guards, audit } = deps;
  const startLimiter = createSlidingWindowLimiter({ limit: 10, windowMs: 60_000, clock: deps.clock });
  const signalLimiter = createSlidingWindowLimiter({ limit: 900, windowMs: 60_000, clock: deps.clock });

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof CallError) return sendError(reply, error.status, error.code, error.message);
    throw error;
  }

  app.get('/api/calls/config', { preHandler: guards.requireUser }, async (request) => {
    return calls.config(currentUser(request));
  });

  app.get('/api/calls/active', { preHandler: guards.requireUser }, async (request) => {
    return { call: await calls.active(currentUser(request)) };
  });

  app.post('/api/calls', { preHandler: guards.requireUser }, async (request, reply) => {
    const me = currentUser(request);
    const body = startBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request', 'Выберите чат для звонка.');
    const check = startLimiter.check(me.id);
    if (!check.allowed) {
      reply.header('Retry-After', String(check.retryAfterSec));
      return sendError(reply, 429, 'too_many_requests', 'Слишком много звонков подряд. Подождите минуту.');
    }
    startLimiter.hit(me.id);
    try {
      const result = await calls.start(me, body.data.conversationId, body.data.video);
      await audit.write({
        action: 'call.start',
        actor: me.username,
        ip: request.ip,
        detail: body.data.video ? 'видео' : 'голос',
      });
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  for (const action of ['join', 'decline', 'leave'] as const) {
    app.post(`/api/calls/:id/${action}`, { preHandler: guards.requireUser }, async (request, reply) => {
      const id = idParam.safeParse((request.params as { id: string }).id);
      if (!id.success) return sendError(reply, 404, 'not_found', 'Этот звонок уже закончился.');
      const me = currentUser(request);
      try {
        if (action === 'join') return await calls.join(me, id.data);
        if (action === 'decline') await calls.decline(me, id.data);
        else await calls.leave(me, id.data);
        return reply.code(204).send();
      } catch (error) {
        return fail(reply, error);
      }
    });
  }

  app.post('/api/calls/:id/signal', { preHandler: guards.requireUser }, async (request, reply) => {
    const id = idParam.safeParse((request.params as { id: string }).id);
    const body = signalBody.safeParse(request.body);
    if (!id.success || !body.success)
      return sendError(reply, 400, 'bad_request', 'Некорректное сообщение для соединения.');
    const me = currentUser(request);
    const check = signalLimiter.check(me.id);
    if (!check.allowed) return sendError(reply, 429, 'too_many_requests', 'Слишком часто.');
    signalLimiter.hit(me.id);
    try {
      calls.signal(me, id.data, body.data.to, body.data.type, body.data.data);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });
}
