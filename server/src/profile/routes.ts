import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INTERESTS, type ProfileResponse, type TelegramLinkResponse } from '../../../shared/profile.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { geocode } from '../digest/external.ts';
import { sendError } from '../lib/http.ts';
import type { TelegramBot } from '../telegram/bot.ts';
import type { ProfileStore } from './profiles.ts';

export function registerProfileRoutes(
  app: FastifyInstance,
  deps: { profiles: ProfileStore; guards: Guards; bot: () => TelegramBot | undefined },
): void {
  const { profiles, guards } = deps;
  const response = async (username: string): Promise<ProfileResponse> => ({
    profile: await profiles.view(username),
    interests: INTERESTS,
    bot: deps.bot()?.name() ?? null,
  });

  app.get('/api/profile', { preHandler: guards.requireUser }, async (request, reply) =>
    reply.header('cache-control', 'no-store').send(await response(currentUser(request).username)),
  );

  app.post('/api/profile', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = z
      .object({
        city: z.string().max(80).optional(),
        telegramUsername: z.string().max(60).optional(),
        telegramNotify: z.boolean().optional(),
        interests: z.array(z.string().max(30)).max(20).optional(),
        about: z.string().max(300).optional(),
        onboarded: z.boolean().optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success)
      return sendError(reply, 400, 'bad_request', 'Проверьте поля: что-то заполнено неверно.');
    const me = currentUser(request);
    let place: { latitude: number; longitude: number; name: string } | null | undefined;
    if (parsed.data.city !== undefined) {
      const city = parsed.data.city.trim();
      if (city === '') place = null;
      else {
        place = await geocode(city);
        if (!place)
          return sendError(
            reply,
            404,
            'city_not_found',
            'Такой город не нашёлся (или нет доступа к интернету). Проверьте написание.',
          );
      }
    }
    await profiles.update(me.username, parsed.data, place);
    return reply.header('cache-control', 'no-store').send(await response(me.username));
  });

  app.post('/api/profile/telegram-link', { preHandler: guards.requireUser }, async (request, reply) => {
    const bot = deps.bot();
    const made = bot?.createLinkCode(currentUser(request).username);
    if (!made)
      return sendError(reply, 503, 'bot_off', 'Telegram-бот сейчас не подключён. Скажите администратору.');
    const body: TelegramLinkResponse = made;
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.post('/api/profile/telegram-unlink', { preHandler: guards.requireUser }, async (request, reply) => {
    const me = currentUser(request);
    await profiles.setTelegramChat(me.username, '');
    return reply.header('cache-control', 'no-store').send(await response(me.username));
  });
}
