import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { errorCode, renameWithRetry, stripBom } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';
import {
  BackupError,
  copyFileHashed,
  describeError,
  type FileDigest,
  hashFile,
  listTree,
  pathExists,
  removeTree,
  writeFileSynced,
} from './files.ts';
import { GitError, verifyBundle } from './git.ts';
import { BUNDLE_PATH, type CollectedSources } from './sources.ts';

export const SNAPSHOT_PREFIX = 'family-backup-';
/** A complete snapshot folder: family-backup-YYYYMMDD-HHMMSS[-N] (UTC time). */
export const SNAPSHOT_RE = /^family-backup-\d{8}-\d{6}(-\d+)?$/;
/** A snapshot being written (or abandoned by a crash). */
export const PARTIAL_RE = /^family-backup-\d{8}-\d{6}(-\d+)?\.partial$/;
export const PARTIAL_SUFFIX = '.partial';
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_FORMAT_VERSION = 1;

const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/;

function isSafeSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false;
  if (FORBIDDEN_NAME_CHARS.test(segment)) return false;
  for (let i = 0; i < segment.length; i += 1) {
    if (segment.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/** Relative posix path inside a snapshot: no "..", no absolute paths, no characters Windows forbids. */
export function isSafeSnapshotPath(value: string): boolean {
  if (value === '' || value.length > 400) return false;
  if (value.toLowerCase() === MANIFEST_FILE) return false;
  return value.split('/').every(isSafeSegment);
}

const manifestSchema = z.object({
  formatVersion: z.literal(MANIFEST_FORMAT_VERSION),
  createdAt: z.string(),
  appVersion: z.string(),
  host: z.string(),
  files: z.array(
    z.object({
      path: z.string().refine(isSafeSnapshotPath, 'недопустимый путь'),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      /** Source modification time of family files: unchanged files are linked in the next snapshot. */
      mtimeMs: z.number().int().nonnegative().optional(),
    }),
  ),
  repo: z.object({
    ok: z.boolean(),
    head: z.string().nullable().optional(),
    refs: z.array(z.string()).optional(),
    reason: z.string().optional(),
  }),
  network: z.object({ ok: z.boolean(), reason: z.string().optional() }),
  warnings: z.array(z.string()).optional(),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestFile = Manifest['files'][number];

/** family-backup-20261016-183000 for 2026-10-16T18:30:00Z. */
export function snapshotBaseName(date: Date): string {
  const iso = date.toISOString();
  const day = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `${SNAPSHOT_PREFIX}${day}-${time}`;
}

function toNative(relPath: string): string {
  return path.join(...relPath.split('/'));
}

export interface VerifyOptions {
  gitExe: string;
  /** Scratch space for `git bundle verify`. */
  tempDir: string;
  /**
   * Files hard-linked to an already verified snapshot during this run: the same data on disk, so
   * only the size is checked (re-reading gigabytes of photos every night would take hours).
   */
  trustLinked?: ReadonlySet<string>;
}

export interface VerifyResult {
  ok: boolean;
  dir: string;
  /** Russian, one line each; names files, never their contents. */
  problems: string[];
  /** Checks that could not run (e.g. git missing); they do not fail the verification. */
  warnings: string[];
  manifest: Manifest | null;
  fileCount: number;
  sizeBytes: number;
}

export async function readManifest(
  dir: string,
): Promise<{ manifest: Manifest | null; problem: string | null }> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(dir, MANIFEST_FILE), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { manifest: null, problem: 'Нет файла manifest.json — копия неполная или повреждена' };
    }
    return { manifest: null, problem: `Файл manifest.json не читается: ${describeError(error)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch {
    return { manifest: null, problem: 'Файл manifest.json повреждён (не удалось разобрать)' };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { manifest: null, problem: 'Файл manifest.json повреждён или имеет неизвестный формат' };
  }
  const seen = new Set<string>();
  for (const file of parsed.data.files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) return { manifest: null, problem: `В manifest.json файл указан дважды: ${file.path}` };
    seen.add(key);
  }
  return { manifest: parsed.data, problem: null };
}

/**
 * Checks a snapshot against its manifest: every listed file exists with the same size and sha256,
 * nothing unlisted is present, no links, and the code bundle passes `git bundle verify`.
 */
export async function verifySnapshot(snapshotDir: string, options: VerifyOptions): Promise<VerifyResult> {
  const dir = path.resolve(snapshotDir);
  const result: VerifyResult = {
    ok: false,
    dir,
    problems: [],
    warnings: [],
    manifest: null,
    fileCount: 0,
    sizeBytes: 0,
  };
  const stats = await fsp.lstat(dir).catch(() => null);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    result.problems.push(`Папка копии не найдена: ${dir}`);
    return result;
  }
  const { manifest, problem } = await readManifest(dir);
  if (!manifest) {
    result.problems.push(problem ?? 'Файл manifest.json не читается');
    return result;
  }
  result.manifest = manifest;
  result.fileCount = manifest.files.length;
  result.sizeBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);

  const listing = await listTree(dir);
  for (const link of listing.links) result.problems.push(`Ссылка (symlink/junction) внутри копии: ${link}`);
  for (const other of listing.others) result.problems.push(`Посторонний объект внутри копии: ${other}`);
  const onDisk = new Set(listing.files);

  let bundleIntact = false;
  for (const file of manifest.files) {
    if (!onDisk.has(file.path)) {
      result.problems.push(`Нет файла ${file.path}`);
      continue;
    }
    if (options.trustLinked?.has(file.path)) {
      const size = (await fsp.stat(path.join(dir, toNative(file.path))).catch(() => null))?.size;
      if (size !== file.size) result.problems.push(`Размер файла ${file.path} не совпадает`);
      continue;
    }
    let digest: FileDigest;
    try {
      digest = await hashFile(path.join(dir, toNative(file.path)));
    } catch (error) {
      result.problems.push(`Файл ${file.path} не читается: ${describeError(error)}`);
      continue;
    }
    if (digest.size !== file.size) {
      result.problems.push(
        `Размер файла ${file.path} не совпадает: ожидалось ${file.size} байт, на диске ${digest.size}`,
      );
    } else if (digest.sha256 !== file.sha256) {
      result.problems.push(`Содержимое файла ${file.path} изменено (контрольная сумма не совпадает)`);
    } else if (file.path === BUNDLE_PATH) {
      bundleIntact = true;
    }
  }
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const file of listing.files) {
    if (file !== MANIFEST_FILE && !listed.has(file)) result.problems.push(`Лишний файл в копии: ${file}`);
  }

  if (bundleIntact) {
    try {
      await verifyBundle(options.gitExe, path.join(dir, BUNDLE_PATH), options.tempDir);
    } catch (error) {
      if (error instanceof GitError && error.code !== 'failed') {
        result.warnings.push(`Копию кода проверить не удалось: ${error.message}`);
      } else {
        result.problems.push(`Копия кода (repo.bundle) не прошла проверку Git: ${describeError(error)}`);
      }
    }
  }
  result.ok = result.problems.length === 0;
  return result;
}

export interface SnapshotOptions extends VerifyOptions {
  clock: Clock;
  appVersion: string;
  host?: string;
  /** Test hook: runs after everything is written, right before the integrity check. */
  beforeVerify?: (partialDir: string) => Promise<void>;
}

export interface SnapshotResult {
  /** Family files hard-linked to the previous snapshot (unchanged since then). */
  linkedCount?: number;
  name: string;
  dir: string;
  sizeBytes: number;
  fileCount: number;
  manifest: Manifest;
}

/** The newest complete snapshot in `root` with a readable manifest (for hard-linking unchanged files). */
export async function latestSnapshot(
  root: string,
): Promise<{ dir: string; files: Map<string, ManifestFile> } | null> {
  const names = (await fsp.readdir(root).catch(() => [] as string[]))
    .filter((n) => SNAPSHOT_RE.test(n))
    .sort();
  for (const name of names.reverse()) {
    const dir = path.join(root, name);
    const { manifest } = await readManifest(dir);
    if (manifest) return { dir, files: new Map(manifest.files.map((f) => [f.path, f])) };
  }
  return null;
}

function unchanged(
  entry: CollectedSources['entries'][number],
  prev: ManifestFile | undefined,
): prev is ManifestFile {
  return (
    entry.kind === 'file' &&
    entry.linkable === true &&
    prev !== undefined &&
    prev.size === entry.size &&
    prev.mtimeMs !== undefined &&
    prev.mtimeMs === entry.mtimeMs
  );
}

/** Bytes this target really needs: unchanged family files will be hard links, not copies. */
export async function estimateNewBytes(root: string, sources: CollectedSources): Promise<number> {
  const prev = await latestSnapshot(root);
  let total = 0;
  for (const entry of sources.entries) {
    if (!unchanged(entry, prev?.files.get(entry.path))) total += entry.size;
  }
  return total;
}

/** Reserves "<name>.partial" (mkdir is atomic), adding -2, -3 … when the name is taken. */
async function reservePartial(root: string, baseName: string): Promise<{ name: string; partial: string }> {
  for (let n = 1; n <= 1000; n += 1) {
    const name = n === 1 ? baseName : `${baseName}-${n}`;
    if (await pathExists(path.join(root, name))) continue;
    const partial = path.join(root, `${name}${PARTIAL_SUFFIX}`);
    try {
      await fsp.mkdir(partial);
      return { name, partial };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }
  throw new BackupError(`Не удалось подобрать имя для новой копии в ${root}`);
}

/**
 * Writes a snapshot into `<root>/<name>.partial`, writes manifest.json, re-reads every file from disk
 * and checks sha256, and only then renames the folder to its final name. On any failure the partial
 * folder is removed and nothing gets the final name.
 */
export async function createSnapshot(
  targetRoot: string,
  sources: CollectedSources,
  options: SnapshotOptions,
): Promise<SnapshotResult> {
  const root = path.resolve(targetRoot);
  await fsp.mkdir(root, { recursive: true });
  const now = options.clock();
  const previous = await latestSnapshot(root);
  const { name, partial } = await reservePartial(root, snapshotBaseName(now));
  const linked = new Set<string>();
  try {
    const files: ManifestFile[] = [];
    for (const entry of sources.entries) {
      const dst = path.join(partial, toNative(entry.path));
      const prev = previous?.files.get(entry.path);
      if (previous && unchanged(entry, prev)) {
        try {
          await fsp.mkdir(path.dirname(dst), { recursive: true });
          await fsp.link(path.join(previous.dir, toNative(entry.path)), dst);
          linked.add(entry.path);
          files.push({ path: entry.path, size: prev.size, sha256: prev.sha256, mtimeMs: prev.mtimeMs });
          continue;
        } catch {
          // no hard links here (or the old file is gone): fall back to a full copy
        }
      }
      const digest =
        entry.kind === 'file'
          ? await copyFileHashed(entry.absPath, dst)
          : await writeFileSynced(dst, entry.data);
      files.push({
        path: entry.path,
        size: digest.size,
        sha256: digest.sha256,
        ...(entry.kind === 'file' && entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
      });
    }
    const manifest: Manifest = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      createdAt: now.toISOString(),
      appVersion: options.appVersion,
      host: options.host ?? os.hostname(),
      files,
      repo: sources.repo,
      network: sources.network,
      ...(sources.warnings.length > 0 ? { warnings: [...sources.warnings] } : {}),
    };
    await writeFileSynced(
      path.join(partial, MANIFEST_FILE),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    );

    await options.beforeVerify?.(partial);
    const check = await verifySnapshot(partial, { ...options, trustLinked: linked });
    if (!check.ok) {
      throw new BackupError(`Копия не прошла проверку целостности: ${check.problems.join('; ')}`);
    }
    const dir = path.join(root, name);
    await renameWithRetry(partial, dir);
    return {
      name,
      dir,
      sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
      fileCount: files.length,
      manifest,
      linkedCount: linked.size,
    };
  } catch (error) {
    await removeTree(partial, root).catch(() => undefined);
    throw error;
  }
}
