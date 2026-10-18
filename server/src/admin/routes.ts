import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type AuditResponse,
  type DiagnosticsResponse,
  PERMISSIONS,
  type Permission,
  type TemporaryPasswordResponse,
  type UsersResponse,
} from '../../../shared/api.ts';
import { AUDIT_MAX_READ, type AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { type LoginTimes, lastLoginOf } from '../auth/logins.ts';
import { generatePassword, hashPassword, TEMPORARY_PASSWORD_TTL_MS } from '../auth/passwords.ts';
import type { LoginLimiter } from '../auth/rate-limit.ts';
import { SESSION_COOKIE, type SessionStore } from '../auth/sessions.ts';
import {
  DISPLAY_NAME_MAX,
  effectivePermissions,
  isDisabled,
  needsPasswordChange,
  normaliseUsername,
  USERNAME_RE,
  type UserGuard,
  type UserStore,
  UserStoreError,
} from '../auth/users.ts';
import type { CallManager } from '../calls/manager.ts';
import type { Config } from '../config.ts';
import { sendError } from '../lib/http.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import type { ServiceRegistry } from '../services/checker.ts';
import type { SystemCollector } from '../system/collector.ts';

export interface AdminRouteDeps {
  config: Config;
  clock: Clock;
  version: string;
  guards: Guards;
  audit: AuditLog;
  users: UserStore;
  logins: LoginTimes;
  registry: ServiceRegistry;
  collector: SystemCollector;
  limiter: LoginLimiter;
  sessions: SessionStore;
  calls: CallManager;
  /** After removal: the person's files are moved to the trash folder, their private events are deleted. */
  retireAccount: (username: string, userId: string) => Promise<string>;
}

const DEFAULT_AUDIT_LIMIT = 100;

function parseLimit(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : DEFAULT_AUDIT_LIMIT;
  return Math.min(Math.max(n, 1), AUDIT_MAX_READ);
}

const permissionSchema = z.enum(['downloads', 'print']);
const createUserSchema = z.object({
  username: z.string().max(64),
  displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX),
  role: z.enum(['family', 'admin']).default('family'),
  permissions: z.array(permissionSchema).max(PERMISSIONS.length).optional(),
});
const accessSchema = z
  .object({
    role: z.enum(['family', 'admin']).optional(),
    permissions: z.array(permissionSchema).max(PERMISSIONS.length).optional(),
  })
  .refine((value) => value.role !== undefined || value.permissions !== undefined);
const removeSchema = z.object({ confirm: z.literal(true) });
const usernameParam = z.object({ username: z.string().max(64) });

/**
 * Decided inside the store's write queue, so two administrators acting at once cannot both pass.
 * Only active administrators count: a switched-off one cannot run the server.
 */
const keepOneAdmin =
  (message: string): UserGuard =>
  (current, target) => {
    if (target.role !== 'admin' || isDisabled(target)) return;
    if (current.filter((user) => user.role === 'admin' && !isDisabled(user)).length <= 1) {
      throw new UserStoreError(message, 'last_admin');
    }
  };

const roleLabel = (role: string) => (role === 'admin' ? 'администратор' : 'семья');
const orderedPermissions = (list: readonly Permission[]): Permission[] =>
  PERMISSIONS.filter((p) => list.includes(p));

