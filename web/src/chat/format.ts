/** Time and text helpers of the chat (no DOM access; unit-tested). */

const clock = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dayMonthYear = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : clock.format(date);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** «Сегодня», «Вчера», «17 октября» (with the year when it is not this year). */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return 'Сегодня';
  if (diffDays === 1) return 'Вчера';
  return (date.getFullYear() === now.getFullYear() ? dayMonth : dayMonthYear).format(date);
}

/** Same calendar day on this device. */
export function sameDay(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return startOfDay(x) === startOfDay(y);
}

/** The time in the conversation list: the clock for today, otherwise the day. */
export function listTime(iso: string, now = new Date()): string {
  const label = dayLabel(iso, now);
  return label === 'Сегодня' ? formatClock(iso) : label;
}

/** «МС» from «Мама Света»; one letter for one word; «?» for nothing. */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return '?';
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '');
  return letters.join('').toLocaleUpperCase('ru-RU');
}

/** A stable hue (0–359) per person, so everybody keeps their colour. */
export function hueOf(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]}»”]+$/;

/** Splits a message into plain text and links. Only http(s) addresses become links. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const trimmed = raw.replace(TRAILING, '');
    let href: string | null = null;
    try {
      const url = new URL(trimmed);
      href = url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      href = null;
    }
    if (!href) continue;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'link', text: trimmed, href });
    last = start + trimmed.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
