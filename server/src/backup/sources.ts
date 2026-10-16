import { type Dirent, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorCode } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';
import { BackupError, describeError, removeTree } from './files.ts';
import { createBundle } from './git.ts';

/** One file of a future snapshot: copied from disk or generated in memory. */
export type SourceEntry =
  | { readonly path: string; readonly kind: 'file'; readonly absPath: string; readonly size: number }
  | { readonly path: string; readonly kind: 'buffer'; readonly data: Buffer; readonly size: number };

export interface RepoInfo {
  ok: boolean;
  head?: string | null;
  refs?: string[];
  reason?: string;
}

export interface NetworkInfo {
  ok: boolean;
  reason?: string;
}

export interface CollectedSources {
  readonly entries: readonly SourceEntry[];
  readonly repo: RepoInfo;
  readonly network: NetworkInfo;
  /** Russian notes about parts that could not be saved (the backup itself still succeeds). */
  readonly warnings: readonly string[];
  readonly totalBytes: number;
  /** Removes the staging folder (git bundle). */
  cleanup(): Promise<void>;
}

export interface SourceSettings {
  readonly dataDir: string;
  /** Absolute paths, stored under config/. */
  readonly extraFiles: readonly string[];
  /** null → the code is not bundled. */
  readonly repoDir: string | null;
  readonly gitExe: string;
}

export interface SourceDeps {
  readonly clock: Clock;
  readonly appVersion: string;
  /** `tailscale serve status --json`, parsed; throws an Error with a Russian message. */
  readonly tailscaleServe: () => Promise<unknown>;
  /** Parent folder for the staging area. */
  readonly tempDir: string;
}

export const BUNDLE_PATH = 'repo.bundle';
export const TAILSCALE_SERVE_PATH = 'network/tailscale-serve.json';
export const SYSTEM_INFO_PATH = 'system-info.json';

/** Never backed up: live session tokens (useless after a restore) and the backup status itself. */
const EXCLUDED_DATA_FILES = new Set(['sessions.json', 'backup-status.json']);
const AUDIT_FILE_RE = /^audit(\.\d+)?\.jsonl$/;

export function isDataFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tmp') || EXCLUDED_DATA_FILES.has(lower)) return false;
  return AUDIT_FILE_RE.test(lower) || lower.endsWith('.json');
}

/** Top-level data files only (no logs/, run/ or other sub-folders; links are skipped). */
export async function listDataFiles(dataDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new BackupError(`Папка данных не найдена: ${dataDir}`);
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && isDataFileName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${name}-${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Gathers everything a snapshot contains. Data files are mandatory (a missing data folder fails the
 * backup); the code bundle, the Tailscale Serve config and extra files are best-effort: a failure is
 * recorded in the manifest and in `warnings` instead of failing the backup.
 */
export async function collectSources(settings: SourceSettings, deps: SourceDeps): Promise<CollectedSources> {
  const entries: SourceEntry[] = [];
  const warnings: string[] = [];

  for (const name of await listDataFiles(settings.dataDir)) {
    const absPath = path.join(settings.dataDir, name);
    const stats = await fsp.stat(absPath);
    entries.push({ path: `data/${name}`, kind: 'file', absPath, size: stats.size });
  }

  const usedConfigNames = new Set<string>();
  for (const file of settings.extraFiles) {
    try {
      const stats = await fsp.stat(file);
      if (!stats.isFile()) {
        warnings.push(`Не файл, пропущено: ${file}`);
        continue;
      }
      const name = uniqueName(path.basename(file), usedConfigNames);
      entries.push({ path: `config/${name}`, kind: 'file', absPath: file, size: stats.size });
    } catch (error) {
      warnings.push(
        errorCode(error) === 'ENOENT'
          ? `Файл настроек не найден: ${file}`
          : `Файл настроек не прочитан: ${describeError(error)}`,
      );
    }
  }

  let staging: string | null = null;
  const cleanup = async () => {
    if (staging !== null) await removeTree(staging, deps.tempDir).catch(() => undefined);
    staging = null;
  };

  try {
    let repo: RepoInfo;
    if (settings.repoDir === null) {
      repo = { ok: false, reason: 'Копирование кода отключено' };
    } else {
      await fsp.mkdir(deps.tempDir, { recursive: true });
      staging = await fsp.mkdtemp(path.join(deps.tempDir, 'family-backup-stage-'));
      const bundle = path.join(staging, 'repo.bundle');
      try {
        const info = await createBundle(settings.gitExe, settings.repoDir, bundle);
        const stats = await fsp.stat(bundle);
        entries.push({ path: BUNDLE_PATH, kind: 'file', absPath: bundle, size: stats.size });
        repo = { ok: true, head: info.head, refs: info.refs };
      } catch (error) {
        const reason = describeError(error);
        repo = { ok: false, reason };
        warnings.push(`Копия кода не создана: ${reason}`);
      }
    }

    let network: NetworkInfo;
    try {
      const data = jsonBuffer(await deps.tailscaleServe());
      entries.push({ path: TAILSCALE_SERVE_PATH, kind: 'buffer', data, size: data.length });
      network = { ok: true };
    } catch (error) {
      network = { ok: false, reason: describeError(error) };
    }

    const info = jsonBuffer({
      appVersion: deps.appVersion,
      node: process.version,
      createdAt: deps.clock().toISOString(),
      os: { platform: process.platform, version: os.version(), release: os.release() },
      hostname: os.hostname(),
    });
    entries.push({ path: SYSTEM_INFO_PATH, kind: 'buffer', data: info, size: info.length });

    return {
      entries,
      repo,
      network,
      warnings,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
