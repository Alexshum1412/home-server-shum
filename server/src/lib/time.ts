/** Injectable clock: tests pass a fake one, production uses the system time. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function isoNow(clock: Clock): string {
  return clock().toISOString();
}

const decimalFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

/** 3000 → "3", 1500 → "1,5" (Russian decimal comma). */
export function formatSeconds(ms: number): string {
  return decimalFormat.format(ms / 1000);
}

/** Whole minutes for a "try again in N min" message, never less than 1. */
export function ceilMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

const BYTE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];

/** Human-readable decimal size, e.g. 4142054400 → "4,1 ГБ". */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${decimalFormat.format(value)} ${BYTE_UNITS[unit]}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
