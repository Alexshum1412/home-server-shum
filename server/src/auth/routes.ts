import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionResponse, SetupStateResponse } from '../../../shared/api.ts';
import type { AuditLog } from '../audit/log.ts';
import type { Config } from '../config.ts';
import { sendError } from '../lib/http.ts';
import { type Clock, ceilMinutes, isoNow } from '../lib/time.ts';
import { clearSessionCookie, currentUser, type Guards, setSessionCookie } from './guards.ts';
import { dummyVerify, PASSWORD_MAX_LENGTH, verifyPassword } from './passwords.ts';
import type { LoginLimiter } from './rate-limit.ts';
import { SESSION_COOKIE, type SessionStore } from './sessions.ts';
import { normaliseUsername, toSessionUser, USERNAME_RE, type UserStore } from './users.ts';

export const CREATE_ADMIN_COMMAND = 'npm.cmd run user -- add <логин> --name "<Имя>" --role admin';
export const INVALID_CREDENTIALS_MESSAGE = 'Неверное имя пользователя или пароль';

export interface AuthRouteDeps {
  config: Config;
  clock: Clock;
  users: UserStore;
  sessions: SessionStore;
  audit: AuditLog;
  limiter: LoginLimiter;
  guards: Guards;
}

const loginSchema = z.object({
  username: z.string().max(64),
  password: z.string().max(PASSWORD_MAX_LENGTH),
});

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { config, users, sessions, audit, limiter, guards } = deps;

  app.post('/api/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.username.trim() === '' || parsed.data.password === '') {
      return sendError(reply, 400, 'bad_request', 'Введите имя пользователя и пароль.');
    }
    const username = normaliseUsername(parsed.data.username);
    const { password } = parsed.data;
    const ip = request.ip;
    // Only a well-formed login name goes to the audit log (never free text that could be a password).
    const actor = USERNAME_RE.test(username) ? username : null;

    const byIp = limiter.byIp.check(ip);
    const byUser = limiter.byUser.check(username);
    if (!byIp.allowed || !byUser.allowed) {
      const retryAfterSec = Math.max(byIp.retryAfterSec, byUser.retryAfterSec);
      await audit.write({
        action: 'login.blocked',
        actor,
        ip,
        detail: byIp.allowed
          ? 'слишком много попыток для этого логина'
          : 'слишком много попыток с этого адреса',
      });
      reply.header('Retry-After', String(retryAfterSec));
      return sendError(
        reply,
        429,
        'too_many_attempts',
        `Слишком много неудачных попыток входа. Попробуйте снова через ${ceilMinutes(retryAfterSec)} мин.`,
      );
    }

    const user = await users.findByUsername(username);
    let valid = false;
    if (user) valid = await verifyPassword(password, user.passwordHash);
    else await dummyVerify(password);

    if (!user || !valid) {
      limiter.byUser.hit(username);
      limiter.byIp.hit(ip);
      await audit.write({
        action: 'login.failure',
        actor,
        ip,
        detail: user ? 'неверный пароль' : 'неизвестный пользователь',
      });
      return sendError(reply, 401, 'invalid_credentials', INVALID_CREDENTIALS_MESSAGE);
    }

    limiter.byUser.reset(username);
    const { token } = await sessions.create(user.id);
    const updated = await users
      .update(user.id, { lastLoginAt: isoNow(deps.clock) })
      .catch((error: unknown) => {
        request.log.warn({ err: error }, 'Не удалось сохранить время входа');
        return undefined;
      });
    setSessionCookie(reply, request, config, token);
    await audit.write({ action: 'login.success', actor: user.username, ip, detail: null });
    const body: SessionResponse = { user: toSessionUser(updated ?? user), demo: config.demo };
    return body;
  });

  app.post('/api/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const session = sessions.lookup(token);
      if (session) {
        const user = await users.findById(session.userId);
        await sessions.delete(token);
        await audit.write({ action: 'logout', actor: user?.username ?? null, ip: request.ip, detail: null });
      }
    }
    clearSessionCookie(reply, request, config);
    return reply.code(204).send();
  });

  app.get('/api/session', { preHandler: guards.requireUser }, async (request) => {
    const body: SessionResponse = { user: toSessionUser(currentUser(request)), demo: config.demo };
    return body;
  });

  app.get('/api/setup-state', async () => {
    const body: SetupStateResponse = {
      hasUsers: (await users.list()).length > 0,
      createAdminCommand: CREATE_ADMIN_COMMAND,
    };
    return body;
  });
}
