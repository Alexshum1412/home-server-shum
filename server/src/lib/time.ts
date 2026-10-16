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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
