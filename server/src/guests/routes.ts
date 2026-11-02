import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import type { Guests } from './guests.ts';

/** For the administrator: who from outside the family writes to the bot, what they chose, and what they are allowed. */
export function registerGuestRoutes(app: FastifyInstance, deps: { guests: Guests; guards: Guards }): void {
  const { guests, guards } = deps;

  app.get('/api/admin/guests', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const q = String((request.query as { q?: string }).q ?? '')
      .trim()
      .toLowerCase()
      .slice(0, 80);
    const list = (await guests.list())
      .filter((g) =>
        q === ''
          ? true
          : [g.name, g.username, g.note, g.city, g.chatId].some((value) => value.toLowerCase().includes(q)),
      )
      .map((g) => ({
        chatId: g.chatId,
        name: g.name,
        username: g.username,
        note: g.note,
        joinedAt: g.joinedAt,
        lastAt: g.lastAt,
        subscribed: g.subscribed,
        topics: g.topics,
        city: g.city,
        blocked: g.blocked,
        chat: g.chat,
        total: g.total,
      }))
      .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
    return reply.header('cache-control', 'no-store').send({ guests: list });
  });

  const id = z.string().regex(/^-?\d{3,20}$/);
  const body = z.object({ chatId: id, blocked: z.boolean().optional() }).strict();

  app.post('/api/admin/guests/block', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не понял, кого остановить.');
    const ok = await guests.block(parsed.data.chatId, parsed.data.blocked !== false);
    return ok ? { ok: true } : sendError(reply, 404, 'not_found', 'Такого человека нет.');
  });

  // The rights beyond the digest: the administrator gives them to a person they got to know.
  app.post('/api/admin/guests/update', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = z
      .object({ chatId: id, chat: z.boolean().optional(), note: z.string().max(200).optional() })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не понял, что изменить.');
    const { chatId, ...patch } = parsed.data;
    const updated = await guests.update(chatId, patch);
    return updated ? { ok: true } : sendError(reply, 404, 'not_found', 'Такого человека нет.');
  });

  app.post('/api/admin/guests/remove', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не понял, кого убрать.');
    const ok = await guests.remove(parsed.data.chatId);
    return ok ? { ok: true } : sendError(reply, 404, 'not_found', 'Такого человека нет.');
  });
}
