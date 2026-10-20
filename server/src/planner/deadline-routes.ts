import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { DeadlinesResponse } from '../../../shared/extras.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { isDisabled, type StoredUser } from '../auth/users.ts';
import { sendError } from '../lib/http.ts';
import type { NotificationCenter } from '../notify/center.ts';
import { checkDeadline, DeadlineError, type DeadlineStore, deadlineBody } from './deadlines.ts';

const idSchema = z.object({ id: z.string().regex(/^[0-9a-f-]{8,64}$/i) });

export function registerDeadlineRoutes(
  app: FastifyInstance,
  deps: { deadlines: DeadlineStore; guards: Guards; audit: AuditLog },
): void {
  const { deadlines, guards, audit } = deps;
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof DeadlineError) return sendError(reply, error.status, error.code, error.message);
    throw error;
  };
  const writer = (request: Parameters<typeof currentUser>[0]) => {
    const user = currentUser(request);
    return { username: user.username, displayName: user.displayName, isAdmin: user.role === 'admin' };
  };
  const log = (request: Parameters<typeof currentUser>[0], detail: string) =>
    audit.write({ action: 'planner.change', actor: currentUser(request).username, ip: request.ip, detail });

  app.get('/api/deadlines', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const body: DeadlinesResponse = { deadlines: await deadlines.list(currentUser(request).username) };
      return reply.header('cache-control', 'no-store').send(body);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/deadlines', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = deadlineBody.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Не хватает названия или даты.');
    try {
      const created = await deadlines.create(writer(request), checkDeadline(parsed.data));
      await log(request, 'срок добавлен');
      return reply.code(201).send(created);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put('/api/deadlines/:id', { preHandler: guards.requireUser }, async (request, reply) => {
    const id = idSchema.safeParse(request.params);
    const parsed = deadlineBody.safeParse(request.body);
    if (!id.success || !parsed.success)
      return sendError(reply, 400, 'bad_request', 'Не хватает названия или даты.');
    try {
      const updated = await deadlines.update(writer(request), id.data.id, checkDeadline(parsed.data));
      await log(request, 'срок изменён');
      return updated;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/deadlines/:id', { preHandler: guards.requireUser }, async (request, reply) => {
    const id = idSchema.safeParse(request.params);
    if (!id.success) return sendError(reply, 400, 'bad_request', 'Не указан срок.');
    try {
      await deadlines.remove(writer(request), id.data.id);
      await log(request, 'срок удалён');
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });
}

const dayWords = (n: number) =>
  n < 0
    ? `просрочено на ${-n} дн.`
    : n === 0
      ? 'заканчивается сегодня'
      : n === 1
        ? 'заканчивается завтра'
        : `заканчивается через ${n} дн.`;

/** Once an hour: tells the person (everyone, for a family-wide deadline) that a deadline is near. */
export function createDeadlineWatcher(options: {
  deadlines: DeadlineStore;
  listUsers: () => Promise<StoredUser[]>;
  notify: NotificationCenter['notify'];
}) {
  return {
    async tick(): Promise<number> {
      const jobs = await options.deadlines.dueReminders();
      if (jobs.length === 0) return 0;
      const users = (await options.listUsers()).filter((user) => !isDisabled(user));
      const idOf = new Map(users.map((user) => [user.username, user.id]));
      for (const job of jobs) {
        const owner = idOf.get(job.owner);
        const to = job.shared ? users.map((user) => user.id) : owner ? [owner] : [];
        if (to.length === 0) continue;
        await options.notify({
          users: to,
          kind: 'reminder',
          title: `Срок: ${job.title}`,
          body: dayWords(job.daysLeft),
          url: '/deadlines',
          key: `deadline:${job.id}:${job.daysLeft}`,
        });
      }
      return jobs.length;
    },
  };
}
