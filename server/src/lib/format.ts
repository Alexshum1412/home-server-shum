/** Server-side formatting of numbers for Russian text (alerts, disk notes, probe reasons). */

const BYTE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'] as const;

const formats = new Map<number, Intl.NumberFormat>();

function formatNumber(value: number, fractionDigits: number): string {
  let format = formats.get(fractionDigits);
  if (!format) {
    format = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: fractionDigits });
    formats.set(fractionDigits, format);
  }
  return format.format(value);
}

/**
 * Human-readable size in BINARY units, as Windows Explorer shows them (1 ГБ = 1024³ bytes),
 * with a Russian decimal comma: 4142054400 → "3,9 ГБ", 2000398934016 → "1,8 ТБ".
 * Like Explorer, a value switches to the next unit once it reaches 1000, so at most three
 * integer digits are shown. Same rules as formatBytes in web/src/lib/format.ts, so alert texts
 * match the numbers on the dashboard.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'нет данных';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 1 ? 2 : value < 10 ? 1 : 0;
  return `${formatNumber(value, digits)} ${BYTE_UNITS[unit]}`;
}
