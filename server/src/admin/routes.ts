import type { FastifyInstance } from 'fastify';
import type { AuditResponse, DiagnosticsResponse, UsersResponse } from '../../../shared/api.ts';
import { AUDIT_MAX_READ, type AuditLog } from '../audit/log.ts';
import { currentUser, type Guards } from '../auth/guards.ts';
import { type LoginTimes, lastLoginOf } from '../auth/logins.ts';
import type { UserStore } from '../auth/users.ts';
import type { Config } from '../config.ts';
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
}

const DEFAULT_AUDIT_LIMIT = 100;

function parseLimit(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : DEFAULT_AUDIT_LIMIT;
  return Math.min(Math.max(n, 1), AUDIT_MAX_READ);
}

/** Read-only admin API plus the diagnostics export. No commands, files or restarts. */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const { config, guards } = deps;

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
        createdAt: user.createdAt,
        lastLoginAt: lastLoginOf(user, deps.logins),
      })),
    };
    return body;
  });

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
