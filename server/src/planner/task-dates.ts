/**
 * Dates and times of family tasks («Дела»): when a repeating task comes next and when its reminder is
 * due. Like the calendar, the family has no time zones: a due date is a day on the wall of the house,
 * a time is the wall-clock time of the home PC. Day arithmetic is done on UTC dates (see dates.ts), so
 * daylight saving can never move a task; only the reminder compares real instants.
 */
import type { TaskRepeat } from '../../../shared/api.ts';
import { addDays, dayInfo, formatDate, isRealDate } from './dates.ts';

export type RepeatingTask = Exclude<TaskRepeat, 'none'>;

/** An all-day task with a reminder is announced at this time of its day (minus the «before» minutes). */
export const ALL_DAY_REMINDER_TIME = '09:00';
/** A reminder that was missed (the server was off) is still told this long after the due time. */
export const LATE_GRACE_MS = 2 * 60 * 60 * 1000;

const pad2 = (n: number) => String(n).padStart(2, '0');

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Occurrence number `k` of a repeating task whose first date is `anchor` (k = 0 is the anchor itself).
 * The day of the month is remembered from the anchor, so a task set for the 31st comes on the last
 * day of a shorter month (28th, 30th) and returns to the 31st afterwards; 29 February comes on 28
 * February in a year that has no 29th.
 */
export function occurrence(anchor: string, repeat: RepeatingTask, k: number): string {
  const a = dayInfo(anchor);
  if (repeat === 'daily') return addDays(anchor, k);
  if (repeat === 'weekly') return addDays(anchor, 7 * k);
  const months = repeat === 'monthly' ? a.y * 12 + (a.m - 1) + k : (a.y + k) * 12 + (a.m - 1);
  const year = Math.floor(months / 12);
  const month = (months % 12) + 1;
  const day = Math.min(a.d, daysInMonth(year, month));
  return formatDate(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * The first occurrence strictly after `after`, or null when it would lie beyond the years the
 * portal accepts (the task then simply ends).
 */
export function nextOccurrence(anchor: string, repeat: RepeatingTask, after: string): string | null {
  const a = dayInfo(anchor);
  const t = dayInfo(after);
  if (t.n < a.n) return anchor;
  let k: number;
  if (repeat === 'daily') k = t.n - a.n + 1;
  else if (repeat === 'weekly') k = Math.floor((t.n - a.n) / 7) + 1;
  else {
    // The occurrence in the month (year) of `after` or the one after it.
    k = repeat === 'monthly' ? (t.y - a.y) * 12 + (t.m - a.m) : t.y - a.y;
    if (occurrence(anchor, repeat, k) <= after) k += 1;
  }
  const next = occurrence(anchor, repeat, k);
  return isRealDate(next) ? next : null;
}

/** A moment on the wall of the house: the day and the time of the home PC's clock. */
export function localMoment(date: Date): { day: string; time: string } {
  return {
    day: `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
  };
}

/** The real instant of a wall-clock day and time of the home PC. */
export function localInstant(day: string, time: string): Date {
  const { y, m, d } = dayInfo(day);
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return new Date(y, m - 1, d, hours, minutes, 0, 0);
}

/** Identifies one occurrence of a task: the same value means «already told about this one». */
export function occurrenceKey(due: string, dueTime: string | null): string {
  return dueTime === null ? due : `${due}T${dueTime}`;
}

export interface ReminderWindow {
  key: string;
  /** From this instant the reminder is due. */
  fireAt: Date;
  /** After this instant it is no use any more: the thing is past (the task is shown as overdue instead). */
  until: Date;
}

/** When the reminder of a task is due; null for a task without a due date or without a reminder. */
export function reminderWindow(task: {
  due: string | null;
  dueTime: string | null;
  remindBefore: number | null;
}): ReminderWindow | null {
  if (task.due === null || task.remindBefore === null) return null;
  const base = localInstant(task.due, task.dueTime ?? ALL_DAY_REMINDER_TIME);
  return {
    key: occurrenceKey(task.due, task.dueTime),
    fireAt: new Date(base.getTime() - task.remindBefore * 60_000),
    // An all-day task is still worth telling until the day is over; a timed one a little after its time.
    until:
      task.dueTime === null
        ? new Date(localInstant(task.due, '23:59').getTime() + 59_999)
        : new Date(base.getTime() + LATE_GRACE_MS),
  };
}
