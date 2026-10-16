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

/** Reads up to `max` complete lines from the end of a file, newest first. */
async function readLinesFromEnd(file: string, max: number): Promise<string[]> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const lines: string[] = [];
    let position = size;
    let carry = Buffer.alloc(0);
    while (position > 0 && lines.length < max) {
      const length = Math.min(CHUNK_SIZE, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      let buffer = Buffer.concat([chunk, carry]);
      // Split on '\n' bytes: 0x0A never occurs inside a multi-byte UTF-8 sequence.
      let end = buffer.length;
      for (let i = buffer.length - 1; i >= 0 && lines.length < max; i -= 1) {
        if (buffer[i] === 0x0a) {
          const line = buffer
            .subarray(i + 1, end)
            .toString('utf8')
            .trim();
          if (line) lines.push(line);
          end = i;
        }
      }
      buffer = buffer.subarray(0, end);
      carry = Buffer.from(buffer);
    }
    if (position === 0 && carry.length > 0 && lines.length < max) {
      const line = carry.toString('utf8').trim();
      if (line) lines.push(line);
    }
    return lines;
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
          await fsp.appendFile(current, line, { mode: 0o600 });
          size = (size ?? 0) + line.length;
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
        for (const line of await readLinesFromEnd(file, max - entries.length)) {
          try {
            const parsed: unknown = JSON.parse(line);
            if (isAuditEntry(parsed)) entries.push(parsed);
          } catch {
            // A torn or foreign line is skipped, never fatal.
          }
        }
      }
      return entries.slice(0, max);
    },

    idle: () => queue.idle(),
  };
}
