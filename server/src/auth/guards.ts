import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { sendError } from '../lib/http.ts';
import { SESSION_COOKIE, SESSION_TTL_MS, type SessionStore } from './sessions.ts';
import { isDisabled, needsPasswordChange, type StoredUser, type UserStore } from './users.ts';

export interface AuthDeps {
  config: Config;
  users: UserStore;
  sessions: SessionStore;
}

const signedIn = new WeakMap<FastifyRequest, StoredUser>();

/**
 * Secure cookies: always / never by config; in `auto` mode when the request arrived over HTTPS
 * (directly or via the trusted loopback proxy, e.g. Tailscale Serve) or for a *.ts.net host.
 */
export function isSecureRequest(request: FastifyRequest, config: Config): boolean {
  if (config.cookieSecure === 'always') return true;
  if (config.cookieSecure === 'never') return false;
  return request.protocol === 'https' || request.hostname.toLowerCase().endsWith('.ts.net');
}

function cookieOptions(request: FastifyRequest, config: Config) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure: isSecureRequest(request, config),
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  config: Config,
  token: string,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    ...cookieOptions(request, config),
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply, request: FastifyRequest, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(request, config));
}

/**
 * Resolves the signed-in user from the session cookie. A session is valid only while it is not
 * expired, its user still exists and the password was not changed after the session was created.
 */
export async function resolveUser(
  deps: AuthDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<StoredUser | null> {
  const cached = signedIn.get(request);
  if (cached) return cached;
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = deps.sessions.lookup(token);
  if (!session) {
    clearSessionCookie(reply, request, deps.config);
    return null;
  }
  const user = await deps.users.findById(session.userId);
  if (!user || isDisabled(user) || Date.parse(user.passwordChangedAt) > Date.parse(session.createdAt)) {
    await deps.sessions.deleteByHash(session.tokenHash);
    clearSessionCookie(reply, request, deps.config);
    return null;
  }
  // Sliding expiry: when the server-side lastSeenAt moves, renew the cookie lifetime too.
  if (deps.sessions.touch(session)) setSessionCookie(reply, request, deps.config, token);
  signedIn.set(request, user);
  return user;
}

export function currentUser(request: FastifyRequest): StoredUser {
  const user = signedIn.get(request);
  if (!user) throw new Error('currentUser() called on a route without an auth guard');
  return user;
}

export const PASSWORD_CHANGE_REQUIRED_MESSAGE =
  'Сначала придумайте свой пароль: временный пароль действует только для первого входа.';

export function createGuards(deps: AuthDeps) {
  return {
    /**
     * Any signed-in user, including one who still has to replace a generated password. Only for
     * the session probe and the password change itself.
     */
    async requireSignedIn(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
      const user = await resolveUser(deps, request, reply);
      if (!user) return sendError(reply, 401, 'unauthorized', 'Войдите в портал, чтобы продолжить.');
      return undefined;
    },
    async requireUser(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
      const user = await resolveUser(deps, request, reply);
      if (!user) return sendError(reply, 401, 'unauthorized', 'Войдите в портал, чтобы продолжить.');
      if (needsPasswordChange(user)) {
        return sendError(reply, 403, 'password_change_required', PASSWORD_CHANGE_REQUIRED_MESSAGE);
      }
      return undefined;
    },
    async requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
      const user = await resolveUser(deps, request, reply);
      if (!user) return sendError(reply, 401, 'unauthorized', 'Войдите в портал, чтобы продолжить.');
      if (needsPasswordChange(user)) {
        return sendError(reply, 403, 'password_change_required', PASSWORD_CHANGE_REQUIRED_MESSAGE);
      }
      if (user.role !== 'admin') {
        return sendError(reply, 403, 'forbidden', 'Этот раздел доступен только администратору.');
      }
      return undefined;
    },
  };
}

export type Guards = ReturnType<typeof createGuards>;
