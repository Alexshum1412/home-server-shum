import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FamilyStatusResponse, SafetyResponse } from '../../../shared/extras.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import type { Decoys } from './decoys.ts';
import type { NetworkWatcher } from './network.ts';

export function registerSafetyRoutes(
  app: FastifyInstance,
  deps: {
    guards: Guards;
    audit: AuditLog;
    decoys: Decoys;
    network: NetworkWatcher;
    safety: () => Promise<SafetyResponse>;
    status: () => Promise<FamilyStatusResponse>;
  },
): void {
  const { guards, audit, decoys, network } = deps;
  const log = (request: Parameters<typeof currentUser>[0], detail: string) =>
    audit.write({ action: 'safety.change', actor: currentUser(request).username, ip: request.ip, detail });

  // «Что с сервером»: for the whole family, a few plain lines.
  app.get('/api/status', { preHandler: guards.requireUser }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(await deps.status()),
  );

  app.get('/api/admin/safety', { preHandler: guards.requireAdmin }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(await deps.safety()),
  );

  app.post('/api/admin/safety/decoys', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = z
      .object({ action: z.enum(['install', 'remove']) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не указано действие.');
    const count = parsed.data.action === 'install' ? await decoys.install() : await decoys.remove();
    await log(
      request,
      parsed.data.action === 'install' ? `приманки: создано ${count}` : `приманки: убрано ${count}`,
    );
    return reply.header('cache-control', 'no-store').send(await deps.safety());
  });

  app.post('/api/admin/safety/devices/scan', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = z
      .object({ active: z.boolean().default(false) })
      .strict()
      .safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Неверный запрос.');
    await network.scan(parsed.data.active);
    await log(request, parsed.data.active ? 'опрос домашней сети' : 'обновление списка устройств');
    return reply.header('cache-control', 'no-store').send(await deps.safety());
  });

  app.post('/api/admin/safety/devices/name', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = z
      .object({
        mac: z.string().regex(/^[0-9a-f]{2}(-[0-9a-f]{2}){5}$/),
        name: z.string().max(60),
        known: z.boolean(),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Неверное устройство.');
    if (!(await network.name(parsed.data.mac, parsed.data.name.trim(), parsed.data.known))) {
      return sendError(reply, 404, 'not_found', 'Такого устройства нет в списке.');
    }
    await log(request, 'устройство в сети подписано');
    return reply.header('cache-control', 'no-store').send(await deps.safety());
  });
}
