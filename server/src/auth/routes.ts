import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionResponse, SetupStateResponse } from '../../../shared/api.ts';
import type { AuditLog } from '../audit/log.ts';
import type { Config } from '../config.ts';
import { sendError } from '../lib/http.ts';
import { type Clock, ceilMinutes, isoNow } from '../lib/time.ts';
import { clearSessionCookie, currentUser, type Guards, setSessionCookie } from './guards.ts';
import { dummyVerify, PASSWORD_MAX_LENGTH, verifyPassword } from './passwords.ts';
import { LOGIN_WINDOW_MS, type LoginLimiter } from './rate-limit.ts';
import { SESSION_COOKIE, type SessionStore } from './sessions.ts';
import { normaliseUsername, toSessionUser, USERNAME_RE, type UserStore } from './users.ts';

export const CREATE_ADMIN_COMMAND = 'scripts\\user.cmd add <логин> --name "<Имя>" --role admin';
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

/** Upper bound on remembered blocked keys, so random names cannot grow the map without limit. */
const MAX_AUDITED_BLOCKS = 10_000;
const BLOCK_AUDIT_MINUTES = ceilMinutes(LOGIN_WINDOW_MS / 1000);

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { config, users, sessions, audit, limiter, guards } = deps;

  // A blocked login is audited at most once per key (login name or address) per limiter window,
  // so a peer hammering a blocked login cannot flood audit.jsonl and push real entries out of
  // the admin view or rotate history off disk. Key → time (ms) until which repeats stay silent.
  const auditedBlocks = new Map<string, number>();
  function shouldAuditBlock(key: string): boolean {
    const now = deps.clock().getTime();
    const until = auditedBlocks.get(key);
    if (until !== undefined && until > now) return false;
    auditedBlocks.delete(key);
    if (auditedBlocks.size >= MAX_AUDITED_BLOCKS) {
      for (const [k, end] of auditedBlocks) if (end <= now) auditedBlocks.delete(k);
      // Still full: forget the oldest keys (a Map keeps insertion order).
      for (const k of auditedBlocks.keys()) {
        if (auditedBlocks.size < MAX_AUDITED_BLOCKS) break;
        auditedBlocks.delete(k);
      }
    }
    auditedBlocks.set(key, now + LOGIN_WINDOW_MS);
    return true;
  }

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
      if (shouldAuditBlock(byIp.allowed ? `user:${username}` : `ip:${ip}`)) {
        const why = byIp.allowed
          ? 'слишком много попыток для этого логина'
          : 'слишком много попыток с этого адреса';
        await audit.write({
          action: 'login.blocked',
          actor,
          ip,
          detail: `${why}; повторные блокировки ${BLOCK_AUDIT_MINUTES} мин. не записываются`,
        });
      }
      reply.header('Retry-After', String(retryAfterSec));
      return sendError(
        reply,
        429,
        'too_many_attempts',
        `Слишком много неудачных попыток входа. Попробуйте снова через ${ceilMinutes(retryAfterSec)} мин.`,
      );
    }

    // Count the attempt BEFORE the first await: concurrent guesses must see each other, otherwise
    // a burst would all pass check() while the slow password hashing runs. Taken back on success.
    limiter.byUser.hit(username);
    limiter.byIp.hit(ip);

    const user = await users.findByUsername(username);
    let valid = false;
    if (user) valid = await verifyPassword(password, user.passwordHash);
    else await dummyVerify(password);

    if (!user || !valid) {
      await audit.write({
        action: 'login.failure',
        actor,
        ip,
        detail: user ? 'неверный пароль' : 'неизвестный пользователь',
      });
      return sendError(reply, 401, 'invalid_credentials', INVALID_CREDENTIALS_MESSAGE);
    }

    limiter.byUser.reset(username);
    limiter.byIp.release(ip);
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
