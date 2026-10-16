import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { sleep } from './time.ts';

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

export function errorCode(error: unknown): string | undefined {
  return isErrnoException(error) ? error.code : undefined;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Reads and parses a JSON file. Returns `undefined` when the file does not exist;
 * throws on I/O errors other than ENOENT and on invalid JSON.
 */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(stripBom(text));
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** On Windows a rename over a file that another process has open briefly fails; retry a few times. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 10;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= 6 || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      await sleep(delay);
      delay *= 2;
    }
  }
}

/** Name of writeJsonAtomic()'s temp file: ".<target name>.<pid>.<12 hex digits>.tmp". */
export const ATOMIC_TEMP_FILE_RE = /^\..+\.\d+\.[0-9a-f]{12}\.tmp$/;

/** A temp file younger than this may belong to a write in progress (server or CLI). */
const STALE_TEMP_AGE_MS = 60_000;

/**
 * Deletes temp files that an interrupted writeJsonAtomic() (forced stop, power loss) left directly
 * in `dir`: only regular files with the temp-file name pattern, only when older than a minute.
 * Returns the names removed; a file that cannot be removed now is left for the next start.
 */
export async function removeStaleTempFiles(dir: string, now = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !ATOMIC_TEMP_FILE_RE.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      if (now - (await fsp.stat(file)).mtimeMs < STALE_TEMP_AGE_MS) continue;
      await fsp.rm(file);
      removed.push(entry.name);
    } catch {
      // Already gone or locked by another process.
    }
  }
  return removed;
}

/** Atomic write: temp file in the same directory, fsync, then rename over the target. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  // Keep in sync with ATOMIC_TEMP_FILE_RE (startup cleanup of interrupted writes).
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  try {
    const handle = await fsp.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Runs async tasks one after another (e.g. file writes) without losing errors. */
export function createSerialQueue(): { run<T>(task: () => Promise<T>): Promise<T>; idle(): Promise<void> } {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      tail = result.catch(() => undefined);
      return result;
    },
    idle(): Promise<void> {
      return tail.then(() => undefined);
    },
  };
}
