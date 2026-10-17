import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionResponse, SetupStateResponse } from '../../../shared/api.ts';
import type { AuditLog } from '../audit/log.ts';
import type { Config } from '../config.ts';
import { sendError } from '../lib/http.ts';
import { type Clock, ceilMinutes, isoNow } from '../lib/time.ts';
import { clearSessionCookie, currentUser, type Guards, setSessionCookie } from './guards.ts';
import type { LoginTimes } from './logins.ts';
import {
  checkPasswordPolicy,
  dummyVerify,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  verifyPassword,
} from './passwords.ts';
import { LOGIN_WINDOW_MS, type LoginLimiter } from './rate-limit.ts';
import { SESSION_COOKIE, type SessionStore } from './sessions.ts';
import {
  needsPasswordChange,
  normaliseUsername,
  type StoredUser,
  temporaryPasswordExpired,
  toSessionUser,
  USERNAME_RE,
  type UserStore,
} from './users.ts';

export const CREATE_ADMIN_COMMAND = 'scripts\\user.cmd add <логин> --name "<Имя>" --role admin';
export const TEMPORARY_EXPIRED_MESSAGE =
  'Срок временного пароля истёк. Попросите администратора выдать новый на домашнем компьютере.';
export const INVALID_CREDENTIALS_MESSAGE = 'Неверное имя пользователя или пароль';
export const USERS_UNAVAILABLE_MESSAGE =
  'Не удаётся прочитать список пользователей на сервере. Сообщите администратору.';

export interface AuthRouteDeps {
  config: Config;
  clock: Clock;
  users: UserStore;
  logins: LoginTimes;
  sessions: SessionStore;
  audit: AuditLog;
  limiter: LoginLimiter;
  guards: Guards;
}

const loginSchema = z.object({
  username: z.string().max(64),
  password: z.string().max(PASSWORD_MAX_LENGTH),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().max(PASSWORD_MAX_LENGTH),
  // Longer values reach the policy check, which explains the limit instead of a generic 400.
  newPassword: z.string().max(PASSWORD_MAX_LENGTH * 4),
});

/** Upper bound on remembered blocked keys, so random names cannot grow the map without limit. */
const MAX_AUDITED_BLOCKS = 10_000;
const BLOCK_AUDIT_MINUTES = ceilMinutes(LOGIN_WINDOW_MS / 1000);

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { config, users, logins, sessions, audit, limiter, guards } = deps;

  function sessionBody(user: StoredUser): SessionResponse {
    return { user: toSessionUser(user), demo: config.demo, mustChangePassword: needsPasswordChange(user) };
  }

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
    // The audit log gets the login name only when it belongs to a real account: anything else typed
    // into this field may be a password that landed in the wrong box.
    const known = USERNAME_RE.test(username) ? await users.findByUsername(username) : undefined;
    const actor = known?.username ?? null;

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

    // Taken before the slow password check: a password change that commits meanwhile must end
    // this session too (guards compare it with passwordChangedAt).
    const attemptStartedAt = isoNow(deps.clock);
    const user = known ?? (await users.findByUsername(username));
    if (users.loadError() !== null) {
      // users.json is broken: nobody can be checked, and it is not the visitor's fault.
      limiter.byUser.release(username);
      limiter.byIp.release(ip);
      return sendError(reply, 503, 'users_unavailable', USERS_UNAVAILABLE_MESSAGE);
    }
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
    if (temporaryPasswordExpired(user, deps.clock().getTime())) {
      // Told only after the password matched: an outsider learns nothing about the account.
      await audit.write({ action: 'login.failure', actor, ip, detail: 'временный пароль истёк' });
      return sendError(reply, 403, 'temporary_password_expired', TEMPORARY_EXPIRED_MESSAGE);
    }
    const { token } = await sessions.create(user.id, attemptStartedAt);
    // logins.json, not users.json: the server never rewrites the file the CLI edits.
    await logins.record(user.id, isoNow(deps.clock)).catch((error: unknown) => {
      request.log.warn({ err: error }, 'Не удалось сохранить время входа');
    });
    setSessionCookie(reply, request, config, token);
    await audit.write({
      action: 'login.success',
      actor: user.username,
      ip,
      detail: needsPasswordChange(user) ? 'временный пароль: нужно сменить' : null,
    });
    return sessionBody(user);
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

  app.get('/api/session', { preHandler: guards.requireSignedIn }, async (request) =>
    sessionBody(currentUser(request)),
  );

  app.post('/api/password', { preHandler: guards.requireSignedIn }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.currentPassword === '' || parsed.data.newPassword === '') {
      return sendError(reply, 400, 'bad_request', 'Введите текущий и новый пароль.');
    }
    const { currentPassword, newPassword } = parsed.data;
    const ip = request.ip;
    // Guessing the current password through this form counts like failed sign-ins of the account.
    const byUser = limiter.byUser.check(user.username);
    const byIp = limiter.byIp.check(ip);
    if (!byUser.allowed || !byIp.allowed) {
      const retryAfterSec = Math.max(byIp.retryAfterSec, byUser.retryAfterSec);
      reply.header('Retry-After', String(retryAfterSec));
      return sendError(
        reply,
        429,
        'too_many_attempts',
        `Слишком много неудачных попыток. Попробуйте снова через ${ceilMinutes(retryAfterSec)} мин.`,
      );
    }
    limiter.byUser.hit(user.username);
    limiter.byIp.hit(ip);
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      await audit.write({
        action: 'password.change_failed',
        actor: user.username,
        ip,
        detail: 'неверный текущий пароль',
      });
      // 400, not 401: the session is fine, and a 401 would sign the browser out.
      return sendError(reply, 400, 'wrong_password', 'Текущий пароль указан неверно.');
    }
    limiter.byUser.release(user.username);
    limiter.byIp.release(ip);
    const problem =
      checkPasswordPolicy(newPassword, user.username) ??
      (newPassword.normalize('NFC') === currentPassword.normalize('NFC')
        ? 'Новый пароль должен отличаться от текущего.'
        : null);
    if (problem) return sendError(reply, 400, 'weak_password', problem);

    const updated = await users.update(user.id, {
      passwordHash: await hashPassword(newPassword),
      passwordChangedAt: isoNow(deps.clock),
      mustChangePassword: false,
      passwordExpiresAt: null,
    });
    if (!updated) return sendError(reply, 401, 'unauthorized', 'Войдите в портал, чтобы продолжить.');
    // The changed password ends every session of the user (guards compare passwordChangedAt);
    // this device continues with a fresh one.
    const oldToken = request.cookies[SESSION_COOKIE];
    if (oldToken) await sessions.delete(oldToken);
    const { token } = await sessions.create(updated.id);
    setSessionCookie(reply, request, config, token);
    await audit.write({
      action: 'password.change',
      actor: updated.username,
      ip,
      detail: needsPasswordChange(user) ? 'временный пароль заменён своим' : null,
    });
    return sessionBody(updated);
  });

  app.get('/api/setup-state', async () => {
    const list = await users.list();
    const body: SetupStateResponse = {
      // A users.json that exists but cannot be read is not a fresh install: no first-run screen.
      hasUsers: list.length > 0 || users.loadError() !== null,
      createAdminCommand: CREATE_ADMIN_COMMAND,
    };
    return body;
  });
}
