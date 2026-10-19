/**
 * Family tasks («Дела») in the browser: how the list is cut into «просрочено / сегодня / завтра /
 * позже», the words for repeats and reminders, and what the home page shows. Pure functions; the day
 * and the time come in as arguments, so nothing here looks at the clock.
 */
import type { TaskListView, TaskRepeat, TaskView } from '../../../shared/api.ts';
import { addDays, shortDayLabel } from './dates.ts';

/** A moment on the wall of the house: «YYYY-MM-DD» and «HH:MM» of this device. */
export interface WallMoment {
  day: string;
  time: string;
}

export function wallMoment(now: Date): WallMoment {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    day: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

export type TaskGroupId = 'overdue' | 'today' | 'tomorrow' | 'later' | 'nodate' | 'done';

export const GROUP_TITLE: Record<TaskGroupId, string> = {
  overdue: 'Просрочено',
  today: 'Сегодня',
  tomorrow: 'Завтра',
  later: 'Позже',
  nodate: 'Без срока',
  done: 'Сделано',
};

const GROUP_ORDER: readonly TaskGroupId[] = ['overdue', 'today', 'tomorrow', 'later', 'nodate', 'done'];

/** A task is overdue when its day has passed, or its day is today and its time has passed. */
export function isOverdue(task: Pick<TaskView, 'done' | 'due' | 'dueTime'>, now: WallMoment): boolean {
  if (task.done || task.due === null) return false;
  if (task.due < now.day) return true;
  return task.due === now.day && task.dueTime !== null && task.dueTime < now.time;
}

export function groupOf(task: TaskView, now: WallMoment): TaskGroupId {
  if (task.done) return 'done';
  if (task.due === null) return 'nodate';
  if (isOverdue(task, now)) return 'overdue';
  if (task.due === now.day) return 'today';
  if (task.due === addDays(now.day, 1)) return 'tomorrow';
  return 'later';
}

function byDue(a: TaskView, b: TaskView): number {
  return (
    (a.due ?? '').localeCompare(b.due ?? '') ||
    // an all-day task comes before the timed ones of its day
    (a.dueTime ?? '').localeCompare(b.dueTime ?? '') ||
    a.title.localeCompare(b.title, 'ru')
  );
}

export interface TaskGroup {
  id: TaskGroupId;
  title: string;
  tasks: TaskView[];
}

/** The groups that have something in them, in the order a person reads them. */
export function groupTasks(tasks: readonly TaskView[], now: WallMoment): TaskGroup[] {
  const buckets = new Map<TaskGroupId, TaskView[]>();
  for (const task of tasks) {
    const id = groupOf(task, now);
    buckets.set(id, [...(buckets.get(id) ?? []), task]);
  }
  return GROUP_ORDER.flatMap((id) => {
    const list = buckets.get(id);
    if (!list) return [];
    const sorted =
      id === 'nodate'
        ? list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        : id === 'done'
          ? list.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
          : list.sort(byDue);
    return [{ id, title: GROUP_TITLE[id], tasks: sorted }];
  });
}

/** «Сегодня», «Завтра», «Вчера» or «пт, 23 окт.». */
export function dayWord(day: string, today: string): string {
  if (day === today) return 'Сегодня';
  if (day === addDays(today, 1)) return 'Завтра';
  if (day === addDays(today, -1)) return 'Вчера';
  return shortDayLabel(day);
}

/** «Сегодня, 18:30», «Завтра», «пт, 23 окт.»; null when the task has no date. */
export function dueText(task: Pick<TaskView, 'due' | 'dueTime'>, today: string): string | null {
  if (task.due === null) return null;
  const day = dayWord(task.due, today);
  return task.dueTime === null ? day : `${day}, ${task.dueTime}`;
}

export const REPEAT_LABEL: Record<TaskRepeat, string> = {
  none: 'Не повторять',
  daily: 'Каждый день',
  weekly: 'Каждую неделю',
  monthly: 'Каждый месяц',
  yearly: 'Каждый год',
};

/** 1 минута, 2 минуты, 5 минут. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** The choices of «Напомнить»: null — never, 0 — at the time itself, otherwise minutes before. */
export const REMIND_CHOICES: ReadonlyArray<number | null> = [null, 0, 10, 30, 60, 180, 1440, 2880];

export function remindLabel(minutes: number | null): string {
  if (minutes === null) return 'Не напоминать';
  if (minutes === 0) return 'В момент срока';
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `За ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `За ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  }
  return `За ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}`;
}

/** Items typed one per line or pasted from a message: trimmed, no empty lines, bullets dropped. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/u, '').trim())
    .filter((line) => line !== '');
}

/** The tasks of one view: a list, or «all» — everything except the items of shopping lists. */
export function tasksOfView(
  tasks: readonly TaskView[],
  lists: readonly TaskListView[],
  view: string | null,
): TaskView[] {
  if (view !== null) return tasks.filter((task) => task.listId === view);
  const shopping = new Set(lists.filter((list) => list.kind === 'shopping').map((list) => list.id));
  return tasks.filter((task) => task.listId === null || !shopping.has(task.listId));
}

/**
 * «Дела на сегодня» for the home page: open tasks due today or earlier that are for this person (or
 * for nobody in particular), overdue first.
 */
export function tasksForToday(tasks: readonly TaskView[], me: string, now: WallMoment): TaskView[] {
  return tasks
    .filter((task) => !task.done && task.due !== null && task.due <= now.day)
    .filter((task) => task.assignee === null || task.assignee === me)
    .sort((a, b) => Number(isOverdue(b, now)) - Number(isOverdue(a, now)) || byDue(a, b));
}
