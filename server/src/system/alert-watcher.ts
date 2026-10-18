/**
 * Tells the administrators when the server gets a real problem (a drive is full, the backup failed, a
 * program is down, something overheats) — once per problem, not every minute. A problem must be seen
 * twice in a row before it is announced (a restart or a slow probe is not an outage); it is announced
 * again only after it went away and came back, or after a day if it is still there.
 */
import type { Alert, NotificationKind } from '../../../shared/api.ts';
import { isDisabled, type StoredUser } from '../auth/users.ts';
import type { NotificationCenter } from '../notify/center.ts';

export const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;
export const CONFIRM_TICKS = 2;

export function kindOfAlert(id: string): NotificationKind {
  if (id.startsWith('backup-')) return 'backup';
  if (id.startsWith('volume-low-') || id.startsWith('disk')) return 'disk';
  if (id.startsWith('program-') || id.startsWith('supervisor-') || id.startsWith('tailscale-'))
    return 'service';
  return 'system';
}

export interface AlertWatcher {
  /** Looks at the current alerts; call once a minute. */
  tick(): Promise<void>;
}

export function createAlertWatcher(options: {
  alerts: () => Alert[];
  admins: () => Promise<StoredUser[]>;
  notify: NotificationCenter['notify'];
  now: () => number;
}): AlertWatcher {
  /** id → how many checks in a row it was there, and when it was announced last (null = not yet). */
  const seen = new Map<string, { ticks: number; announcedAt: number | null }>();

  return {
    async tick() {
      const current = options.alerts().filter((alert) => alert.level !== 'info');
      const ids = new Set(current.map((alert) => alert.id));
      for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
      const due: Alert[] = [];
      for (const alert of current) {
        const state = seen.get(alert.id) ?? { ticks: 0, announcedAt: null };
        state.ticks += 1;
        const now = options.now();
        if (
          state.ticks >= CONFIRM_TICKS &&
          (state.announcedAt === null || now - state.announcedAt >= REMIND_AFTER_MS)
        ) {
          state.announcedAt = now;
          due.push(alert);
        }
        seen.set(alert.id, state);
      }
      if (due.length === 0) return;
      const admins = (await options.admins()).filter((user) => user.role === 'admin' && !isDisabled(user));
      if (admins.length === 0) return;
      for (const alert of due) {
        await options.notify({
          users: admins.map((admin) => admin.id),
          kind: kindOfAlert(alert.id),
          title: alert.title,
          body: alert.text.slice(0, 200),
          url: '/system',
          key: `alert:${alert.id}`,
          urgency: alert.level === 'critical' ? 'high' : 'normal',
          topic: `alert-${alert.id}`,
        });
      }
    },
  };
}
