/**
 * How much of the server one person may fill with their own files and photos. The limit is the owner's
 * choice (USER_QUOTA_GB, blank = no limit); a person sees a warning from 90 % and is refused at 100 %,
 * with plain words about what to do. Only the person's own folders count: the shared space belongs to
 * the family, the trash is the owner's safety net (a person cannot empty it, so it must not trap them),
 * previews are small and made by the portal itself.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { QuotaState } from '../../../shared/storage-extras.ts';
import { StorageError } from './storage.ts';

const CACHE_MS = 60_000;
const WALK_MAX_ENTRIES = 1_000_000;
const WALK_MAX_DEPTH = 40;
export const WARN_FROM = 0.9;

export interface QuotaOptions {
  filesRoot: string;
  photosRoot: string;
  /** null = no limit. */
  limitBytes: number | null;
  now?: () => number;
}

export function gigabytes(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ГБ`.replace('.', ',');
}

export function createQuota(options: QuotaOptions) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { bytes: number; at: number }>();

  async function folderSize(root: string): Promise<number> {
    let total = 0;
    let seen = 0;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next) break;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fsp.readdir(next.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        seen += 1;
        if (seen > WALK_MAX_ENTRIES) return total;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(next.dir, entry.name);
        if (entry.isDirectory()) {
          if (next.depth < WALK_MAX_DEPTH) stack.push({ dir: full, depth: next.depth + 1 });
        } else if (entry.isFile()) {
          const stat = await fsp.stat(full).catch(() => null);
          if (stat) total += stat.size;
        }
      }
    }
    return total;
  }

  async function usage(username: string): Promise<number> {
    const hit = cache.get(username);
    if (hit && now() - hit.at < CACHE_MS) return hit.bytes;
    const bytes =
      (await folderSize(path.join(options.filesRoot, 'users', username))) +
      (await folderSize(path.join(options.photosRoot, 'users', username)));
    cache.set(username, { bytes, at: now() });
    return bytes;
  }

  return {
    enabled: options.limitBytes !== null,

    /** null when there is no limit. */
    async state(username: string): Promise<QuotaState | null> {
      const limit = options.limitBytes;
      if (limit === null) return null;
      const used = await usage(username);
      return {
        usedBytes: used,
        limitBytes: limit,
        level: used >= limit ? 'full' : used >= limit * WARN_FROM ? 'warn' : 'ok',
      };
    },

    /** Refuses a new file that would go over the limit. */
    async check(username: string, extraBytes: number): Promise<void> {
      const limit = options.limitBytes;
      if (limit === null) return;
      // The number is at most a minute old and every stored file adds to it at once (see added).
      const used = await usage(username);
      if (used + extraBytes > limit) {
        throw new StorageError(
          507,
          'quota',
          `Ваше место заполнено: занято ${gigabytes(used)} из ${gigabytes(limit)}. Уберите ненужное в корзину или попросите администратора увеличить место.`,
        );
      }
    },

    /** A file of this size was stored: the known total grows at once, without a new walk of every folder. */
    added(username: string, bytes: number): void {
      const hit = cache.get(username);
      if (hit) hit.bytes += bytes;
    },

    /** The numbers are old after something was moved or removed. */
    invalidate(username: string): void {
      cache.delete(username);
    },
  };
}

export type Quota = ReturnType<typeof createQuota>;
