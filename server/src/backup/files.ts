import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { errorCode } from '../lib/json-store.ts';
import { sleep } from '../lib/time.ts';

/** Expected backup failure; the message is Russian and safe to show (paths, never file contents). */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface FileDigest {
  size: number;
  sha256: string;
}

const CHUNK_BYTES = 1024 * 1024;

export function hashBuffer(data: Buffer): FileDigest {
  return { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

/** Streams a file through sha256 (files may be larger than memory). */
export async function hashFile(file: string): Promise<FileDigest> {
  const handle = await fsp.open(file, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/**
 * Copies `src` into a NEW file `dst` (never overwrites), hashing exactly the bytes that were copied,
 * then flushes it to the device (a flash drive may be unplugged right after a backup).
 */
export async function copyFileHashed(src: string, dst: string): Promise<FileDigest> {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const input = await fsp.open(src, 'r');
  try {
    const output = await fsp.open(dst, 'wx', 0o600);
    try {
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let size = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, CHUNK_BYTES, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let written = 0;
        while (written < bytesRead) {
          written += (await output.write(chunk, written, bytesRead - written)).bytesWritten;
        }
        size += bytesRead;
      }
      await output.sync();
      return { size, sha256: hash.digest('hex') };
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** Writes generated content into a NEW file and flushes it. */
export async function writeFileSynced(dst: string, data: Buffer): Promise<FileDigest> {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const output = await fsp.open(dst, 'wx', 0o600);
  try {
    await output.writeFile(data);
    await output.sync();
  } finally {
    await output.close();
  }
  return hashBuffer(data);
}

function normalise(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** `child` is `parent` itself or somewhere below it (case-insensitive on Windows). */
export function isInsideOrSame(child: string, parent: string): boolean {
  const relative = path.relative(normalise(parent), normalise(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** `child` is strictly below `parent`. */
export function isStrictlyInside(child: string, parent: string): boolean {
  return isInsideOrSame(child, parent) && normalise(child) !== normalise(parent);
}

export function isDriveRoot(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved === path.parse(resolved).root;
}

/** Real path (junctions and symlinks resolved) when the path exists, else the resolved path. */
export async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

const RETRYABLE_REMOVE_CODES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM', 'EACCES']);

async function withRetry(entry: string, isLink: boolean, op: () => Promise<void>): Promise<void> {
  let delay = 20;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await op();
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      if (attempt >= 5 || code === undefined || !RETRYABLE_REMOVE_CODES.has(code)) throw error;
      // Git marks its objects read-only; Windows refuses to delete those. chmod would follow a link,
      // so it is only applied to real files and folders.
      if (!isLink && (code === 'EPERM' || code === 'EACCES'))
        await fsp.chmod(entry, 0o666).catch(() => undefined);
      await sleep(delay);
      delay *= 2;
    }
  }
}

async function removeEntry(entry: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stats = await fsp.lstat(entry);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    for (const name of await fsp.readdir(entry)) await removeEntry(path.join(entry, name));
    await withRetry(entry, false, () => fsp.rmdir(entry));
    return;
  }
  // A file, a symlink or a junction: remove the entry itself, never what a link points to.
  // (Node reports Windows junctions as symbolic links; unlink removes only the reparse point.)
  await withRetry(entry, stats.isSymbolicLink(), () => fsp.unlink(entry));
}

/**
 * Deletes `target` recursively WITHOUT following symlinks or junctions, and only when `target` is
 * strictly inside `within` (a backup target root or a temp folder of ours).
 */
export async function removeTree(target: string, within: string): Promise<void> {
  if (!isStrictlyInside(target, within)) {
    throw new BackupError(`Отказ удалить ${path.resolve(target)}: папка вне ${path.resolve(within)}`);
  }
  await removeEntry(path.resolve(target));
}

export interface TreeListing {
  /** Regular files, posix relative paths. */
  files: string[];
  /** Symlinks / junctions (never followed). */
  links: string[];
  /** Anything else that is not a regular file or a folder. */
  others: string[];
}

/** Lists a folder recursively without following links. */
export async function listTree(dir: string): Promise<TreeListing> {
  const listing: TreeListing = { files: [], links: [], others: [] };
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) listing.links.push(rel);
      else if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) listing.files.push(rel);
      else listing.others.push(rel);
    }
  }
  await walk(dir, '');
  listing.files.sort();
  return listing;
}

/** Plain-Russian description of a file-system error at `where`; falls back to the message. */
export function describeError(error: unknown): string {
  if (error instanceof BackupError) return error.message;
  const code = errorCode(error);
  const where = (error as NodeJS.ErrnoException | undefined)?.path;
  const suffix = where ? `: ${where}` : '';
  switch (code) {
    case 'ENOSPC':
      return `На диске закончилось место${suffix}`;
    case 'EACCES':
    case 'EPERM':
      return `Нет доступа${suffix}`;
    case 'ENOENT':
      return `Папка или файл не найдены${suffix}`;
    case 'ENOTDIR':
    case 'EEXIST':
      return `На месте папки находится файл${suffix}`;
    case 'EROFS':
      return `Диск защищён от записи${suffix}`;
    case 'EIO':
      return `Ошибка чтения или записи (диск неисправен или отключён)${suffix}`;
    case 'EBUSY':
      return `Файл занят другой программой${suffix}`;
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
