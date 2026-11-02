/**
 * The emergency card of the family: telephones, where the documents lie, what to take, how to find each other. One text
 * that the administrator writes (headings start with «# », the rest are lines) and everybody reads, also on a phone without
 * the internet (the page keeps its last copy) and on paper (the page prints cleanly). It lives in the data folder and so in
 * the backups.
 */
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guards } from '../auth/guards.ts';
import { currentUser } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';

export const EMERGENCY_TEMPLATE = `# Телефоны экстренных служб (Беларусь)
112 — единый номер спасения
101 — МЧС, пожарные и спасатели
102 — милиция
103 — скорая помощь
104 — аварийная газовая служба

# Наши телефоны
(впишите: имя — телефон; у кого какой оператор)

# Где мы встречаемся, если нет связи
(впишите: первое место, запасное место)

# Документы и где они лежат
(паспорта, свидетельства, страховки, договор на квартиру; у кого копии на сервере в «Файлах»)

# Здоровье
(группы крови, аллергии, постоянные лекарства, телефоны врачей)

# Тревожный набор
Вода и еда на три дня, лекарства, документы, деньги наличными, фонарь и батарейки, зарядки и внешний аккумулятор, тёплая одежда, радиоприёмник.

# Сервер и связь
Офлайн-библиотека (Википедия без интернета) и эта карточка открываются в домашней сети, пока работают сервер и роутер. Адрес сервера в домашней сети впишите сюда.
`;

interface Card {
  text: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function registerEmergencyRoutes(
  app: FastifyInstance,
  deps: { guards: Guards; dataDir: string; clock: Clock },
): void {
  const file = path.join(deps.dataDir, 'emergency.json');
  const load = async (): Promise<Card> => {
    try {
      const data = (await readJsonFile(file)) as Partial<Card> | undefined;
      if (data && typeof data.text === 'string')
        return { text: data.text, updatedAt: data.updatedAt ?? null, updatedBy: data.updatedBy ?? null };
    } catch {
      // a damaged file shows the template again
    }
    return { text: EMERGENCY_TEMPLATE, updatedAt: null, updatedBy: null };
  };

  app.get('/api/emergency', { preHandler: deps.guards.requireUser }, async (request, reply) => {
    return reply
      .header('cache-control', 'no-store')
      .send({ ...(await load()), canEdit: currentUser(request).role === 'admin' });
  });

  app.post('/api/emergency', { preHandler: deps.guards.requireAdmin }, async (request, reply) => {
    const parsed = z
      .object({ text: z.string().max(20_000) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Текст карточки слишком длинный.');
    const card: Card = {
      text: parsed.data.text,
      updatedAt: deps.clock().toISOString(),
      updatedBy: currentUser(request).displayName,
    };
    await writeJsonAtomic(file, { version: 1, ...card });
    return { ...card, canEdit: true };
  });
}
