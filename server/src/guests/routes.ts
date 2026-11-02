import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import type { Guests } from './guests.ts';

/** For the administrator: who from outside the family writes to the bot and is subscribed; stop or remove a person. */
export function registerGuestRoutes(app: FastifyInstance, deps: { guests: Guests; guards: Guards }): void {
  const { guests, guards } = deps;

  app.get('/api/admin/guests', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    const list = await guests.list();
    return reply.header('cache-control', 'no-store').send({
      guests: list
        .map((g) => ({
          chatId: g.chatId,
          name: g.name,
          joinedAt: g.joinedAt,
          subscribed: g.subscribed,
          topics: g.topics,
          city: g.city,
          blocked: g.blocked,
          total: g.total,
        }))
        .sort((a, b) => b.joinedAt.localeCompare(a.joinedAt)),
    });
  });

  const body = z
    .object({ chatId: z.string().regex(/^-?\d{3,20}$/), blocked: z.boolean().optional() })
    .strict();

  app.post('/api/admin/guests/block', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не понял, кого остановить.');
    const ok = await guests.block(parsed.data.chatId, parsed.data.blocked !== false);
    return ok ? { ok: true } : sendError(reply, 404, 'not_found', 'Такого собеседника нет.');
  });

  app.post('/api/admin/guests/remove', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не понял, кого убрать.');
    const ok = await guests.remove(parsed.data.chatId);
    return ok ? { ok: true } : sendError(reply, 404, 'not_found', 'Такого собеседника нет.');
  });
}
