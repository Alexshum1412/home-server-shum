/**
 * One line about free space for the home page, built from every monitored volume
 * (not just the first one). Pure, unit-tested.
 */
import type { VolumeInfo } from '../../../shared/api.ts';
import { formatBytesPair, formatFreeOf } from './format.ts';
import { LOW_SPACE, SPACE_OK, type StatusView, UNKNOWN } from './labels.ts';

export interface DiskSummary {
  status: StatusView;
  detail: string;
}

function measured(volume: VolumeInfo): boolean {
  return volume.totalBytes != null && volume.freeBytes != null;
}

/** Share of free space, 0..1; volumes without numbers sort last. */
function freeShare(volume: VolumeInfo): number {
  if (volume.totalBytes == null || volume.freeBytes == null || volume.totalBytes <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return volume.freeBytes / volume.totalBytes;
}

/** The volume with the smallest share of free space. */
function fullest(volumes: readonly VolumeInfo[]): VolumeInfo | undefined {
  return [...volumes].sort((a, b) => freeShare(a) - freeShare(b))[0];
}

function freeText(volume: VolumeInfo): string {
  return measured(volume)
    ? `${formatFreeOf(volume.freeBytes, volume.totalBytes)} (${volume.path})`
    : `Диск ${volume.path}`;
}

/**
 * Low space on any volume wins (with that volume's numbers); otherwise a volume that
 * could not be read makes the row «Нет данных» with its reason; otherwise all is fine
 * and, when there are several volumes, the fullest one is named.
 */
export function summarizeVolumes(volumes: readonly VolumeInfo[]): DiskSummary {
  const tightest = fullest(volumes);
  if (!tightest) return { status: UNKNOWN, detail: 'Диски для контроля не указаны.' };

  const low = fullest(volumes.filter((volume) => volume.lowSpace));
  if (low) return { status: LOW_SPACE, detail: freeText(low) };

  const unread = volumes.find((volume) => !measured(volume));
  if (unread) {
    const reason = unread.reason ?? 'Объём диска не удалось прочитать.';
    return { status: UNKNOWN, detail: volumes.length > 1 ? `${reason} (${unread.path})` : reason };
  }

  if (volumes.length === 1) return { status: SPACE_OK, detail: freeText(tightest) };
  const [free, total] = formatBytesPair(tightest.freeBytes, tightest.totalBytes);
  return {
    status: SPACE_OK,
    detail: `На всех дисках достаточно места. Меньше всего свободно на ${tightest.path}: ${free} из ${total}`,
  };
}
