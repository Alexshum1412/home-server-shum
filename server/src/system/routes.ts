import type { FastifyInstance } from 'fastify';
import type { SystemResponse } from '../../../shared/api.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import type { SystemCollector } from './collector.ts';

export function registerSystemRoutes(
  app: FastifyInstance,
  deps: { collector: SystemCollector; guards: Guards },
): void {
  app.get('/api/system', { preHandler: deps.guards.requireUser }, async (request) => {
    const body: SystemResponse = deps.collector.snapshot(currentUser(request).role);
    return body;
  });
}
