import { existsSync, promises as fsp, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Clock } from '../lib/time.ts';
import { systemClock } from '../lib/time.ts';
import { readAppVersion } from '../lib/version.ts';
import { jellyfinPaths } from '../supervisor/apps.ts';
import { pipeNameFor, type SupervisorState, sendCommand } from '../supervisor/main.ts';
import { runTailscaleServeStatus } from '../system/tailscale.ts';
import { statVolume } from '../system/volumes.ts';
import { describeError } from './files.ts';
import { pushBranch } from './git.ts';
import { type OffsiteSettings, runOffsiteIfDue } from './offsite.ts';
import { applyRetention, assertSafeTargetRoot, listSnapshots } from './retention.ts';
import { createSnapshot, estimateNewBytes } from './snapshot.ts';
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
  /** null/undefined — no encrypted copy for outside the house. */
  readonly offsite?: OffsiteSettings | null;
}

export const MIRROR_NAME = 'GitHub (код)';
export const OFFSITE_NAME = 'Зашифрованная копия вне дома';
type OffsiteStatusPatch = NonNullable<Parameters<typeof recordBackupRun>[1]['offsite']>;

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

/** The owner's private instructions (a private folder, never in Git) travel with every backup next to .env. */
export function privateDocFiles(repoDir: string): string[] {
  const dir = path.join(repoDir, 'docs', 'private');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** Settings from the validated config; the project .env is included by default when it exists. */
export function backupSettingsFromConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): BackupSettings {
  const defaultEnv = path.join(config.backupRepoDir, '.env');
  const drive = env.SystemDrive ?? env.SYSTEMDRIVE ?? 'C:';
  const mediaRoot = env.MEDIA_ROOT?.trim() || path.join(`${drive}${path.sep}`, 'FamilyData', 'Media');
  return {
    familyTrees: [
      { prefix: 'family/files', dir: config.filesDir },
      { prefix: 'family/photos', dir: config.photosDir },
      { prefix: 'family/chat', dir: config.chatDir },
      // Films and series can be found again; home videos cannot.
      { prefix: 'family/home-video', dir: path.join(mediaRoot, 'Домашнее видео') },
    ],
    jellyfinDataRoot: jellyfinPaths(env, config).dataRoot,
    dataDir: config.dataDir,
    targets: config.backupTargets,
    keep: config.backupKeep,
    repoDir: config.backupRepoDir,
    extraFiles: config.backupExtraFiles ?? [
      ...(existsSync(defaultEnv) ? [defaultEnv] : []),
      ...privateDocFiles(config.backupRepoDir),
    ],
    gitExe: config.gitExe,
    gitPush: config.backupGitPush,
    offsite:
      config.backupOffsiteDir === null
        ? null
        : {
            dir: config.backupOffsiteDir,
            keyFile: config.backupKeyFile,
            keep: config.backupOffsiteKeep,
            everyDays: config.backupOffsiteEveryDays,
          },
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
    pauseService: async (name) => {
      const pipe = pipeNameFor(config.dataDir);
      const status = (await sendCommand(pipe, { cmd: 'status' }, 5000).catch(() => null)) as {
        state?: SupervisorState;
      } | null;
      const app = status?.state?.apps.find((a) => a.name === name);
      if (app?.state !== 'running') return null;
      const stopped = (await sendCommand(pipe, { cmd: 'stop', app: name }, 90_000)) as { ok?: boolean };
      if (!stopped.ok) throw new Error('супервизор не остановил программу');
      return async () => {
        await sendCommand(pipe, { cmd: 'start', app: name }, 60_000);
      };
    },
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
        await checkFreeSpace(target.root, await estimateNewBytes(target.root, sources), deps.statfs);
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
        // How much room is left and how many copies are there: the status page warns before the disk is full.
        const space = await deps.statfs(target.root).catch(() => null);
        const held = await listSnapshots(target.root).catch(() => null);
        targets.push({
          name: target.name,
          root: target.root,
          ok: true,
          snapshot: snapshot.name,
          sizeBytes: snapshot.sizeBytes,
          error: null,
          freeBytes: space?.freeBytes ?? null,
          totalBytes: space?.totalBytes ?? null,
          snapshots: held?.length ?? null,
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

  // The encrypted copy for outside the house (only when the owner set a folder for it). It never blocks the
  // local copies and its failure is a remark: the family data is already safe at home.
  let offsitePatch: Partial<OffsiteStatusPatch> | null = null;
  if (settings.offsite) {
    const okTarget = targets.find(
      (target) => target.ok && !target.optional && target.root && target.snapshot,
    );
    if (!okTarget?.root || !okTarget.snapshot) {
      warnings.push(`${OFFSITE_NAME}: пропущена, потому что нет свежей локальной копии`);
    } else {
      const outcome = await runOffsiteIfDue(path.join(okTarget.root, okTarget.snapshot), settings.offsite, {
        clock: deps.clock,
        statfs: deps.statfs,
        dataDir: settings.dataDir,
        gitExe: settings.gitExe,
        tempDir: deps.tempDir,
      });
      if (outcome.ran) {
        targets.push({
          name: OFFSITE_NAME,
          root: settings.offsite.dir,
          ok: outcome.ok,
          snapshot: outcome.pack?.snapshot ?? null,
          sizeBytes: outcome.pack?.sizeBytes ?? null,
          error: outcome.ok ? null : outcome.message,
          optional: true,
        });
        if (outcome.ok && outcome.pack) {
          const verifiedAt = deps.clock().toISOString();
          offsitePatch = {
            configured: true,
            lastPackAt: verifiedAt,
            lastFile: outcome.pack.name,
            sizeBytes: outcome.pack.sizeBytes,
            verifiedAt,
            error: null,
          };
        } else {
          offsitePatch = { configured: true, error: outcome.message };
          warnings.push(`${OFFSITE_NAME}: ${outcome.message}`);
        }
      } else {
        offsitePatch = { configured: true, error: null };
      }
    }
  } else {
    offsitePatch = null;
  }

  const required = targets.filter((target) => !target.optional);
  const ok = required.length > 0 && required.every((target) => target.ok);
  await recordBackupRun(settings.dataDir, { at, ok, targets, warnings, offsite: offsitePatch });
  return { ok, at, targets, warnings };
}
