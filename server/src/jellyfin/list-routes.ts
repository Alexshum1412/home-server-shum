/**
 * The cinema's personal lists over HTTP: the rows of the start page, the marks (heart, «later»,
 * «watched»), and the family's film suggestions.
 *
 * Marks and rows are always the signed-in person's own: there is no way to ask for somebody else's.
 * Suggestions are the family's shared list by design; only an administrator decides them.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  CatalogMarkState,
  CatalogShelvesResponse,
  CatalogSuggestion,
  CatalogSuggestionsResponse,
} from '../../../shared/api.ts';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { isDisabled, type UserStore } from '../auth/users.ts';
import { sendError } from '../lib/http.ts';
import type { NotificationCenter } from '../notify/center.ts';
import { type JellyfinClient, JellyfinError } from './client.ts';
import { MediaListError, type MediaLists, type StoredSuggestion, titleKey } from './lists.ts';
import type { ProgressStore } from './progress.ts';
import type { Shelves } from './shelves.ts';

export interface CatalogListRouteDeps {
  guards: Guards;
  client: JellyfinClient;
  lists: MediaLists;
  shelves: Shelves;
  progress: ProgressStore;
  users: UserStore;
  notify: NotificationCenter;
  audit: AuditLog;
}

const ID = z.string().regex(/^[0-9a-fA-F]{32}$/);
const markBody = z.object({
  id: ID,
  favourite: z.boolean().optional(),
  later: z.boolean().optional(),
  watched: z.boolean().optional(),
});
const suggestionBody = z.object({ title: z.string().max(1000), note: z.string().max(2000).optional() });
const suggestionParams = z.object({ id: z.string().regex(/^[0-9a-f-]{8,64}$/i) });
const decisionBody = z.object({ status: z.enum(['open', 'added', 'declined']) });

function view(entry: StoredSuggestion, viewerId: string): CatalogSuggestion {
  return {
    id: entry.id,
    title: entry.title,
    note: entry.note,
    byName: entry.byName,
    mine: entry.by === viewerId,
    at: entry.at,
    status: entry.status,
    decidedAt: entry.decidedAt,
  };
}

export function registerCatalogListRoutes(app: FastifyInstance, deps: CatalogListRouteDeps): void {
  const { guards, client, lists, shelves, progress, users, notify, audit } = deps;

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof MediaListError || error instanceof JellyfinError) {
      return sendError(reply, error.status, error.code, error.message);
    }
    throw error;
  }

  // --- the rows of the start page ------------------------------------------------------------
  app.get('/api/catalog/shelves', { preHandler: guards.requireUser }, async (request) => {
    const body: CatalogShelvesResponse = await shelves.build(currentUser(request).id);
    return body;
  });

  // --- marks ---------------------------------------------------------------------------------
  app.post('/api/catalog/marks', { preHandler: guards.requireUser }, async (request, reply) => {
    const body = markBody.safeParse(request.body);
    if (
      !body.success ||
      (body.data.favourite === undefined && body.data.later === undefined && body.data.watched === undefined)
    ) {
      return sendError(
        reply,
        400,
        'bad_request',
        'Не понятно, что отметить. Откройте фильм и нажмите кнопку ещё раз.',
      );
    }
    const me = currentUser(request);
    const id = body.data.id.toLowerCase();
    const turningOn = body.data.favourite === true || body.data.later === true || body.data.watched === true;
    try {
      // Only something that is in the library can be marked; taking a mark off needs no check.
      const entry = turningOn ? await shelves.describe(id) : null;
      if (turningOn && !entry) {
        return sendError(reply, 404, 'not_found', 'Такого фильма или файла в медиатеке нет.');
      }
      const parent = entry?.parentId ?? null;
      if (body.data.favourite !== undefined) await lists.setFavourite(me.id, id, body.data.favourite, parent);
      if (body.data.later !== undefined) await lists.setLater(me.id, id, body.data.later);
      if (body.data.watched !== undefined) {
        await lists.setWatched(me.id, id, body.data.watched, parent);
        // A finished item is no longer «continue watching».
        if (body.data.watched) progress.clear(me.id, id);
      }
      const state: CatalogMarkState = lists.state(me.id, id);
      return state;
    } catch (error) {
      return fail(reply, error);
    }
  });

  // --- suggestions ---------------------------------------------------------------------------
  app.get('/api/catalog/suggestions', { preHandler: guards.requireUser }, async (request) => {
    const me = currentUser(request);
    const body: CatalogSuggestionsResponse = {
      suggestions: lists.suggestions().map((entry) => view(entry, me.id)),
      canModerate: me.role === 'admin',
    };
    return body;
  });

  app.post('/api/catalog/suggestions', { preHandler: guards.requireUser }, async (request, reply) => {
    const body = suggestionBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_title', 'Напишите название фильма или сериала.');
    const me = currentUser(request);
    try {
      // A title that is already in the library needs no suggestion (best effort: Jellyfin may be down).
      const key = titleKey(body.data.title);
      if (key !== '') {
        const present = await client
          .scan()
          .then((library) => library.find((entry) => titleKey(entry.title) === key))
          .catch(() => undefined);
        if (present) {
          return sendError(
            reply,
            409,
            'in_library',
            `«${present.title}» уже есть в медиатеке. Найдите это через поиск на странице кинотеатра.`,
          );
        }
      }
      const created = await lists.addSuggestion(
        { id: me.id, displayName: me.displayName },
        body.data.title,
        body.data.note ?? '',
      );
      // Administrators hear about it (not the author): the feed, and the phone when it is allowed.
      const admins = (await users.list()).filter(
        (user) => user.role === 'admin' && !isDisabled(user) && user.id !== me.id,
      );
      if (admins.length > 0) {
        void notify
          .notify({
            users: admins.map((admin) => admin.id),
            kind: 'system',
            title: 'Предложен фильм',
            body: `„${created.title}“ — предлагает ${me.displayName}`.slice(0, 200),
            url: '/cinema?suggest=1',
            key: `film-suggestion:${created.id}`,
            topic: `film-${created.id}`,
          })
          .catch(() => undefined);
      }
      return reply.code(201).send(view(created, me.id));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(
    '/api/catalog/suggestions/:id/withdraw',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const params = suggestionParams.safeParse(request.params);
      if (!params.success) return sendError(reply, 404, 'not_found', 'Такого предложения нет.');
      try {
        await lists.withdrawSuggestion(currentUser(request).id, params.data.id);
        return reply.code(204).send();
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // Administrative: closed on the public way (see lib/channel.ts), because it lives under /api/admin.
  app.post(
    '/api/admin/catalog/suggestions/:id',
    { preHandler: guards.requireAdmin },
    async (request, reply) => {
      const params = suggestionParams.safeParse(request.params);
      const body = decisionBody.safeParse(request.body);
      if (!params.success) return sendError(reply, 404, 'not_found', 'Такого предложения нет.');
      if (!body.success) return sendError(reply, 400, 'bad_request', 'Выберите «добавлено» или «отклонено».');
      const me = currentUser(request);
      try {
        const decided = await lists.decideSuggestion(params.data.id, body.data.status);
        await audit.write({
          action: 'catalog.suggestion',
          actor: me.username,
          ip: request.ip,
          detail: `Предложение фильма: ${body.data.status === 'added' ? 'добавлено' : body.data.status === 'declined' ? 'отклонено' : 'возвращено на рассмотрение'}`,
        });
        return view(decided, me.id);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
