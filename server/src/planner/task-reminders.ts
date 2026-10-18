/**
 * Reminders of family tasks («Дела»): once a minute the portal looks for tasks whose reminder time has
 * come and tells the person the task is for (the one it was given to, otherwise its author) through
 * the notification center. The store writes «already told for this occurrence» into the task before
 * handing the reminder out, so one occurrence is told once — not twice by the next minute, not again
 * after a restart (see TaskStore.dueReminders).
 */
import { isDisabled, type StoredUser } from '../auth/users.ts';
import type { NotificationCenter } from '../notify/center.ts';
import { REMOVED_OWNER } from './calendar.ts';
import { addDays } from './dates.ts';
import { localMoment } from './task-dates.ts';
import type { ReminderJob, TaskStore } from './tasks.ts';

export const REMINDER_TICK_MS = 60_000;

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });

/** «сегодня в 18:30», «завтра», «20 октября в 09:00»: when the thing is due, in plain words. */
export function dueWords(job: Pick<ReminderJob, 'due' | 'dueTime'>, now: Date): string {
  const today = localMoment(now).day;
  const day =
    job.due === today
      ? 'сегодня'
      : job.due === addDays(today, 1)
        ? 'завтра'
        : dateFormat.format(new Date(`${job.due}T00:00:00Z`));
  return job.dueTime === null ? day : `${day} в ${job.dueTime}`;
}

export interface ReminderWatcher {
  /** Tells everything that is due now; call once a minute. Returns how many people were told. */
  tick(): Promise<number>;
}

export function createReminderWatcher(options: {
  tasks: TaskStore;
  findUser: (username: string) => Promise<StoredUser | undefined>;
  notify: NotificationCenter['notify'];
  now: () => Date;
  onError?: (message: string) => void;
}): ReminderWatcher {
  /** The person to tell: the one the task was given to; if that account is gone or off, its author. */
  async function recipient(job: ReminderJob): Promise<StoredUser | undefined> {
    for (const username of [job.assignee, job.owner]) {
      if (username === null || username === REMOVED_OWNER) continue;
      const user = await options.findUser(username);
      if (user && !isDisabled(user)) return user;
    }
    return undefined;
  }

  return {
    async tick() {
      const now = options.now();
      let jobs: ReminderJob[];
      try {
        jobs = await options.tasks.dueReminders(now);
      } catch (error) {
        // A damaged tasks.json is reported to the people who open «Дела»; the log gets a line, not a flood.
        options.onError?.(`Напоминания о делах не проверены: ${(error as Error).message}`);
        return 0;
      }
      let told = 0;
      for (const job of jobs) {
        try {
          const user = await recipient(job);
          if (!user) continue;
          const given = job.assignee !== null && job.owner !== user.username;
          await options.notify({
            users: [user.id],
            kind: 'reminder',
            title: 'Напоминание о деле',
            body: `«${job.title}» — ${dueWords(job, now)}${given ? ` (поручил(а): ${job.ownerName})` : ''}`,
            url: '/tasks',
            key: `reminder:${job.taskId}`,
            topic: `reminder-${job.taskId.replace(/-/g, '').slice(0, 20)}`,
          });
          told += 1;
        } catch (error) {
          options.onError?.(`Напоминание не отправлено: ${(error as Error).message}`);
        }
      }
      return told;
    },
  };
}
