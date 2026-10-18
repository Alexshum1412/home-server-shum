import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SEARCH_KINDS, type SearchKind } from '../../../shared/search.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import { MAX_LIMIT, QUERY_MAX, type UnifiedSearch } from './unified.ts';

const querySchema = z.object({
  q: z.string().max(400).default(''),
  kinds: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

/** One person may have this many searches running at once; the page cancels the older ones itself. */
const PER_PERSON = 3;

export function registerSearchRoutes(
  app: FastifyInstance,
  deps: { search: UnifiedSearch; guards: Guards },
): void {
  const running = new Map<string, number>();

  app.get('/api/search', { preHandler: deps.guards.requireUser }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Запрос поиска указан неверно.');
    const user = currentUser(request);
    const busy = running.get(user.id) ?? 0;
    if (busy >= PER_PERSON) {
      return sendError(reply, 429, 'busy', 'Поиск ещё идёт. Подождите секунду и повторите.');
    }
    const asked = (parsed.data.kinds ?? '')
      .split(',')
      .map((kind) => kind.trim())
      .filter((kind): kind is SearchKind => (SEARCH_KINDS as readonly string[]).includes(kind));
    running.set(user.id, busy + 1);
    try {
      const answer = await deps.search.search(user, parsed.data.q.trim().slice(0, QUERY_MAX), {
        ...(asked.length > 0 ? { kinds: asked } : {}),
        ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
      });
      return reply.header('cache-control', 'no-store').send(answer);
    } finally {
      const left = (running.get(user.id) ?? 1) - 1;
      if (left <= 0) running.delete(user.id);
      else running.set(user.id, left);
    }
  });
}
