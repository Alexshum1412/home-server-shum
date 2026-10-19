import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROGRAM_IDS } from '../../../shared/server-page.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import { type ServerPage, ServerPageError } from './server-page.ts';

const actionSchema = z
  .object({
    action: z.enum(['start', 'stop', 'restart', 'backup', 'recheck']),
    program: z.enum(PROGRAM_IDS as unknown as [string, ...string[]]).optional(),
    confirm: z.boolean().optional(),
    portalConfirmed: z.boolean().optional(),
  })
  // Nothing but these four fields: no program name of the browser's own, no command line, no path.
  .strict();

export function registerServerPageRoutes(
  app: FastifyInstance,
  deps: { page: ServerPage; guards: Guards; audit: AuditLog },
): void {
  const { page, guards, audit } = deps;

  app.get('/api/admin/server', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    return reply.header('cache-control', 'no-store').send(await page.view());
  });

  app.get('/api/admin/server/report', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = await page.report();
    await audit.write({
      action: 'diagnostics.export',
      actor: currentUser(request).username,
      ip: request.ip,
      detail: 'отчёт на странице «Сервер» (без секретов и имён)',
    });
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.post('/api/admin/server/action', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Действие указано неверно.');
    const user = currentUser(request);
    const { action, program } = parsed.data;
    const label = `${action}${program ? ` ${program}` : ''}`;
    try {
      const result = await page.act({
        action,
        program: program as (typeof PROGRAM_IDS)[number] | undefined,
        confirm: parsed.data.confirm,
        portalConfirmed: parsed.data.portalConfirmed,
      });
      // What was done and to which program; never anything the browser could have typed.
      await audit.write({
        action: 'server.action',
        actor: user.username,
        ip: request.ip,
        detail: `${label}: выполнено`,
      });
      return result;
    } catch (error) {
      if (error instanceof ServerPageError) {
        if (error.code !== 'confirm_required' && error.code !== 'portal_confirm_required') {
          await audit.write({
            action: 'server.action',
            actor: user.username,
            ip: request.ip,
            detail: `${label}: отказано (${error.code})`,
          });
        }
        return sendError(reply, error.status, error.code, error.message);
      }
      await audit.write({
        action: 'server.action',
        actor: user.username,
        ip: request.ip,
        detail: `${label}: не получилось`,
      });
      return sendError(reply, 502, 'action_failed', `Не получилось: ${(error as Error).message}`);
    }
  });
}
