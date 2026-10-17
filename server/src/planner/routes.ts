import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  CalendarResponse,
  NoteResponse,
  NotesResponse,
  SaveNoteRequest,
  SaveNoteResponse,
} from '../../../shared/api.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { StorageError } from '../files/storage.ts';
import { sendError } from '../lib/http.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import { CalendarError, type CalendarStore, checkInput, eventInputSchema } from './calendar.ts';
import { toIcs } from './ics.ts';
import { NoteError, type Notes } from './notes.ts';

export interface PlannerRouteDeps {
  calendar: CalendarStore;
  notes: Notes;
  guards: Guards;
  audit: AuditLog;
  clock: Clock;
}

const rangeSchema = z.object({ from: z.string(), to: z.string() });
const idSchema = z.object({ id: z.string().regex(/^[0-9a-f-]{8,64}$/i) });
const spaceSchema = z.enum(['personal', 'shared']);
const saveSchema = z.object({
  space: spaceSchema,
  name: z.string().max(300),
  text: z.string().max(400 * 1024),
  revision: z.string().max(80).nullable(),
});
const nameQuery = z.object({ space: spaceSchema, name: z.string().max(300) });

export function registerPlannerRoutes(app: FastifyInstance, deps: PlannerRouteDeps): void {
  const { calendar, notes, guards, audit } = deps;

  function viewer(request: FastifyRequest) {
    const user = currentUser(request);
    return { username: user.username, displayName: user.displayName, isAdmin: user.role === 'admin' };
  }

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof CalendarError || error instanceof NoteError || error instanceof StorageError) {
      return sendError(reply, error.status, error.code, error.message);
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return sendError(reply, 404, 'not_found', 'Такой заметки нет.');
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      return sendError(reply, 409, 'busy', 'Файл занят другой программой или нет доступа. Попробуйте позже.');
    }
    throw error;
  }

  /** What changed, never what it says: titles and texts of private entries stay out of the journal. */
  async function log(request: FastifyRequest, detail: string) {
    await audit.write({
      action: 'planner.change',
      actor: currentUser(request).username,
      ip: request.ip,
      detail,
    });
  }

  // --- calendar -----------------------------------------------------------------------------
  app.get('/api/calendar', { preHandler: guards.requireUser }, async (request, reply) => {
    const query = rangeSchema.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, 'bad_range', 'Укажите период: from и to.');
    try {
      const result = await calendar.occurrences(viewer(request), query.data.from, query.data.to);
      const body: CalendarResponse = {
        from: query.data.from,
        to: query.data.to,
        occurrences: result.occurrences,
        truncated: result.truncated,
      };
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/calendar', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = eventInputSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_event', 'Укажите название и дату события.');
    try {
      const created = await calendar.create(viewer(request), checkInput(parsed.data));
      await log(request, `Календарь: событие добавлено (${created.private ? 'личное' : 'общее'})`);
      return reply.code(201).send(created);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/calendar/:id/update', { preHandler: guards.requireUser }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    const parsed = eventInputSchema.safeParse(request.body);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Такого события нет.');
    if (!parsed.success) return sendError(reply, 400, 'bad_event', 'Укажите название и дату события.');
    try {
      const updated = await calendar.update(viewer(request), params.data.id, checkInput(parsed.data));
      await log(request, `Календарь: событие изменено (${updated.private ? 'личное' : 'общее'})`);
      return updated;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/calendar/:id/delete', { preHandler: guards.requireUser }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Такого события нет.');
    try {
      await calendar.remove(viewer(request), params.data.id);
      await log(request, 'Календарь: событие удалено');
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** The whole calendar of this person as a file for a phone or computer calendar (or for printing). */
  app.get('/api/calendar/export.ics', { preHandler: guards.requireUser }, async (request, reply) => {
    try {
      const events = await calendar.visibleEvents(viewer(request));
      const stamp = isoNow(deps.clock).slice(0, 10);
      reply.header('Content-Type', 'text/calendar; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="family-calendar-${stamp}.ics"`);
      reply.header('Cache-Control', 'private, no-store');
      return toIcs(events);
    } catch (error) {
      return fail(reply, error);
    }
  });

  // --- notes --------------------------------------------------------------------------------
  app.get('/api/notes', { preHandler: guards.requireUser }, async (request, reply) => {
    const space = spaceSchema.safeParse((request.query as { space?: string }).space ?? 'personal');
    if (!space.success) return sendError(reply, 400, 'bad_request', 'Укажите, чьи заметки.');
    try {
      const body: NotesResponse = {
        space: space.data,
        notes: await notes.list(space.data, currentUser(request).username),
      };
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/notes/read', { preHandler: guards.requireUser }, async (request, reply) => {
    const query = nameQuery.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, 'bad_request', 'Укажите заметку.');
    try {
      const body: NoteResponse = await notes.read(
        query.data.space,
        currentUser(request).username,
        query.data.name,
      );
      return body;
    } catch (error) {
      return fail(reply, error);
    }
  });

  // A note may be up to 200 KB of text (JSON-escaped and in UTF-8 more): the general 64 KB limit is too small here.
  app.post(
    '/api/notes/save',
    { preHandler: guards.requireUser, bodyLimit: 600 * 1024 },
    async (request, reply) => {
      const parsed = saveSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Укажите название и текст заметки.');
      const body: SaveNoteRequest = parsed.data;
      try {
        const saved: SaveNoteResponse = await notes.save(
          body.space,
          currentUser(request).username,
          body.name,
          body.text,
          body.revision,
        );
        await log(
          request,
          `Заметки (${body.space === 'shared' ? 'общие' : 'личные'}): ${body.revision === null ? 'создана' : 'сохранена'}`,
        );
        return saved;
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post('/api/notes/delete', { preHandler: guards.requireUser }, async (request, reply) => {
    const parsed = nameQuery.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Укажите заметку.');
    try {
      await notes.remove(parsed.data.space, currentUser(request).username, parsed.data.name);
      await log(
        request,
        `Заметки (${parsed.data.space === 'shared' ? 'общие' : 'личные'}): перемещена в корзину`,
      );
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });
}
