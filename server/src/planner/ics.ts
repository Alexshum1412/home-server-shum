/**
 * The calendar as an .ics file (RFC 5545): the second way to carry the family's plans to a phone or
 * a computer calendar, or to print them. Times are «floating» (no zone): they show at the same
 * wall-clock time wherever the file is opened.
 */
import type { CalendarEventView } from '../../../shared/api.ts';
import { addDays } from './dates.ts';

const compactDate = (date: string) => date.replace(/-/g, '');
const compactTime = (time: string) => `${time.replace(':', '')}00`;

export function escapeText(value: string): string {
  return (
    value
      // Any kind of line break becomes one «\n»; other control characters are dropped, so a title can
      // never start a new property in the file.
      .replace(/\r\n|\r|\n|\u2028|\u2029/g, '\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
  );
}

/** Lines longer than 75 octets are folded (RFC 5545 §3.1) without cutting a UTF-8 character. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function stamp(iso: string): string {
  return `${iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

const RRULE = { weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY' } as const;

export function toIcs(events: readonly CalendarEventView[], calendarName = 'Семейный календарь'): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Server//Calendar//RU',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const event of events) {
    lines.push('BEGIN:VEVENT', `UID:${event.id}@family-server`, `DTSTAMP:${stamp(event.updatedAt)}`);
    if (event.time === null) {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(event.date)}`);
      // The end of an all-day event is exclusive: the day after the last one.
      lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(event.endDate ?? event.date, 1))}`);
    } else {
      lines.push(`DTSTART:${compactDate(event.date)}T${compactTime(event.time)}`);
      if (event.endTime)
        lines.push(`DTEND:${compactDate(event.endDate ?? event.date)}T${compactTime(event.endTime)}`);
    }
    if (event.repeat !== 'none') lines.push(`RRULE:${RRULE[event.repeat]}`);
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.note) lines.push(`DESCRIPTION:${escapeText(event.note)}`);
    if (event.private) lines.push('CLASS:PRIVATE');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
