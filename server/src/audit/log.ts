import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { AuditEntry } from '../../../shared/api.ts';
import { createSerialQueue, errorCode } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';

export type AuditAction =
  | 'login.success'
  | 'login.failure'
  | 'login.blocked'
  | 'logout'
  | 'password.change'
  | 'password.change_failed'
  | 'download.add'
  | 'download.done'
  | 'download.fail'
  | 'download.cancel'
  | 'file.upload'
  | 'file.trash'
  | 'file.rename'
  | 'file.mkdir'
  | 'olivia.action'
  | 'services.refresh'
  | 'diagnostics.export';

export interface AuditInput {
  action: AuditAction;
  actor: string | null;
  ip: string | null;
  detail?: string | null;
}

export interface AuditLog {
  /** Appends one entry; never throws (errors go to `onError`). */
  write(entry: AuditInput): Promise<void>;
  /** Newest first, at most 500. */
  readLatest(limit: number): Promise<AuditEntry[]>;
  idle(): Promise<void>;
}

export interface AuditLogOptions {
  clock: Clock;
  maxBytes?: number;
  /** Number of rotated files kept (audit.1.jsonl … audit.N.jsonl). */
  keep?: number;
  onError?: (message: string) => void;
}

export const AUDIT_MAX_READ = 500;
const CHUNK_SIZE = 64 * 1024;

/** Keeps only printable text and bounds the length, so a log line can never carry blobs or control chars. */
function clean(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text === '' ? null : text.slice(0, max);
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const optString = (x: unknown) => x === null || typeof x === 'string';
  return (
    typeof v.time === 'string' &&
    typeof v.action === 'string' &&
    optString(v.actor) &&
    optString(v.ip) &&
    optString(v.detail)
  );
}

/** Parses one log line; a torn or foreign line gives null. */
function parseEntry(line: string): AuditEntry | null {
  if (line === '') return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isAuditEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads up to `max` VALID entries from the end of a file, newest first. Torn or foreign lines are
 * skipped and do not count, so they never hide newer valid entries of the same file.
 */
async function readEntriesFromEnd(file: string, max: number): Promise<AuditEntry[]> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const entries: AuditEntry[] = [];
    let position = size;
    let carry = Buffer.alloc(0);
    while (position > 0 && entries.length < max) {
      const length = Math.min(CHUNK_SIZE, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      let buffer = Buffer.concat([chunk, carry]);
      // Split on '\n' bytes: 0x0A never occurs inside a multi-byte UTF-8 sequence.
      let end = buffer.length;
      for (let i = buffer.length - 1; i >= 0 && entries.length < max; i -= 1) {
        if (buffer[i] === 0x0a) {
          const entry = parseEntry(
            buffer
              .subarray(i + 1, end)
              .toString('utf8')
              .trim(),
          );
          if (entry) entries.push(entry);
          end = i;
        }
      }
      buffer = buffer.subarray(0, end);
      carry = Buffer.from(buffer);
    }
    if (position === 0 && carry.length > 0 && entries.length < max) {
      const entry = parseEntry(carry.toString('utf8').trim());
      if (entry) entries.push(entry);
    }
    return entries;
  } finally {
    await handle.close();
  }
}

const NEWLINE = Buffer.from('\n', 'utf8');

/** Whether the last byte of a non-empty file of `size` bytes is '\n'. */
async function endsWithNewline(file: string, size: number): Promise<boolean> {
  const handle = await fsp.open(file, 'r');
  try {
    const last = Buffer.alloc(1);
    const { bytesRead } = await handle.read(last, 0, 1, size - 1);
    return bytesRead === 1 && last[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

export function createAuditLog(dataDir: string, options: AuditLogOptions): AuditLog {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const keep = options.keep ?? 3;
  const current = path.join(dataDir, 'audit.jsonl');
  const rotated = (n: number) => path.join(dataDir, `audit.${n}.jsonl`);
  const queue = createSerialQueue();
  let size: number | null = null;
  /** Whether the end of audit.jsonl was checked for a torn line since startup. */
  let tailChecked = false;

  async function currentSize(): Promise<number> {
    if (size !== null) return size;
    try {
      size = (await fsp.stat(current)).size;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      size = 0;
    }
    return size;
  }

  async function rotate(): Promise<void> {
    await fsp.rm(rotated(keep), { force: true });
    for (let n = keep - 1; n >= 1; n -= 1) {
      await fsp.rename(rotated(n), rotated(n + 1)).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    }
    await fsp.rename(current, rotated(1));
    size = 0;
  }

  return {
    write(input) {
      const entry: AuditEntry = {
        time: options.clock().toISOString(),
        action: input.action,
        actor: clean(input.actor, 64),
        ip: clean(input.ip, 64),
        detail: clean(input.detail, 200),
      };
      const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
      return queue
        .run(async () => {
          await fsp.mkdir(dataDir, { recursive: true });
          const before = await currentSize();
          if (before > 0 && before + line.length > maxBytes) await rotate();
          let data = line;
          if (!tailChecked) {
            // A crash in the middle of an append leaves a last line without '\n'; start a new
            // line so the first entry of this run is not glued onto (and lost with) the torn one.
            const at = size ?? 0;
            if (at > 0 && !(await endsWithNewline(current, at))) data = Buffer.concat([NEWLINE, line]);
          }
          await fsp.appendFile(current, data, { mode: 0o600 });
          size = (size ?? 0) + data.length;
          tailChecked = true;
        })
        .catch((error: unknown) => {
          size = null;
          options.onError?.(`Не удалось записать журнал аудита: ${(error as Error).message}`);
        });
    },

    async readLatest(limit) {
      const max = Math.min(Math.max(1, Math.trunc(limit) || 1), AUDIT_MAX_READ);
      await queue.idle();
      const entries: AuditEntry[] = [];
      for (const file of [current, ...Array.from({ length: keep }, (_, i) => rotated(i + 1))]) {
        if (entries.length >= max) break;
        entries.push(...(await readEntriesFromEnd(file, max - entries.length)));
      }
      return entries.slice(0, max);
    },

    idle: () => queue.idle(),
  };
}
