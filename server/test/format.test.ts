import { describe, expect, it } from 'vitest';
import { formatBytes } from '../src/lib/format.ts';

const GiB = 1024 ** 3;

describe('formatBytes (binary units, Russian decimal comma)', () => {
  it('matches what Windows Explorer shows for the disks in this PC', () => {
    expect(formatBytes(4_142_054_400)).toBe('3,9 ГБ');
    expect(formatBytes(2_000_398_934_016)).toBe('1,8 ТБ');
    expect(formatBytes(15_955_132_416)).toBe('15 ГБ');
  });

  it('uses 1024-based steps and switches unit at 1000 like Explorer', () => {
    expect(formatBytes(0)).toBe('0 Б');
    expect(formatBytes(999)).toBe('999 Б');
    expect(formatBytes(1536)).toBe('1,5 КБ');
    expect(formatBytes(GiB)).toBe('1 ГБ');
    expect(formatBytes(1.5 * GiB)).toBe('1,5 ГБ');
    expect(formatBytes(250 * GiB)).toBe('250 ГБ');
    expect(formatBytes(1000 * GiB)).toBe('0,98 ТБ');
  });

  it('never prints a negative or non-finite size as a number', () => {
    expect(formatBytes(-1)).toBe('нет данных');
    expect(formatBytes(Number.NaN)).toBe('нет данных');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('нет данных');
  });
});
