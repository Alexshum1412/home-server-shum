/**
 * Calendar dates as «YYYY-MM-DD» strings, like on the server: no time zones, no surprises around
 * midnight or daylight saving. Only `todayLocal` looks at the clock of this device.
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function utc(day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function format(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(day: string, days: number): string {
  const date = utc(day);
  date.setUTCDate(date.getUTCDate() + days);
  return format(date);
}

/** "2026-10-17" → "2026-10". */
export const monthOf = (day: string): string => day.slice(0, 7);

export function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return format(utc(value)) === value;
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

/** The 42 days (six weeks, Monday first) that fill the month grid, including days of the neighbouring months. */
export function gridDays(month: string): string[] {
  const first = `${month}-01`;
  const weekday = (utc(first).getUTCDay() + 6) % 7; // Monday = 0
  const start = addDays(first, -weekday);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

const monthTitle = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayTitle = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
const shortDay = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

/** "октябрь 2026" */
export const monthLabel = (month: string): string => monthTitle.format(utc(`${month}-01`));
/** "суббота, 17 октября" */
export const dayLabel = (day: string): string => dayTitle.format(utc(day));
/** "сб, 17 окт." */
export const shortDayLabel = (day: string): string => shortDay.format(utc(day));
