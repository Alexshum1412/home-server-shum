import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { errorCode } from '../lib/json-store.ts';
import {
  BackupError,
  copyFileHashed,
  describeError,
  hashFile,
  isInsideOrSame,
  realpathOrSelf,
  removeTree,
} from './files.ts';
import { cloneBundle } from './git.ts';
import { listSnapshots } from './retention.ts';
import type { BackupDeps, BackupSettings } from './run.ts';
import { type Manifest, verifySnapshot } from './snapshot.ts';
import { BUNDLE_PATH } from './sources.ts';
import { recordRestoreTest } from './status.ts';
import { resolveTargets } from './targets.ts';

export interface RestoreOptions {
  gitExe: string;
  tempDir: string;
  /**
   * The portal's live data folder. A restore never writes there: the live data is replaced only by
   * hand, with the server stopped (see the backup CLI help / runbook).
   */
  liveDataDir: string;
  /** Clone repo.bundle into <dest>/repo when the snapshot has one. */
  cloneRepo: boolean;
}

export interface RestoreResult {
  dest: string;
  fileCount: number;
  sizeBytes: number;
  /** HEAD of the cloned code, or null when not cloned. */
  repoHead: string | null;
  /** Why the code could not be cloned (the data is restored regardless; repo.bundle is in dest). */
  repoError: string | null;
  manifest: Manifest;
  warnings: string[];
}

function toNative(relPath: string): string {
  return path.join(...relPath.split('/'));
}

async function assertRestoreDestination(
  dest: string,
  snapshotDir: string,
  liveDataDir: string,
): Promise<void> {
  const destReal = await realpathOrSelf(dest);
  for (const live of [path.resolve(liveDataDir), await realpathOrSelf(liveDataDir)]) {
    if (isInsideOrSame(dest, live) || isInsideOrSame(destReal, live)) {
      throw new BackupError(
        `Нельзя восстанавливать в рабочую папку данных портала (${live}). Восстановите в новую пустую папку, затем при остановленном сервере замените данные вручную.`,
      );
    }
  }
  if (isInsideOrSame(dest, snapshotDir) || isInsideOrSame(snapshotDir, dest)) {
    throw new BackupError('Папка для восстановления не может совпадать с папкой копии или содержать её');
  }
  let stats: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stats = await fsp.lstat(dest);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new BackupError(`${dest} уже существует и не является пустой папкой — выберите новую папку`);
  }
  if ((await fsp.readdir(dest)).length > 0) {
    throw new BackupError(`Папка ${dest} не пуста — выберите пустую или новую папку`);
  }
}

/**
 * Restores a snapshot into an empty (or new) folder: verifies the snapshot first, copies every listed
 * file keeping its relative layout (data/, config/, network/ …), re-reads the copies and compares
 * sha256, then optionally clones the code bundle into <dest>/repo.
 */
export async function restoreSnapshot(
  snapshotDir: string,
  destDir: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const snapshot = path.resolve(snapshotDir);
  const dest = path.resolve(destDir);
  await assertRestoreDestination(dest, snapshot, options.liveDataDir);

  const check = await verifySnapshot(snapshot, options);
  if (!check.ok || !check.manifest) {
    throw new BackupError(`Копия не прошла проверку: ${check.problems.join('; ')}`);
  }
  const manifest = check.manifest;
  const warnings = [...check.warnings];

  await fsp.mkdir(dest, { recursive: true });
  for (const file of manifest.files) {
    const digest = await copyFileHashed(
      path.join(snapshot, toNative(file.path)),
      path.join(dest, toNative(file.path)),
    );
    if (digest.size !== file.size || digest.sha256 !== file.sha256) {
      throw new BackupError(`Файл ${file.path} изменился во время восстановления`);
    }
  }
  // Re-read what was written: the copy must match the manifest byte for byte.
  const mismatched: string[] = [];
  for (const file of manifest.files) {
    const digest = await hashFile(path.join(dest, toNative(file.path)));
    if (digest.size !== file.size || digest.sha256 !== file.sha256) mismatched.push(file.path);
  }
  if (mismatched.length > 0) {
    throw new BackupError(`После восстановления файлы не совпадают с копией: ${mismatched.join(', ')}`);
  }

  let repoHead: string | null = null;
  let repoError: string | null = null;
  const hasBundle = manifest.files.some((file) => file.path === BUNDLE_PATH);
  if (options.cloneRepo && hasBundle) {
    try {
      repoHead = await cloneBundle(options.gitExe, path.join(dest, BUNDLE_PATH), path.join(dest, 'repo'));
    } catch (error) {
      // The data is already restored and verified; the bundle stays in dest for a later `git clone`.
      repoError = describeError(error);
      warnings.push(`Код не восстановлен из repo.bundle: ${repoError}`);
    }
  }
  return {
    dest,
    fileCount: manifest.files.length,
    sizeBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    repoHead,
    repoError,
    manifest,
    warnings,
  };
}

