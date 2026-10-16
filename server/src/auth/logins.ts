import path from 'node:path';
import { z } from 'zod';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { StoredUser } from './users.ts';

export const LOGINS_FILE = 'logins.json';

const fileSchema = z.object({ version: z.literal(1), lastLoginAt: z.record(z.string(), z.string()) });

/**
 * Last sign-in times, kept in logins.json apart from users.json: the server writes this file on
 * every sign-in, while users.json belongs to the console tool (scripts\user.cmd) and is only read
 * by the server, so a CLI change can never be lost in a race with a sign-in.
 */
export interface LoginTimes {
  load(): Promise<void>;
  get(userId: string): string | null;
  record(userId: string, at: string): Promise<void>;
}

/** Reads logins.json as userId → ISO time; a missing file is empty, a broken one throws. */
export async function readLoginTimes(dataDir: string): Promise<Record<string, string>> {
  const data = await readJsonFile(path.join(dataDir, LOGINS_FILE));
  if (data === undefined) return {};
  const parsed = fileSchema.safeParse(data);
  if (!parsed.success) throw new Error(`Файл ${LOGINS_FILE} имеет неверный формат.`);
  return parsed.data.lastLoginAt;
}

/** The time from logins.json, else the field older versions kept in users.json, else null. */
export function lastLoginOf(user: StoredUser, times: { get(userId: string): string | null }): string | null {
  return times.get(user.id) ?? user.lastLoginAt ?? null;
}

export function createLoginTimes(
  dataDir: string,
  options: { onError?: (message: string) => void } = {},
): LoginTimes {
  const file = path.join(dataDir, LOGINS_FILE);
  const queue = createSerialQueue();
  const times = new Map<string, string>();

  return {
    async load() {
      times.clear();
      try {
        for (const [userId, at] of Object.entries(await readLoginTimes(dataDir))) times.set(userId, at);
      } catch (error) {
        // Only sign-in times are lost; the next sign-in rewrites the file.
        options.onError?.(
          `Не удалось прочитать ${LOGINS_FILE} (${(error as Error).message}); время последнего входа будет записываться заново.`,
        );
      }
    },
    get: (userId) => times.get(userId) ?? null,
    record(userId, at) {
      times.set(userId, at);
      // Snapshot taken when the write starts, so writes stay in order and none is lost.
      return queue.run(() => writeJsonAtomic(file, { version: 1, lastLoginAt: Object.fromEntries(times) }));
    },
  };
}
