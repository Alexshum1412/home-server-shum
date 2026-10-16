import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Clock } from '../lib/time.ts';
import { systemClock } from '../lib/time.ts';
import { readAppVersion } from '../lib/version.ts';
import { runTailscaleServeStatus } from '../system/tailscale.ts';
import { statVolume } from '../system/volumes.ts';
import { describeError } from './files.ts';
import { pushBranch } from './git.ts';
import { applyRetention, assertSafeTargetRoot } from './retention.ts';
import { createSnapshot } from './snapshot.ts';
import { type CollectedSources, collectSources, type SourceDeps, type SourceSettings } from './sources.ts';
import { type BackupTargetStatus, recordBackupRun } from './status.ts';
import {
  checkFreeSpace,
  defaultVolumeLister,
  type FreeSpaceProbe,
  type ResolveDeps,
  resolveTargets,
  type VolumeLister,
} from './targets.ts';

/** Mirror of the committed code to a remote branch (the GitHub copy). */
export interface GitPushSettings {
  readonly remote: string;
  readonly branch: string;
  /** Allowed remote URLs; default: a repository on https://github.com/ (tests use a local remote). */
  readonly allowedUrl?: RegExp | undefined;
}

export interface BackupSettings extends SourceSettings {
  /** Target specs, see backup/spec.ts. */
  readonly targets: readonly string[];
  readonly keep: number;
  /** null/undefined — no mirror. */
  readonly gitPush?: GitPushSettings | null;
}

export const MIRROR_NAME = 'GitHub (код)';

export interface BackupDeps extends SourceDeps, ResolveDeps {
  readonly clock: Clock;
  readonly listVolumes: VolumeLister;
  readonly statfs: FreeSpaceProbe;
}

export interface BackupRunResult {
  ok: boolean;
  at: string;
  targets: BackupTargetStatus[];
  warnings: string[];
}

/** Settings from the validated config; the project .env is included by default when it exists. */
export function backupSettingsFromConfig(config: Config): BackupSettings {
  const defaultEnv = path.join(config.backupRepoDir, '.env');
  return {
    dataDir: config.dataDir,
    targets: config.backupTargets,
    keep: config.backupKeep,
    repoDir: config.backupRepoDir,
    extraFiles: config.backupExtraFiles ?? (existsSync(defaultEnv) ? [defaultEnv] : []),
    gitExe: config.gitExe,
    gitPush: config.backupGitPush,
  };
}

export function defaultBackupDeps(config: Config, env: NodeJS.ProcessEnv = process.env): BackupDeps {
  const drive = env.SystemDrive ?? env.SYSTEMDRIVE ?? 'C:';
  return {
    clock: systemClock,
    appVersion: readAppVersion(),
    listVolumes: defaultVolumeLister,
    statfs: statVolume,
    tailscaleServe: () => runTailscaleServeStatus(config.tailscaleExe),
    tempDir: os.tmpdir(),
    systemDrive: /^[a-zA-Z]:$/.test(drive) ? drive.toUpperCase() : 'C:',
  };
}

function failed(name: string, root: string | null, error: string): BackupTargetStatus {
  return { name, root, ok: false, snapshot: null, sizeBytes: null, error };
}

/**
 * One backup run: sources are collected once, then every target is written independently (snapshot,
 * then retention). The run is ok only when every target is ok. The result is recorded in
 * backup-status.json in the data folder.
 */
export async function runBackup(settings: BackupSettings, deps: BackupDeps): Promise<BackupRunResult> {
  const startedAt = deps.clock();
  const at = startedAt.toISOString();
  // One run → one snapshot name (and createdAt) on every target.
  const runClock: Clock = () => new Date(startedAt.getTime());
  const resolved = await resolveTargets(settings.targets, deps);
  const targets: BackupTargetStatus[] = [];
  const warnings: string[] = [];

  let sources: CollectedSources | null = null;
  let sourceError = 'Источники копии не собраны';
  if (resolved.some((target) => target.root !== null)) {
    try {
      sources = await collectSources(settings, { ...deps, clock: runClock });
      warnings.push(...sources.warnings);
    } catch (error) {
      sourceError = describeError(error);
    }
  }

  try {
    for (const target of resolved) {
      if (target.root === null) {
        targets.push(failed(target.name, null, target.error));
        continue;
      }
      if (sources === null) {
        targets.push(failed(target.name, target.root, sourceError));
        continue;
      }
      try {
        await assertSafeTargetRoot(target.root, settings.dataDir);
        await fsp.mkdir(target.root, { recursive: true });
        // Again with the folder in place: its real path (junctions) is known only now.
        await assertSafeTargetRoot(target.root, settings.dataDir);
        await checkFreeSpace(target.root, sources.totalBytes, deps.statfs);
        const snapshot = await createSnapshot(target.root, sources, {
          clock: runClock,
          appVersion: deps.appVersion,
          gitExe: settings.gitExe,
          tempDir: deps.tempDir,
        });
        // The new snapshot is written and verified: a retention problem is only a remark.
        try {
          const retention = await applyRetention(target.root, {
            keep: settings.keep,
            dataDir: settings.dataDir,
            clock: deps.clock,
            protect: [snapshot.name],
          });
          warnings.push(...retention.errors.map((error) => `${target.name}: ${error}`));
        } catch (error) {
          warnings.push(`${target.name}: старые копии не удалены: ${describeError(error)}`);
        }
        targets.push({
          name: target.name,
          root: target.root,
          ok: true,
          snapshot: snapshot.name,
          sizeBytes: snapshot.sizeBytes,
          error: null,
        });
      } catch (error) {
        targets.push(failed(target.name, target.root, describeError(error)));
      }
    }
  } finally {
    await sources?.cleanup();
  }

  // The mirror holds only committed code (never family data). Its failure (no internet, login
  // expired, diverged history) is a remark: the family data is protected by the local copies.
  if (settings.gitPush && settings.repoDir) {
    try {
      const pushed = await pushBranch(
        settings.gitExe,
        settings.repoDir,
        settings.gitPush.remote,
        settings.gitPush.branch,
        settings.gitPush.allowedUrl,
      );
      targets.push({
        name: MIRROR_NAME,
        root: pushed.url,
        ok: true,
        snapshot: pushed.head.slice(0, 12),
        sizeBytes: null,
        error: null,
        optional: true,
      });
    } catch (error) {
      const reason = describeError(error);
      targets.push({
        name: MIRROR_NAME,
        root: null,
        ok: false,
        snapshot: null,
        sizeBytes: null,
        error: reason,
        optional: true,
      });
      warnings.push(`${MIRROR_NAME}: ${reason}`);
    }
  }

  const required = targets.filter((target) => !target.optional);
  const ok = required.length > 0 && required.every((target) => target.ok);
  await recordBackupRun(settings.dataDir, { at, ok, targets, warnings });
  return { ok, at, targets, warnings };
}
