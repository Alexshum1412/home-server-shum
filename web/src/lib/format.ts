/**
 * Pure formatting helpers (Russian locale). No DOM access, unit-tested.
 * Every helper renders `null`/`undefined`/invalid input as «Нет данных», never as 0.
 */

export const NO_DATA = 'Нет данных';
/** Non-breaking space: keeps a number and its unit on one line. */
export const NBSP = ' ';

const LOCALE = 'ru-RU';
const BYTE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'] as const;

const numberFormats = new Map<number, Intl.NumberFormat>();

/** Locale number with comma decimals and non-breaking group separators, e.g. «1 234,5». */
export function formatNumber(value: number, maxFractionDigits = 0): string {
  let format = numberFormats.get(maxFractionDigits);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: maxFractionDigits });
    numberFormats.set(maxFractionDigits, format);
  }
  return format.format(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Binary units (as Windows Explorer shows them): 2 000 398 934 016 → «1,8 ТБ». */
export function formatBytes(bytes: number | null | undefined): string {
  if (!isFiniteNumber(bytes) || bytes < 0) return NO_DATA;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 1 ? 2 : value < 10 ? 1 : 0;
  return `${formatNumber(value, digits)}${NBSP}${BYTE_UNITS[unit]}`;
}

/** 23.4 → «23 %». */
export function formatPercent(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return NO_DATA;
  return `${formatNumber(Math.round(value))}${NBSP}%`;
}

/** Russian plural form: pluralRu(3, 'день', 'дня', 'дней') → 'дня'. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** 446_400 → «5 дн 4 ч», 3720 → «1 ч 2 мин», 30 → «меньше минуты». */
export function formatDuration(seconds: number | null | undefined): string {
  if (!isFiniteNumber(seconds) || seconds < 0) return NO_DATA;
  if (seconds < 60) return 'меньше минуты';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}${NBSP}дн ${hours}${NBSP}ч` : `${days}${NBSP}дн`;
  if (hours > 0) return minutes > 0 ? `${hours}${NBSP}ч ${minutes}${NBSP}мин` : `${hours}${NBSP}ч`;
  return `${minutes}${NBSP}мин`;
}

type TimeInput = string | number | Date;

function toMs(input: TimeInput): number {
  if (input instanceof Date) return input.getTime();
  if (typeof input === 'number') return input;
  return Date.parse(input);
}

const dayMonth = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long' });
const dayMonthYear = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const clock = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const weekdayDayMonth = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** «16 октября», with the year when it differs from `now`. */
export function formatDate(input: TimeInput | null | undefined, now: TimeInput = Date.now()): string {
  if (input == null) return NO_DATA;
  const ms = toMs(input);
  if (Number.isNaN(ms)) return NO_DATA;
  const date = new Date(ms);
  const format = date.getFullYear() === new Date(toMs(now)).getFullYear() ? dayMonth : dayMonthYear;
  return format.format(date);
}

/** «14:05». */
export function formatClock(input: TimeInput | null | undefined): string {
  if (input == null) return NO_DATA;
  const ms = toMs(input);
  return Number.isNaN(ms) ? NO_DATA : clock.format(new Date(ms));
}

/** «16 октября, 14:05» (or «сегодня, 14:05» / «вчера, 14:05»). */
export function formatDateTime(input: TimeInput | null | undefined, now: TimeInput = Date.now()): string {
  if (input == null) return NO_DATA;
  const ms = toMs(input);
  if (Number.isNaN(ms)) return NO_DATA;
  const date = new Date(ms);
  const today = new Date(toMs(now));
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  let day = formatDate(ms, now);
  if (sameDay(date, today)) day = 'сегодня';
  else if (sameDay(date, yesterday)) day = 'вчера';
  return `${day}, ${clock.format(date)}`;
}

/**
 * Relative time for "checked/updated" labels:
 * «только что», «2 мин назад», «3 ч назад», «вчера», «12 октября».
 * Timestamps slightly in the future (clock skew) count as «только что».
 */
export function formatRelative(input: TimeInput | null | undefined, now: TimeInput = Date.now()): string {
  if (input == null) return NO_DATA;
  const ms = toMs(input);
  const nowMs = toMs(now);
  if (Number.isNaN(ms) || Number.isNaN(nowMs)) return NO_DATA;
  const diff = nowMs - ms;
  if (diff < -5 * 60_000) return formatDateTime(ms, nowMs);
  if (diff < 60_000) return 'только что';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}${NBSP}мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${NBSP}ч назад`;
  const today = new Date(nowMs);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(new Date(ms), yesterday)) return 'вчера';
  return formatDate(ms, nowMs);
}

/** «Пятница, 16 октября» — the date line under the greeting. */
export function formatLongDate(input: TimeInput): string {
  const text = weekdayDayMonth.format(new Date(toMs(input)));
  return text.charAt(0).toLocaleUpperCase(LOCALE) + text.slice(1);
}

/** «Свободно 1,7 ТБ из 1,8 ТБ». */
export function formatFreeOf(freeBytes: number | null, totalBytes: number | null): string {
  if (!isFiniteNumber(freeBytes) || !isFiniteNumber(totalBytes)) return NO_DATA;
  return `Свободно ${formatBytes(freeBytes)} из ${formatBytes(totalBytes)}`;
}

/** Share of used space, 0..100, or null when it cannot be computed. */
export function usedPercent(freeBytes: number | null, totalBytes: number | null): number | null {
  if (!isFiniteNumber(freeBytes) || !isFiniteNumber(totalBytes) || totalBytes <= 0) return null;
  const used = ((totalBytes - freeBytes) / totalBytes) * 100;
  return Math.min(100, Math.max(0, used));
}

/** «3 устройства». */
export function formatCount(n: number, one: string, few: string, many: string): string {
  return `${formatNumber(n)} ${pluralRu(n, one, few, many)}`;
}
