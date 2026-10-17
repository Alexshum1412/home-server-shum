/**
 * Calendar dates as plain «YYYY-MM-DD» strings. The family calendar has no time zones: a birthday
 * or a doctor's visit is on that day at that wall-clock time, wherever a phone happens to be. All
 * arithmetic is done on UTC dates, so daylight saving can never move an event.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isRealDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 1900 || y > 2200) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isTime(value: string): boolean {
  return TIME_RE.test(value);
}

function parse(value: string): { y: number; m: number; d: number } {
  const match = DATE_RE.exec(value);
  if (!match) throw new Error(`bad date ${value}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function toDate(value: string): Date {
  const { y, m, d } = parse(value);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(value: string, days: number): string {
  const date = toDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

export type Repeat = 'none' | 'weekly' | 'monthly' | 'yearly';

/** Does a repeating event that starts on `start` fall on `day`? Days that do not exist are skipped (31st, 29 Feb). */
export function occursOn(start: string, repeat: Repeat, day: string): boolean {
  if (day < start) return false;
  if (repeat === 'none') return day === start;
  if (repeat === 'weekly') return daysBetween(start, day) % 7 === 0;
  const a = parse(start);
  const b = parse(day);
  if (repeat === 'monthly') return a.d === b.d;
  return a.d === b.d && a.m === b.m;
}

/** A day as plain integers, parsed once: `n` counts whole days since 1970-01-01. */
export interface DayInfo {
  day: string;
  y: number;
  m: number;
  d: number;
  n: number;
}

export function dayInfo(day: string): DayInfo {
  const { y, m, d } = parse(day);
  return { day, y, m, d, n: Math.floor(Date.UTC(y, m - 1, d) / 86_400_000) };
}

/** Same rule as `occursOn`, on pre-parsed days. */
export function occursOnInfo(start: DayInfo, repeat: Repeat, day: DayInfo): boolean {
  if (day.n < start.n) return false;
  if (repeat === 'none') return day.n === start.n;
  if (repeat === 'weekly') return (day.n - start.n) % 7 === 0;
  if (repeat === 'monthly') return start.d === day.d;
  return start.d === day.d && start.m === day.m;
}

/** All days from `from` to `to` inclusive. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}
