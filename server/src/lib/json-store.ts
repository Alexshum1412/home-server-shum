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

/** Atomic write: temp file in the same directory, fsync, then rename over the target. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
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
