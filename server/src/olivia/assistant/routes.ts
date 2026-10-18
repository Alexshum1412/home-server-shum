import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditLog } from '../../audit/log.ts';
import { currentUser, type Guards } from '../../auth/guards.ts';
import { createSlidingWindowLimiter } from '../../auth/rate-limit.ts';
import type { Config } from '../../config.ts';
import { requestChannel } from '../../lib/channel.ts';
import { sendError } from '../../lib/http.ts';
import type { Clock } from '../../lib/time.ts';
import type { Assistant } from './assistant.ts';

export interface AssistantRouteDeps {
  config: Config;
  clock: Clock;
  guards: Guards;
  audit: AuditLog;
  assistant: Assistant;
}

const askSchema = z.object({ message: z.string().trim().min(1).max(600) });

export function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRouteDeps): void {
  const { config, guards, audit, assistant } = deps;
  const limiter = createSlidingWindowLimiter({ limit: 20, windowMs: 60_000, clock: deps.clock });

  app.get('/api/olivia/status', { preHandler: guards.requireUser }, async (_request, reply) => {
    if (!config.oliviaEnabled)
      return sendError(reply, 404, 'not_found', 'Оливия выключена (OLIVIA_ENABLED=0).');
    return assistant.status();
  });

  app.post('/api/olivia/ask', { preHandler: guards.requireUser }, async (request, reply) => {
    if (!config.oliviaEnabled)
      return sendError(reply, 404, 'not_found', 'Оливия выключена (OLIVIA_ENABLED=0).');
    const body = askSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request', 'Напишите вопрос (до 600 знаков).');
    const user = currentUser(request);
    const check = limiter.check(user.id);
    if (!check.allowed) {
      reply.header('Retry-After', String(check.retryAfterSec));
      return sendError(reply, 429, 'too_many_requests', 'Слишком много вопросов подряд. Подождите минуту.');
    }
    limiter.hit(user.id);
    const answer = await assistant.ask(user, body.data.message, requestChannel(request, config));
    // What was asked is private and is not written down; only which kind of help was given.
    await audit.write({
      action: 'olivia.action',
      actor: user.username,
      ip: request.ip,
      detail: `вопрос: ${answer.tool}`,
    });
    return answer;
  });
}
