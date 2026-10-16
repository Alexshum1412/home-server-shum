import { promises as fsp } from 'node:fs';
import type { VolumeInfo } from '../../../shared/api.ts';

export interface VolumeSpace {
  totalBytes: number;
  freeBytes: number;
}

/** fs.statfs: free = blocks available to the (unprivileged) user. */
export async function statVolume(volumePath: string): Promise<VolumeSpace> {
  const stats = await fsp.statfs(volumePath);
  return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
}

export function pendingVolume(volumePath: string, reason: string): VolumeInfo {
  return { path: volumePath, totalBytes: null, freeBytes: null, collectedAt: null, reason, lowSpace: false };
}

export function freePercent(volume: VolumeInfo): number | null {
  if (volume.totalBytes === null || volume.freeBytes === null || volume.totalBytes <= 0) return null;
  return (volume.freeBytes / volume.totalBytes) * 100;
}

/** Builds a VolumeInfo from a measurement; lowSpace when free% < threshold. */
export function toVolumeInfo(
  volumePath: string,
  space: VolumeSpace,
  at: Date,
  lowSpacePercent: number,
): VolumeInfo {
  const info: VolumeInfo = {
    path: volumePath,
    totalBytes: space.totalBytes,
    freeBytes: space.freeBytes,
    collectedAt: at.toISOString(),
    reason: null,
    lowSpace: false,
  };
  const percent = freePercent(info);
  info.lowSpace = percent !== null && percent < lowSpacePercent;
  return info;
}
