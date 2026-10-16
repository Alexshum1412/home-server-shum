import { describe, expect, it } from 'vitest';
import type { VolumeInfo } from '../../../shared/api.ts';
import { summarizeVolumes } from './disks.ts';
import { NBSP } from './format.ts';
import { LOW_SPACE, SPACE_OK, UNKNOWN } from './labels.ts';

const GB = 1024 ** 3;
/** «60 ГБ» as the formatter writes it (non-breaking space). */
const gb = (n: number) => `${n}${NBSP}ГБ`;

function volume(overrides: Partial<VolumeInfo>): VolumeInfo {
  return {
    path: 'C:\\',
    totalBytes: 100 * GB,
    freeBytes: 60 * GB,
    collectedAt: '2026-10-16T10:00:00.000Z',
    reason: null,
    lowSpace: false,
    ...overrides,
  };
}

describe('summarizeVolumes', () => {
  it('says when no disks are monitored', () => {
    expect(summarizeVolumes([])).toEqual({ status: UNKNOWN, detail: 'Диски для контроля не указаны.' });
  });

  it('one healthy disk: its free space and path', () => {
    const summary = summarizeVolumes([volume({})]);
    expect(summary.status).toBe(SPACE_OK);
    expect(summary.detail).toBe(`Свободно ${gb(60)} из ${gb(100)} (C:\\)`);
  });

  it('low space on any disk wins, with that disk’s numbers', () => {
    const summary = summarizeVolumes([
      volume({ path: 'C:\\' }),
      volume({ path: 'D:\\', freeBytes: 4 * GB, lowSpace: true }),
    ]);
    expect(summary.status).toBe(LOW_SPACE);
    expect(summary.detail).toBe(`Свободно ${gb(4)} из ${gb(100)} (D:\\)`);
  });

  it('several low disks: names the fullest one', () => {
    const summary = summarizeVolumes([
      volume({ path: 'D:\\', freeBytes: 8 * GB, lowSpace: true }),
      volume({ path: 'E:\\', freeBytes: 2 * GB, lowSpace: true }),
    ]);
    expect(summary.detail).toContain('E:\\');
  });

  it('low space still wins over a disk that could not be read', () => {
    const summary = summarizeVolumes([
      volume({ path: 'C:\\', totalBytes: null, freeBytes: null, reason: 'Диск не найден' }),
      volume({ path: 'D:\\', freeBytes: 4 * GB, lowSpace: true }),
    ]);
    expect(summary.status).toBe(LOW_SPACE);
  });

  it('a disk that could not be read makes the row «Нет данных» with its reason', () => {
    const summary = summarizeVolumes([
      volume({ path: 'C:\\' }),
      volume({ path: 'D:\\', totalBytes: null, freeBytes: null, reason: 'Диск не найден' }),
    ]);
    expect(summary.status).toBe(UNKNOWN);
    expect(summary.detail).toBe('Диск не найден (D:\\)');
  });

  it('one unreadable disk: just the reason', () => {
    const summary = summarizeVolumes([
      volume({ totalBytes: null, freeBytes: null, reason: 'Ещё не измерено' }),
    ]);
    expect(summary).toEqual({ status: UNKNOWN, detail: 'Ещё не измерено' });
  });

  it('several healthy disks: says all are fine and names the fullest', () => {
    const summary = summarizeVolumes([
      volume({ path: 'C:\\', freeBytes: 70 * GB }),
      volume({ path: 'D:\\', freeBytes: 30 * GB }),
    ]);
    expect(summary.status).toBe(SPACE_OK);
    expect(summary.detail).toBe(
      `На всех дисках достаточно места. Меньше всего свободно на D:\\: ${gb(30)} из ${gb(100)}`,
    );
  });
});