/**
 * Admin API: audit, users, diagnostics export. No commands, files or restarts. Account management
 * hands out only generated temporary passwords (shown once); the admin never chooses or sees the
 * password of another person. The same operations exist on the server console (user.cmd).
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const { config, guards } = deps;

  async function newTemporaryPassword(): Promise<{ password: string; hash: string; expiresAt: string }> {
    const password = generatePassword();
    return {
      password,
      hash: await hashPassword(password),
      expiresAt: new Date(deps.clock().getTime() + TEMPORARY_PASSWORD_TTL_MS).toISOString(),
    };
  }

  app.get('/api/admin/audit', { preHandler: guards.requireAdmin }, async (request) => {
    const query = request.query as Record<string, unknown> | undefined;
    const body: AuditResponse = { entries: await deps.audit.readLatest(parseLimit(query?.limit)) };
    return body;
  });

  app.get('/api/admin/users', { preHandler: guards.requireAdmin }, async () => {
    const body: UsersResponse = {
      users: (await deps.users.list()).map((user) => ({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        permissions: effectivePermissions(user),
        createdAt: user.createdAt,
        lastLoginAt: lastLoginOf(user, deps.logins),
        temporaryPassword: needsPasswordChange(user),
        passwordExpiresAt: needsPasswordChange(user) ? (user.passwordExpiresAt ?? null) : null,
        disabled: isDisabled(user),
        sessions: deps.sessions.listFor(user.id).length,
      })),
    };
    return body;
  });

  /**
   * «Lost phone» or someone who should not come in for a while: the account is switched off (every
   * device is signed out at once, nothing is deleted) and switched on again later.
   */
  for (const action of ['disable', 'enable'] as const) {
    app.post(
      `/api/admin/users/:username/${action}`,
      { preHandler: guards.requireAdmin },
      async (request, reply) => {
        const params = usernameParam.safeParse(request.params);
        const target = params.success ? await deps.users.findByUsername(params.data.username) : undefined;
        if (!target) return sendError(reply, 404, 'not_found', 'Такого пользователя нет.');
        const me = currentUser(request);
        if (action === 'disable' && target.id === me.id) {
          return sendError(reply, 400, 'self', 'Нельзя отключить самого себя.');
        }
        try {
          await deps.users.update(
            target.id,
            { disabled: action === 'disable' },
            action === 'disable' ? keepOneAdmin('Нельзя отключить последнего администратора.') : undefined,
          );
        } catch (error) {
          if (error instanceof UserStoreError && error.code === 'last_admin') {
            return sendError(reply, 409, 'last_admin', error.message);
          }
          throw error;
        }
        if (action === 'disable') {
          await deps.sessions.deleteForUser(target.id);
          await deps.calls.dropUser(target.id);
        }
        await deps.audit.write({
          action: action === 'disable' ? 'user.disable' : 'user.enable',
          actor: me.username,
          ip: request.ip,
          detail: target.username,
        });
        return reply.code(204).send();
      },
    );
  }

  app.post(
    '/api/admin/users/:username/sign-out',
    { preHandler: guards.requireAdmin },
    async (request, reply) => {
      const params = usernameParam.safeParse(request.params);
      const target = params.success ? await deps.users.findByUsername(params.data.username) : undefined;
      if (!target) return sendError(reply, 404, 'not_found', 'Такого пользователя нет.');
      const me = currentUser(request);
      const here = request.cookies[SESSION_COOKIE] ?? '';
      const keep = target.id === me.id ? deps.sessions.lookup(here)?.tokenHash : undefined;
      const ended = await deps.sessions.deleteForUser(target.id, keep);
      await deps.audit.write({
        action: 'user.sign_out',
        actor: me.username,
        ip: request.ip,
        detail: `${target.username}: устройств ${ended}`,
      });
      return reply.code(204).send();
    },
  );

  app.post('/api/admin/users', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Укажите логин, имя и роль.');
    const username = normaliseUsername(parsed.data.username);
    if (!USERNAME_RE.test(username)) {
      return sendError(
        reply,
        400,
        'bad_username',
        'Недопустимый логин: латиница в нижнем регистре, цифры, «.», «_», «-», от 2 до 32 символов.',
      );
    }
    const temp = await newTemporaryPassword();
    try {
      const user = await deps.users.add({
        username,
        displayName: parsed.data.displayName,
        role: parsed.data.role,
        passwordHash: temp.hash,
        temporaryUntil: temp.expiresAt,
      });
      if (parsed.data.role === 'family' && parsed.data.permissions?.length) {
        await deps.users.update(user.id, { permissions: orderedPermissions(parsed.data.permissions) });
      }
      await deps.audit.write({
        action: 'user.create',
        actor: currentUser(request).username,
        ip: request.ip,
        detail: `${user.username}, роль: ${roleLabel(user.role)}`,
      });
      const body: TemporaryPasswordResponse = {
        username: user.username,
        displayName: user.displayName,
        temporaryPassword: temp.password,
        expiresAt: temp.expiresAt,
      };
      return reply.code(201).send(body);
    } catch (error) {
      if (error instanceof UserStoreError) return sendError(reply, 409, 'exists', error.message);
      throw error;
    }
  });

  app.post(
    '/api/admin/users/:username/reset-password',
    { preHandler: guards.requireAdmin },
    async (request, reply) => {
      const params = usernameParam.safeParse(request.params);
      const target = params.success ? await deps.users.findByUsername(params.data.username) : undefined;
      if (!target) return sendError(reply, 404, 'not_found', 'Такого пользователя нет.');
      const me = currentUser(request);
      if (target.id === me.id) {
        return sendError(reply, 400, 'self', 'Свой пароль меняйте в разделе «Мой профиль».');
      }
      const temp = await newTemporaryPassword();
      await deps.users.update(target.id, {
        passwordHash: temp.hash,
        passwordChangedAt: isoNow(deps.clock),
        mustChangePassword: true,
        passwordExpiresAt: temp.expiresAt,
      });
      // A person locked out by failed attempts can sign in with the new password at once.
      deps.limiter.byUser.reset(target.username);
      await deps.audit.write({
        action: 'user.reset_password',
        actor: me.username,
        ip: request.ip,
        detail: target.username,
      });
      const body: TemporaryPasswordResponse = {
        username: target.username,
        displayName: target.displayName,
        temporaryPassword: temp.password,
        expiresAt: temp.expiresAt,
      };
      return body;
    },
  );

  app.post(
    '/api/admin/users/:username/access',
    { preHandler: guards.requireAdmin },
    async (request, reply) => {
      const params = usernameParam.safeParse(request.params);
      const parsed = accessSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Укажите роль или права.');
      const target = params.success ? await deps.users.findByUsername(params.data.username) : undefined;
      if (!target) return sendError(reply, 404, 'not_found', 'Такого пользователя нет.');
      const me = currentUser(request);
      const newRole = parsed.data.role ?? target.role;
      if (target.id === me.id && newRole !== target.role) {
        return sendError(reply, 400, 'self', 'Свою роль менять нельзя: попросите другого администратора.');
      }
      const permissions = parsed.data.permissions ? orderedPermissions(parsed.data.permissions) : undefined;
      try {
        await deps.users.update(
          target.id,
          {
            ...(parsed.data.role ? { role: parsed.data.role } : {}),
            ...(permissions ? { permissions } : {}),
          },
          newRole !== 'admin' ? keepOneAdmin('Нельзя снять роль с последнего администратора.') : undefined,
        );
      } catch (error) {
        if (error instanceof UserStoreError && error.code === 'last_admin') {
          return sendError(reply, 409, 'last_admin', error.message);
        }
        throw error;
      }
      const rights = newRole === 'admin' ? [...PERMISSIONS] : (permissions ?? target.permissions ?? []);
      await deps.audit.write({
        action: 'user.access',
        actor: me.username,
        ip: request.ip,
        detail: `${target.username}: роль ${roleLabel(newRole)}, права: ${rights.join(', ') || 'нет'}`,
      });
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/admin/users/:username/remove',
    { preHandler: guards.requireAdmin },
    async (request, reply) => {
      const params = usernameParam.safeParse(request.params);
      if (!removeSchema.safeParse(request.body).success) {
        return sendError(reply, 400, 'bad_request', 'Нужно подтверждение удаления.');
      }
      const target = params.success ? await deps.users.findByUsername(params.data.username) : undefined;
      if (!target) return sendError(reply, 404, 'not_found', 'Такого пользователя нет.');
      const me = currentUser(request);
      if (target.id === me.id) return sendError(reply, 400, 'self', 'Нельзя удалить самого себя.');
      try {
        await deps.users.remove(target.id, keepOneAdmin('Нельзя удалить последнего администратора.'));
      } catch (error) {
        if (error instanceof UserStoreError && error.code === 'last_admin') {
          return sendError(reply, 409, 'last_admin', error.message);
        }
        throw error;
      }
      let what = '';
      try {
        what = await deps.retireAccount(target.username, target.id);
      } catch (error) {
        request.log.error({ err: error }, 'Не удалось убрать данные удалённого пользователя');
        await deps.audit.write({
          action: 'user.remove',
          actor: me.username,
          ip: request.ip,
          detail: `${target.username}: учётная запись удалена, но перенос файлов не удался`,
        });
        return sendError(
          reply,
          500,
          'archive_failed',
          'Пользователь удалён, но его файлы не удалось перенести в корзину сервера. Сделайте это вручную, прежде чем создавать учётную запись с таким же логином.',
        );
      }
      await deps.audit.write({
        action: 'user.remove',
        actor: me.username,
        ip: request.ip,
        detail: what ? `${target.username}: ${what}` : target.username,
      });
      return reply.code(204).send();
    },
  );

  app.get('/api/admin/diagnostics', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const generatedAt = isoNow(deps.clock);
    const userCount = (await deps.users.list()).length;
    // Only non-secret settings; there are no secrets in Config, but list keys explicitly anyway.
    const body: DiagnosticsResponse = {
      generatedAt,
      app: { version: deps.version, node: process.version, platform: process.platform, demo: config.demo },
      config: {
        host: config.host,
        port: config.port,
        dataDir: config.dataDir,
        demo: config.demo,
        serviceCheckIntervalSec: config.serviceCheckIntervalSec,
        serviceCheckTimeoutMs: config.serviceCheckTimeoutMs,
        volumes: config.volumes.join(';'),
        lowSpacePercent: config.lowSpacePercent,
        printerName: config.printerName,
        tailscaleExe: config.tailscaleExe,
        publicUrl: config.publicUrl,
        lanUrl: config.lanUrl,
        cookieSecure: config.cookieSecure,
        backupTargets: config.backupTargets.join(';'),
        backupKeep: config.backupKeep,
        backupRepoDir: config.backupRepoDir,
        backupExtraFiles: config.backupExtraFiles === null ? null : config.backupExtraFiles.join(';'),
        gitExe: config.gitExe,
        backupGitPush: config.backupGitPush
          ? `${config.backupGitPush.remote}/${config.backupGitPush.branch}`
          : null,
        userCount,
      },
      system: deps.collector.snapshot('admin'),
      services: deps.registry.statuses(),
    };
    await deps.audit.write({
      action: 'diagnostics.export',
      actor: currentUser(request).username,
      ip: request.ip,
    });
    reply.header(
      'Content-Disposition',
      `attachment; filename="family-dashboard-diagnostics-${generatedAt.slice(0, 10)}.json"`,
    );
    return body;
  });
}
