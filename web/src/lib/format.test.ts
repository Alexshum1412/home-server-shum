import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatBytesPair,
  formatDuration,
  formatFreeOf,
  formatPercent,
  formatRelative,
  NBSP,
  NO_DATA,
  pluralRu,
  usedPercent,
} from './format.ts';

const KiB = 1024;
const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
/** A 2 TB drive as Windows reports it (2 000 398 934 016 bytes). */
const DISK_2TB = 2_000_398_934_016;

/** Writes a number–unit pair the way the helpers do: joined by a non-breaking space. */
function nb(value: string, unit: string): string {
  return `${value}${NBSP}${unit}`;
}

describe('formatBytes', () => {
  it('uses binary units like Windows Explorer, with a decimal comma', () => {
    expect(formatBytes(4_142_054_400)).toBe(nb('3,9', 'ГБ'));
    expect(formatBytes(GiB)).toBe(nb('1', 'ГБ'));
    expect(formatBytes(1536)).toBe(nb('1,5', 'КБ'));
    expect(formatBytes(15 * GiB)).toBe(nb('15', 'ГБ'));
  });

  it('shows plain bytes without decimals', () => {
    expect(formatBytes(0)).toBe(nb('0', 'Б'));
    expect(formatBytes(512)).toBe(nb('512', 'Б'));
    expect(formatBytes(999)).toBe(nb('999', 'Б'));
  });

  it('switches to the next unit at 1000 so a value never reads «1 010 МБ»', () => {
    expect(formatBytes(1000)).toBe(nb('0,98', 'КБ'));
    expect(formatBytes(KiB)).toBe(nb('1', 'КБ'));
    expect(formatBytes(1000 * GiB)).toBe(nb('0,98', 'ТБ'));
  });

  it('gives terabytes below 10 two decimals', () => {
    expect(formatBytes(DISK_2TB)).toBe(nb('1,82', 'ТБ'));
    expect(formatBytes(1.78 * TiB)).toBe(nb('1,78', 'ТБ'));
    expect(formatBytes(12.5 * TiB)).toBe(nb('13', 'ТБ'));
  });

  it('adds requested precision, capped at three decimals', () => {
    expect(formatBytes(4_142_054_400, 1)).toBe(nb('3,86', 'ГБ'));
    expect(formatBytes(4_142_054_400, 10)).toBe(nb('3,858', 'ГБ'));
  });

  it('renders missing or invalid input as «Нет данных», never as 0', () => {
    expect(formatBytes(null)).toBe(NO_DATA);
    expect(formatBytes(undefined)).toBe(NO_DATA);
    expect(formatBytes(Number.NaN)).toBe(NO_DATA);
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe(NO_DATA);
    expect(formatBytes(-1)).toBe(NO_DATA);
  });
});

describe('formatBytesPair and formatFreeOf', () => {
  it('never shows «1,8 ТБ из 1,8 ТБ» for a nearly empty 2 TB disk', () => {
    expect(formatFreeOf(1.78 * TiB, DISK_2TB)).toBe(`Свободно ${nb('1,78', 'ТБ')} из ${nb('1,82', 'ТБ')}`);
    const [free, total] = formatBytesPair(1.81 * TiB, DISK_2TB);
    expect(free).not.toBe(total);
  });

  it('adds decimals only while two different values would read the same', () => {
    expect(formatBytesPair(3.86 * GiB, 3.9 * GiB)).toEqual([nb('3,86', 'ГБ'), nb('3,9', 'ГБ')]);
    expect(formatBytesPair(930.2 * GiB, 930.4 * GiB)).toEqual([nb('930,2', 'ГБ'), nb('930,4', 'ГБ')]);
    expect(formatBytesPair(2 * GiB, 16 * GiB)).toEqual([nb('2', 'ГБ'), nb('16', 'ГБ')]);
  });

  it('keeps equal values as they are', () => {
    expect(formatBytesPair(4 * GiB, 4 * GiB)).toEqual([nb('4', 'ГБ'), nb('4', 'ГБ')]);
  });

  it('passes missing values through as «Нет данных»', () => {
    expect(formatBytesPair(null, 4 * GiB)).toEqual([NO_DATA, nb('4', 'ГБ')]);
    expect(formatFreeOf(null, DISK_2TB)).toBe(NO_DATA);
    expect(formatFreeOf(1024, null)).toBe(NO_DATA);
  });
});

