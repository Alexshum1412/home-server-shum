import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DigestResponse } from '../../../shared/extras.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import type { UserStore } from '../auth/users.ts';
import { sendError } from '../lib/http.ts';
import { type Digest, isChatId, isTime } from './digest.ts';
import { geocode } from './external.ts';

export function registerDigestRoutes(
  app: FastifyInstance,
  deps: { digest: Digest; users: Pick<UserStore, 'findByUsername'>; guards: Guards; audit: AuditLog },
): void {
  const { digest, users, guards, audit } = deps;

  async function response(username: string, isAdmin: boolean): Promise<DigestResponse> {
    return { ...(await digest.state(username)), isAdmin };
  }

  app.get('/api/digest', { preHandler: guards.requireUser }, async (request, reply) => {
    const me = currentUser(request);
    return reply.header('cache-control', 'no-store').send(await response(me.username, me.role === 'admin'));
  });

  app.post('/api/digest/mine', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = z
      .object({ enabled: z.boolean().optional(), telegramChatId: z.string().max(24).optional() })
      .strict()
      .safeParse(request.body);
    if (
      !parsed.success ||
      (parsed.data.telegramChatId !== undefined && !isChatId(parsed.data.telegramChatId.trim()))
    ) {
      return sendError(
        reply,
        400,
        'bad_request',
        'Номер чата Telegram — только цифры (можно со знаком минус).',
      );
    }
    const me = currentUser(request);
    await digest.setMine(me.username, {
      ...(parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled }),
      ...(parsed.data.telegramChatId === undefined
        ? {}
        : { telegramChatId: parsed.data.telegramChatId.trim() }),
    });
    return reply.header('cache-control', 'no-store').send(await response(me.username, me.role === 'admin'));
  });

  // «Сделать сейчас»: for oneself, with the quick model, at most once in five minutes.
  app.post('/api/digest/mine/now', { preHandler: guards.requireUser }, async (request, reply) => {
    const me = currentUser(request);
    const stored = await users.findByUsername(me.username);
    if (!stored) return sendError(reply, 404, 'not_found', 'Учётная запись не найдена.');
    const result = await digest.runNow(stored);
    if (result === 'too_soon') {
      return sendError(
        reply,
        429,
        'too_soon',
        'Дайджест уже делали меньше пяти минут назад. Подождите немного.',
      );
    }
    return reply.header('cache-control', 'no-store').send(await response(me.username, me.role === 'admin'));
  });

  app.post('/api/admin/digest/settings', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        time: z.string().max(5).optional(),
        city: z.string().max(80).optional(),
        currency: z.boolean().optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success || (parsed.data.time !== undefined && !isTime(parsed.data.time))) {
      return sendError(reply, 400, 'bad_request', 'Время — в виде 07:30.');
    }
    const patch: Parameters<Digest['setSettings']>[0] = {};
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.time !== undefined) patch.time = parsed.data.time;
    if (parsed.data.currency !== undefined) patch.currency = parsed.data.currency;
    if (parsed.data.city !== undefined) {
      const city = parsed.data.city.trim();
      if (city === '') {
        Object.assign(patch, { city: '', latitude: null, longitude: null });
      } else {
        const found = await geocode(city);
        if (!found)
          return sendError(
            reply,
            404,
            'city_not_found',
            'Такой город не нашёлся (или нет доступа к интернету).',
          );
        Object.assign(patch, { city: found.name, latitude: found.latitude, longitude: found.longitude });
      }
    }
    await digest.setSettings(patch);
    const me = currentUser(request);
    await audit.write({
      action: 'safety.change',
      actor: me.username,
      ip: request.ip,
      detail: 'настройки утреннего дайджеста',
    });
    return reply.header('cache-control', 'no-store').send(await response(me.username, true));
  });

  // «Разослать сейчас» for everybody who wants it (the bigger model writes; it takes minutes).
  app.post('/api/admin/digest/run', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const me = currentUser(request);
    void digest.runAll().catch(() => undefined);
    await audit.write({
      action: 'safety.change',
      actor: me.username,
      ip: request.ip,
      detail: 'утренний дайджест запущен вручную',
    });
    return reply.code(202).send({ started: true });
  });
}
