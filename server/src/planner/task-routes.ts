import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  ClearDoneResponse,
  CreateManyTasksResponse,
  DeleteTaskListResponse,
  TaskListView,
  TaskPerson,
  TasksResponse,
} from '../../../shared/api.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { isDisabled, type UserStore } from '../auth/users.ts';
import { sendError } from '../lib/http.ts';
import { isRealDate } from './dates.ts';
import {
  checkListInput,
  checkManyTitles,
  checkTaskInput,
  TaskError,
  type TaskStore,
} from './tasks.ts';

export interface TaskRouteDeps {
  tasks: TaskStore;
  users: Pick<UserStore, 'list' | 'findByUsername'>;
  guards: Guards;
  audit: AuditLog;
}

const idSchema = z.object({ id: z.string().regex(/^[0-9a-f-]{8,64}$/i) });

/** The shape of a request; the combination of fields is checked with plain words by checkTaskInput. */
const taskBody = z.object({
  title: z.string().max(1000).default(''),
  note: z.string().max(5000).default(''),
  due: z.string().max(10).nullable().default(null),
  dueTime: z.string().max(5).nullable().default(null),
  repeat: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).default('none'),
  assignee: z.string().max(40).nullable().default(null),
  remindBefore: z.number().finite().nullable().default(null),
  private: z.boolean().default(false),
  listId: z.string().max(64).nullable().default(null),
});
const manyBody = z.object({
  listId: z.string().max(64),
  titles: z.array(z.string().max(1000)).max(200),
});
const doneBody = z.object({ done: z.boolean(), occurrence: z.string().max(10).nullable().optional() });
const listBody = z.object({
  name: z.string().max(500).default(''),
  kind: z.enum(['todo', 'shopping']).default('todo'),
  private: z.boolean().default(false),
});
const renameBody = z.object({ name: z.string().max(500).default('') });
const todayQuery = z.object({ until: z.string().max(10).optional() });

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  const { tasks, users, guards, audit } = deps;

  function writer(request: FastifyRequest) {
    const user = currentUser(request);
    return { username: user.username, displayName: user.displayName, isAdmin: user.role === 'admin' };
  }

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof TaskError) return sendError(reply, error.status, error.code, error.message);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      return sendError(reply, 409, 'busy', 'Файл занят другой программой или нет доступа. Попробуйте позже.');
    }
    throw error;
  }

  /** What changed, never what it says: titles of tasks stay out of the journal. */
  async function log(request: FastifyRequest, detail: string) {
    await audit.write({
      action: 'planner.change',
      actor: currentUser(request).username,
      ip: request.ip,
      detail,
    });
  }

  /** A task may be given to a family member whose account is on; returns the name to show. */
  async function assigneeName(assignee: string | null): Promise<string | null> {
    if (assignee === null) return null;
    const user = await users.findByUsername(assignee);
    if (!user || isDisabled(user)) {
      throw new TaskError(400, 'bad_assignee', 'Такого человека в семье нет. Выберите из списка.');
    }
    return user.displayName;
  }

  const badTask = (reply: FastifyReply) =>
    sendError(reply, 400, 'bad_task', 'Проверьте заполнение: напишите, что нужно сделать.');
  const noTask = (reply: FastifyReply) => sendError(reply, 404, 'not_found', 'Такого дела нет.');
  const noList = (reply: FastifyReply) => sendError(reply, 404, 'not_found', 'Такого списка нет.');

  // --- tasks ----------------------------------------------------------------------------------
  /**
   * Everything the person may see. `?until=YYYY-MM-DD` gives only the open tasks due on that day or
   * earlier (the home page), so a long shopping list is not loaded for a glance at today.
   */
  app.get('/api/tasks', { preHandler: guards.requireUser }, async (request, reply) => {
    const query = todayQuery.safeParse(request.query);
    if (!query.success || (query.data.until !== undefined && !isRealDate(query.data.until))) {
      return sendError(reply, 400, 'bad_request', 'Укажите день в виде ГГГГ-ММ-ДД.');
    }
    try {
      const all = await tasks.list(writer(request));
      const until = query.data.until;
      const people: TaskPerson[] = (await users.list())
        .filter((user) => !isDisabled(user))
        .map((user) => ({ username: user.username, displayName: user.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
      const body: TasksResponse = {
        tasks:
          until === undefined
            ? all.tasks
            : all.tasks.filter((task) => !task.done && task.due !== null && task.due <= until),
        lists: all.lists,
        people,
      };
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/tasks', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = taskBody.safeParse(request.body);
    if (!parsed.success) return badTask(reply);
    try {
      const input = checkTaskInput(parsed.data);
      const created = await tasks.create(writer(request), input, await assigneeName(input.assignee));
      await log(request, `Дела: дело добавлено (${created.private ? 'личное' : 'общее'})`);
      return reply.code(201).send(created);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/tasks/many', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = manyBody.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_task', 'Напишите, что нужно добавить.');
    try {
      const titles = checkManyTitles(parsed.data.titles);
      const made = await tasks.createMany(writer(request), parsed.data.listId, titles);
      await log(request, `Дела: добавлено пунктов в список — ${made.length}`);
      const body: CreateManyTasksResponse = { tasks: made };
      return reply.code(201).send(body);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/tasks/:id/update', { preHandler: guards.requireUser }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return noTask(reply);
    const parsed = taskBody.safeParse(request.body);
    if (!parsed.success) return badTask(reply);
    try {
      const input = checkTaskInput(parsed.data);
      const updated = await tasks.update(
        writer(request),
        params.data.id,
        input,
        await assigneeName(input.assignee),
      );
      await log(request, `Дела: дело изменено (${updated.private ? 'личное' : 'общее'})`);
      return updated;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/tasks/:id/done', { preHandler: guards.requireUser }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return noTask(reply);
    const parsed = doneBody.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Укажите, сделано ли дело.');
    try {
      const updated = await tasks.setDone(
        writer(request),
        params.data.id,
        parsed.data.done,
        parsed.data.occurrence,
      );
      return updated;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/tasks/:id/delete', { preHandler: guards.requireUser }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return noTask(reply);
    try {
      await tasks.remove(writer(request), params.data.id);
      await log(request, 'Дела: дело удалено');
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** «Убрать выполненное» among the tasks that are in no list. */
  app.post('/api/tasks/clear-done', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const result: ClearDoneResponse = await tasks.clearDone(writer(request), null);
      if (result.removed > 0) await log(request, `Дела: убрано выполненных — ${result.removed}`);
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  // --- lists ----------------------------------------------------------------------------------
  app.post('/api/tasks/lists', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = listBody.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_list', 'Дайте списку название.');
    try {
      const created: TaskListView = await tasks.createList(writer(request), checkListInput(parsed.data));
      await log(request, `Дела: список создан (${created.private ? 'личный' : 'общий'})`);
      return reply.code(201).send(created);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/tasks/lists/:id/rename', { preHandler: guards.requireUser }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return noList(reply);
    const parsed = renameBody.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_list', 'Дайте списку название.');
    try {
      const renamed = await tasks.renameList(writer(request), params.data.id, parsed.data.name);
      await log(request, 'Дела: список переименован');
      return renamed;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/tasks/lists/:id/delete', { preHandler: guards.requireUser }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return noList(reply);
    try {
      const result: DeleteTaskListResponse = await tasks.removeList(writer(request), params.data.id);
      await log(request, `Дела: список удалён вместе с пунктами (${result.removedTasks})`);
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/tasks/lists/:id/clear-done', { preHandler: guards.requireUser }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return noList(reply);
    try {
      const result: ClearDoneResponse = await tasks.clearDone(writer(request), params.data.id);
      if (result.removed > 0) await log(request, `Дела: убрано купленного и выполненного — ${result.removed}`);
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });
}
