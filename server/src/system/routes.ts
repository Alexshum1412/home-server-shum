import type { FastifyInstance } from 'fastify';
import type { MetricsHistoryResponse, SystemResponse } from '../../../shared/api.ts';
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

  // The day's readings are the administrator's: they show when the family is at home.
  app.get('/api/system/history', { preHandler: deps.guards.requireAdmin }, async () => {
    const body: MetricsHistoryResponse = deps.collector.history();
    return body;
  });
}
