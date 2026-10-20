import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FEATURES, type FeaturesResponse } from '../../../shared/features.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import type { FeatureStore } from './features.ts';

export function registerFeatureRoutes(
  app: FastifyInstance,
  deps: { features: FeatureStore; guards: Guards; audit: AuditLog },
): void {
  const { features, guards, audit } = deps;

  const view = (): FeaturesResponse => {
    const states = features.states();
    return {
      features: FEATURES.map(({ id, title, lead }) => ({ id, title, lead, enabled: states[id] === true })),
      states,
    };
  };

  // Everyone who is signed in learns what is on (to hide the pages that are off).
  app.get('/api/features', { preHandler: guards.requireUser }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(view()),
  );

  app.post('/api/admin/features', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = z
      .object({ id: z.string().max(40), enabled: z.boolean() })
      .strict()
      .safeParse(request.body);
    if (!parsed.success || !FEATURES.some((feature) => feature.id === parsed.data.id)) {
      return sendError(reply, 400, 'bad_request', 'Не указано, какую функцию и как переключить.');
    }
    await features.set(parsed.data.id, parsed.data.enabled);
    await audit.write({
      action: 'features.change',
      actor: currentUser(request).username,
      ip: request.ip,
      detail: `${parsed.data.id}: ${parsed.data.enabled ? 'включена' : 'выключена'}`,
    });
    return reply.header('cache-control', 'no-store').send(view());
  });
}
