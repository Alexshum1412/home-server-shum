import { type Dirent, promises as fsp } from 'node:fs';
import path from 'node:path';
import { errorCode } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';
import {
  BackupError,
  describeError,
  isDriveRoot,
  isInsideOrSame,
  realpathOrSelf,
  removeTree,
} from './files.ts';
import { MANIFEST_FILE, PARTIAL_RE, SNAPSHOT_RE } from './snapshot.ts';

/** An abandoned ".partial" folder older than this is removed (a running backup touches it constantly). */
export const STALE_PARTIAL_MS = 24 * 60 * 60 * 1000;

export interface SnapshotEntry {
  name: string;
  dir: string;
}

/** Sort key: the UTC time in the name, then the collision suffix (-2 < -10). */
function snapshotKey(name: string): [string, number] {
  const match = /^family-backup-(\d{8}-\d{6})(?:-(\d+))?$/.exec(name);
  return [match?.[1] ?? '', match?.[2] ? Number(match[2]) : 1];
}

/** Newest first. */
export function compareSnapshotsNewestFirst(a: string, b: string): number {
  const [timeA, nA] = snapshotKey(a);
  const [timeB, nB] = snapshotKey(b);
  if (timeA !== timeB) return timeA < timeB ? 1 : -1;
  return nB - nA;
}

async function readEntries(root: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Complete snapshots in a target root, newest first: real folders (not links) named
 * family-backup-YYYYMMDD-HHMMSS[-N] that contain manifest.json.
 */
export async function listSnapshots(root: string): Promise<SnapshotEntry[]> {
  const found: SnapshotEntry[] = [];
  for (const entry of await readEntries(root)) {
    if (!entry.isDirectory() || !SNAPSHOT_RE.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const manifest = await fsp.lstat(path.join(dir, MANIFEST_FILE)).catch(() => null);
    if (manifest?.isFile()) found.push({ name: entry.name, dir });
  }
  return found.sort((a, b) => compareSnapshotsNewestFirst(a.name, b.name));
}

/**
 * Backups never go to a drive root (retention would then scan a whole disk) and never into the live
 * data folder. Checked on the path as given and on its real path (junctions resolved).
 */
export async function assertSafeTargetRoot(root: string, dataDir: string): Promise<void> {
  const resolved = path.resolve(root);
  const candidates = [resolved, await realpathOrSelf(resolved)];
  const dataDirs = [path.resolve(dataDir), await realpathOrSelf(dataDir)];
  for (const candidate of candidates) {
    if (isDriveRoot(candidate)) {
      throw new BackupError(
        `Папка для копий не может быть корнем диска (${resolved}): укажите вложенную папку`,
      );
    }
    if (dataDirs.some((data) => isInsideOrSame(candidate, data))) {
      throw new BackupError(`Папка для копий не может находиться в папке данных портала (${resolved})`);
    }
  }
}

export interface RetentionOptions {
  keep: number;
  dataDir: string;
  clock: Clock;
  /** Never deleted, whatever their names sort like (the snapshot this run just wrote). */
  protect?: readonly string[];
}

export interface RetentionResult {
  /** Newest first. */
  kept: string[];
  removed: string[];
  removedPartials: string[];
  /** Russian descriptions of deletions that failed (the rest still ran). */
  errors: string[];
}

/**
 * Keeps the newest `keep` complete snapshots and deletes older ones, plus ".partial" folders older than
 * 24 hours. Nothing else in the root is touched; links are never followed.
 */
export async function applyRetention(
  targetRoot: string,
  options: RetentionOptions,
): Promise<RetentionResult> {
  const root = path.resolve(targetRoot);
  await assertSafeTargetRoot(root, options.dataDir);
  if (!Number.isInteger(options.keep) || options.keep < 1) {
    throw new BackupError('Нужно хранить хотя бы одну копию (BACKUP_KEEP ≥ 1)');
  }
  const result: RetentionResult = { kept: [], removed: [], removedPartials: [], errors: [] };
  const snapshots = await listSnapshots(root);
  const protectedNames = new Set(options.protect ?? []);
  for (const [index, snapshot] of snapshots.entries()) {
    if (index < options.keep || protectedNames.has(snapshot.name)) {
      result.kept.push(snapshot.name);
      continue;
    }
    try {
      await removeTree(snapshot.dir, root);
      result.removed.push(snapshot.name);
    } catch (error) {
      result.errors.push(`Не удалось удалить старую копию ${snapshot.name}: ${describeError(error)}`);
    }
  }

  const now = options.clock().getTime();
  for (const entry of await readEntries(root)) {
    if (!entry.isDirectory() || !PARTIAL_RE.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      const stats = await fsp.lstat(dir);
      if (now - stats.mtimeMs <= STALE_PARTIAL_MS) continue;
      await removeTree(dir, root);
      result.removedPartials.push(entry.name);
    } catch (error) {
      result.errors.push(`Не удалось удалить незавершённую копию ${entry.name}: ${describeError(error)}`);
    }
  }
  return result;
}