export interface RestoreTestTarget {
  name: string;
  root: string | null;
  snapshot: string | null;
  ok: boolean;
  repoHead: string | null;
  error: string | null;
}

export interface RestoreTestResult {
  ok: boolean;
  /** Set only when every target passed (also written to backup-status.json). */
  testedAt: string | null;
  targets: RestoreTestTarget[];
  warnings: string[];
}

/**
 * For every target: restore the newest snapshot into a fresh temp folder, verify every file, clone the
 * code bundle and compare HEAD with the manifest. Only a full pass records restoreTestedAt.
 * Temp folders are always removed.
 */
export async function testRestore(settings: BackupSettings, deps: BackupDeps): Promise<RestoreTestResult> {
  const targets: RestoreTestTarget[] = [];
  const warnings: string[] = [];
  await fsp.mkdir(deps.tempDir, { recursive: true });
  for (const target of await resolveTargets(settings.targets, deps)) {
    const row: RestoreTestTarget = {
      name: target.name,
      root: target.root,
      snapshot: null,
      ok: false,
      repoHead: null,
      error: null,
    };
    targets.push(row);
    if (target.root === null) {
      row.error = target.error;
      continue;
    }
    let scratch: string | null = null;
    try {
      const [newest] = await listSnapshots(target.root);
      if (!newest) throw new BackupError('Нет ни одной копии для проверки');
      row.snapshot = newest.name;
      scratch = await fsp.mkdtemp(path.join(deps.tempDir, 'family-restore-test-'));
      const restored = await restoreSnapshot(newest.dir, path.join(scratch, 'restore'), {
        gitExe: settings.gitExe,
        tempDir: deps.tempDir,
        liveDataDir: settings.dataDir,
        cloneRepo: true,
      });
      const repo = restored.manifest.repo;
      if (repo.ok && restored.repoError !== null) {
        throw new BackupError(`Код из копии не восстановлен: ${restored.repoError}`);
      }
      warnings.push(...restored.warnings.map((warning) => `${target.name}: ${warning}`));
      if (repo.ok) {
        if (!repo.head || restored.repoHead !== repo.head) {
          throw new BackupError(
            `Восстановленный код (${restored.repoHead ?? 'нет'}) не совпадает с копией (${repo.head ?? 'нет'})`,
          );
        }
      } else {
        warnings.push(`${target.name}: в копии нет кода (${repo.reason ?? 'причина не указана'})`);
      }
      row.repoHead = restored.repoHead;
      row.ok = true;
    } catch (error) {
      row.error = describeError(error);
    } finally {
      if (scratch !== null) await removeTree(scratch, deps.tempDir).catch(() => undefined);
    }
  }
  const ok = targets.length > 0 && targets.every((target) => target.ok);
  let testedAt: string | null = null;
  if (ok) {
    testedAt = deps.clock().toISOString();
    await recordRestoreTest(settings.dataDir, testedAt);
  }
  return { ok, testedAt, targets, warnings };
}
