import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import type { SessionStore } from '../auth/sessions.ts';
import { SESSION_COOKIE } from '../auth/sessions.ts';
import { sendError } from '../lib/http.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import type { NotificationCenter } from './center.ts';
import { isPushEndpointAllowed } from './webpush.ts';

export interface NotifyRouteDeps {
  guards: Guards;
  hub: RealtimeHub;
  center: NotificationCenter;
  sessions: SessionStore;
  audit: AuditLog;
}

const readBody = z.object({
  ids: z.union([z.literal('all'), z.array(z.string().max(64)).max(200)]),
});
const prefsBody = z.object({
  messages: z.boolean().optional(),
  calls: z.boolean().optional(),
  downloads: z.boolean().optional(),
  alerts: z.boolean().optional(),
  print: z.boolean().optional(),
  previews: z.boolean().optional(),
});
const subscribeBody = z.object({
  endpoint: z.string().max(2048),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  label: z.string().max(80).optional(),
});
const unsubscribeBody = z.object({ endpoint: z.string().max(2048) });

export function registerNotifyRoutes(app: FastifyInstance, deps: NotifyRouteDeps): void {
  const { guards, hub, center, sessions, audit } = deps;

  /** Live events for the open page. The connection ends by itself when the session ends. */
  app.get('/api/events', { preHandler: guards.requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const token = request.cookies[SESSION_COOKIE] ?? '';
    hub.attach(request, reply, user.id, () => sessions.lookup(token) !== undefined);
    return reply;
  });

  function fail(reply: FastifyReply, error: unknown) {
    const status = (error as { status?: number }).status;
    const code = (error as { code?: string }).code;
    if (status === 400 && code) return sendError(reply, 400, code, (error as Error).message);
    throw error;
  }

  app.get('/api/notifications', { preHandler: guards.requireUser }, async (request) => {
    return center.list(currentUser(request).id);
  });

  app.post('/api/notifications/read', { preHandler: guards.requireUser }, async (request, reply) => {
    const body = readBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request', 'Некорректный запрос.');
    center.markRead(currentUser(request).id, body.data.ids);
    return reply.code(204).send();
  });

  app.post('/api/notifications/prefs', { preHandler: guards.requireUser }, async (request, reply) => {
    const body = prefsBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request', 'Некорректный запрос.');
    return center.setPrefs(currentUser(request).id, body.data);
  });

  app.post('/api/notifications/subscribe', { preHandler: guards.requireUser }, async (request, reply) => {
    const body = subscribeBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request', 'Некорректная подписка.');
    const { endpoint, keys, label } = body.data;
    const publicKey = Buffer.from(keys.p256dh, 'base64url');
    const auth = Buffer.from(keys.auth, 'base64url');
    if (
      !isPushEndpointAllowed(endpoint) ||
      publicKey.length !== 65 ||
      publicKey[0] !== 4 ||
      auth.length !== 16
    ) {
      return sendError(reply, 400, 'bad_endpoint', 'Этот браузер не подходит для уведомлений от сервера.');
    }
    const user = currentUser(request);
    try {
      center.subscribe(user.id, { endpoint, keys, ...(label ? { label } : {}) });
    } catch (error) {
      return fail(reply, error);
    }
    await audit.write({ action: 'push.subscribe', actor: user.username, ip: request.ip, detail: null });
    return center.list(user.id);
  });

  app.post('/api/notifications/unsubscribe', { preHandler: guards.requireUser }, async (request, reply) => {
    const body = unsubscribeBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request', 'Некорректный запрос.');
    const user = currentUser(request);
    center.unsubscribe(user.id, body.data.endpoint);
    return center.list(user.id);
  });
}
