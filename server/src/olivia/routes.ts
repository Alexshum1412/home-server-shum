import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OliviaActionResult, OliviaResponse } from '../../../shared/api.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { backupRunning } from '../backup/lock.ts';
import type { Config } from '../config.ts';
import { sendError } from '../lib/http.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import type { ServiceRegistry } from '../services/checker.ts';
import { pipeNameFor } from '../supervisor/main.ts';
import type { SystemCollector } from '../system/collector.ts';
import { type ActionDeps, actionViews, isOliviaAction, OLIVIA_ACTIONS } from './actions.ts';
import { diagnose } from './rules.ts';

export interface OliviaRouteDeps {
  config: Config;
  clock: Clock;
  guards: Guards;
  audit: AuditLog;
  registry: ServiceRegistry;
  collector: SystemCollector;
  /** Tests replace the supervisor and the backup process. */
  actionDeps?: Partial<ActionDeps>;
}

/** One click per action and minute is plenty; a double click must not run it twice. */
const ACTION_GAP_MS = 30_000;
const confirmSchema = z.object({ confirm: z.literal(true) });

export function registerOliviaRoutes(app: FastifyInstance, deps: OliviaRouteDeps): void {
  const { config, guards, registry, collector, audit } = deps;
  const lastRun = new Map<string, number>();
  const actionDeps: ActionDeps = {
    dataDir: config.dataDir,
    supervisorPipe: pipeNameFor(config.dataDir),
    recheckServices: () => registry.checkAll(),
    ...deps.actionDeps,
  };

  async function context() {
    return { system: collector.snapshot('admin'), backupRunning: await backupRunning(config.dataDir) };
  }

  app.get('/api/admin/olivia', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    if (!config.oliviaEnabled)
      return sendError(reply, 404, 'not_found', 'Оливия выключена (OLIVIA_ENABLED=0).');
    const ctx = await context();
    const body: OliviaResponse = {
      generatedAt: isoNow(deps.clock),
      findings: diagnose({
        system: ctx.system,
        services: registry.statuses(),
        audit: await audit.readLatest(500),
        now: deps.clock(),
        backupRunning: ctx.backupRunning,
      }),
      actions: actionViews(ctx),
    };
    return body;
  });

  app.post('/api/admin/olivia/actions/:id', { preHandler: guards.requireAdmin }, async (request, reply) => {
    if (!config.oliviaEnabled)
      return sendError(reply, 404, 'not_found', 'Оливия выключена (OLIVIA_ENABLED=0).');
    const { id } = request.params as { id: string };
    if (!isOliviaAction(id)) return sendError(reply, 404, 'not_found', 'Такого действия нет.');
    if (!confirmSchema.safeParse(request.body).success) {
      return sendError(reply, 400, 'confirm_required', 'Действие нужно подтвердить.');
    }
    const user = currentUser(request);
    const now = deps.clock().getTime();
    const last = lastRun.get(id) ?? Number.NEGATIVE_INFINITY;
    if (now - last < ACTION_GAP_MS) {
      return sendError(
        reply,
        429,
        'too_many_requests',
        'Это действие только что выполнялось. Подождите полминуты.',
      );
    }
    const def = OLIVIA_ACTIONS[id];
    const blocked = def.blockedBecause(await context());
    if (blocked) {
      await audit.write({
        action: 'olivia.action',
        actor: user.username,
        ip: request.ip,
        detail: `${id}: отказано — ${blocked}`,
      });
      return sendError(reply, 409, 'not_applicable', `Сейчас это действие не нужно: ${blocked}.`);
    }
    lastRun.set(id, now);
    let result: OliviaActionResult;
    try {
      result = { ok: true, message: await def.run(actionDeps) };
    } catch (error) {
      result = { ok: false, message: `Не получилось: ${(error as Error).message}` };
    }
    await audit.write({
      action: 'olivia.action',
      actor: user.username,
      ip: request.ip,
      detail: `${id}: ${result.message}`,
    });
    return result;
  });
}
