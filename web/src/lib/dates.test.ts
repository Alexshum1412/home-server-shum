import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dayLabel,
  gridDays,
  isDay,
  isMonth,
  monthLabel,
  monthOf,
  todayLocal,
} from './dates.ts';

describe('calendar dates in the browser', () => {
  it('takes today from the device clock as a plain date', () => {
    expect(todayLocal(new Date(2026, 9, 17, 23, 59))).toBe('2026-10-17');
    expect(todayLocal(new Date(2027, 0, 1, 0, 0))).toBe('2027-01-01');
  });

  it('moves over month and year borders', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthOf('2026-10-17')).toBe('2026-10');
  });

  it('recognises valid months and days only', () => {
    expect(isMonth('2026-10')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('x')).toBe(false);
  });

  it('fills six weeks starting on Monday', () => {
    const days = gridDays('2026-10'); // 1 October 2026 is a Thursday
    expect(days).toHaveLength(42);
    expect(days[0]).toBe('2026-09-28');
    expect(days[3]).toBe('2026-10-01');
    expect(days[41]).toBe('2026-11-08');
    expect(gridDays('2026-06')[0]).toBe('2026-06-01'); // 1 June 2026 is a Monday
  });

  it('writes dates in Russian', () => {
    expect(monthLabel('2026-10')).toBe('октябрь 2026 г.');
    expect(dayLabel('2026-10-17')).toBe('суббота, 17 октября');
  });
});