describe('formatPercent and usedPercent', () => {
  it('rounds to whole percent with a non-breaking space', () => {
    expect(formatPercent(23.4)).toBe(nb('23', '%'));
    expect(formatPercent(99.6)).toBe(nb('100', '%'));
    expect(formatPercent(0)).toBe(nb('0', '%'));
  });

  it('renders missing values as «Нет данных»', () => {
    expect(formatPercent(null)).toBe(NO_DATA);
    expect(formatPercent(undefined)).toBe(NO_DATA);
    expect(formatPercent(Number.NaN)).toBe(NO_DATA);
  });

  it('computes used space and refuses impossible totals', () => {
    expect(usedPercent(25, 100)).toBe(75);
    expect(usedPercent(150, 100)).toBe(0);
    expect(usedPercent(10, 0)).toBeNull();
    expect(usedPercent(null, 100)).toBeNull();
  });
});

describe('formatRelative', () => {
  const now = new Date(2026, 9, 16, 23, 0, 0);
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MIN = 60_000;

  it('says «только что» within the first minute and for small clock skew', () => {
    expect(formatRelative(ago(30_000), now)).toBe('только что');
    expect(formatRelative(ago(-2 * MIN), now)).toBe('только что');
  });

  it('counts minutes and hours', () => {
    expect(formatRelative(ago(5 * MIN), now)).toBe(nb('5', 'мин назад'));
    expect(formatRelative(ago(59 * MIN), now)).toBe(nb('59', 'мин назад'));
    expect(formatRelative(ago(3 * 60 * MIN), now)).toBe(nb('3', 'ч назад'));
  });

  it('says «вчера» for the previous calendar day after 24 hours', () => {
    expect(formatRelative(new Date(2026, 9, 15, 22, 0), now)).toBe('вчера');
  });

  it('falls back to a date for older values', () => {
    expect(formatRelative(new Date(2026, 9, 12, 10, 0), now).replace(/\s/g, ' ')).toBe('12 октября');
  });

  it('accepts ISO strings and renders invalid input as «Нет данных»', () => {
    expect(formatRelative(ago(10 * MIN).toISOString(), now)).toBe(nb('10', 'мин назад'));
    expect(formatRelative(null, now)).toBe(NO_DATA);
    expect(formatRelative('not a date', now)).toBe(NO_DATA);
  });
});

describe('formatDuration', () => {
  it('formats uptime in days, hours and minutes', () => {
    expect(formatDuration(30)).toBe('меньше минуты');
    expect(formatDuration(120)).toBe(nb('2', 'мин'));
    expect(formatDuration(3600)).toBe(nb('1', 'ч'));
    expect(formatDuration(3720)).toBe(`${nb('1', 'ч')} ${nb('2', 'мин')}`);
    expect(formatDuration(86_400)).toBe(nb('1', 'дн'));
    expect(formatDuration(446_400)).toBe(`${nb('5', 'дн')} ${nb('4', 'ч')}`);
  });

  it('renders missing or negative values as «Нет данных»', () => {
    expect(formatDuration(null)).toBe(NO_DATA);
    expect(formatDuration(-5)).toBe(NO_DATA);
  });
});

describe('pluralRu', () => {
  it('picks the Russian plural form', () => {
    const forms = ['ядро', 'ядра', 'ядер'] as const;
    expect(pluralRu(1, ...forms)).toBe('ядро');
    expect(pluralRu(3, ...forms)).toBe('ядра');
    expect(pluralRu(5, ...forms)).toBe('ядер');
    expect(pluralRu(11, ...forms)).toBe('ядер');
    expect(pluralRu(21, ...forms)).toBe('ядро');
    expect(pluralRu(112, ...forms)).toBe('ядер');
  });
});
