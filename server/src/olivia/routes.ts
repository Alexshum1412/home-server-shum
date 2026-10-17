import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OliviaActionResult, OliviaExplainResponse, OliviaResponse } from '../../../shared/api.ts';
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
import { explainFinding, LlmError, type LlmFetch } from './llm.ts';
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
  /** Tests replace the call to the local language model. */
  llmFetch?: LlmFetch;
}

/** One click per action and minute is plenty; a double click must not run it twice. */
const ACTION_GAP_MS = 30_000;
const confirmSchema = z.object({ confirm: z.literal(true) });
const explainSchema = z.object({ id: z.string().min(1).max(80) });
/** The model is slow on this PC: one explanation at a time, not more often than this. */
const EXPLAIN_GAP_MS = 10_000;

export function registerOliviaRoutes(app: FastifyInstance, deps: OliviaRouteDeps): void {
  const { config, guards, registry, collector, audit } = deps;
  const lastRun = new Map<string, number>();
  const actionDeps: ActionDeps = {
    dataDir: config.dataDir,
    supervisorPipe: pipeNameFor(config.dataDir),
    recheckServices: () => registry.checkAll(),
    ...deps.actionDeps,
  };

  let lastExplain = Number.NEGATIVE_INFINITY;
  let explaining = false;

  async function currentFindings() {
    const ctx = await context();
    return diagnose({
      system: ctx.system,
      services: registry.statuses(),
      audit: await audit.readLatest(500),
      now: deps.clock(),
      backupRunning: ctx.backupRunning,
    });
  }

  async function context() {
    return { system: collector.snapshot('admin'), backupRunning: await backupRunning(config.dataDir) };
  }

  app.get('/api/admin/olivia', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    if (!config.oliviaEnabled)
      return sendError(reply, 404, 'not_found', 'Оливия выключена (OLIVIA_ENABLED=0).');
    const ctx = await context();
    const body: OliviaResponse = {
      generatedAt: isoNow(deps.clock),
      findings: await currentFindings(),
      actions: actionViews(ctx),
      llm: { configured: config.oliviaLlm !== null },
    };
    return body;
  });

  app.post('/api/admin/olivia/explain', { preHandler: guards.requireAdmin }, async (request, reply) => {
    if (!config.oliviaEnabled)
      return sendError(reply, 404, 'not_found', 'Оливия выключена (OLIVIA_ENABLED=0).');
    const llm = config.oliviaLlm;
    if (!llm) {
      return sendError(
        reply,
        404,
        'not_configured',
        'Локальный ИИ не подключён. «Оливия» объясняет по готовым правилам и без него.',
      );
    }
    const parsed = explainSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не указано, что объяснять.');
    // The text comes from the rules' own finding, never from the request.
    const finding = (await currentFindings()).find((f) => f.id === parsed.data.id);
    if (!finding) return sendError(reply, 404, 'not_found', 'Такой находки сейчас нет.');
    const now = deps.clock().getTime();
    if (explaining || now - lastExplain < EXPLAIN_GAP_MS) {
      return sendError(reply, 429, 'too_many_requests', 'Подождите несколько секунд: ИИ занят.');
    }
    explaining = true;
    lastExplain = now;
    try {
      const text = await explainFinding(finding, llm, deps.llmFetch ?? fetch);
      await audit.write({
        action: 'olivia.action',
        actor: currentUser(request).username,
        ip: request.ip,
        detail: `пояснение ИИ: ${finding.id}`,
      });
      const body: OliviaExplainResponse = { findingId: finding.id, text };
      return body;
    } catch (error) {
      if (error instanceof LlmError) return sendError(reply, 502, 'llm_failed', error.message);
      throw error;
    } finally {
      explaining = false;
    }
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
