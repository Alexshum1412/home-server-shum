import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { Role, SessionUser } from '../../../shared/api.ts';
import { newId } from '../lib/ids.ts';
import { createSerialQueue, errorCode, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const DISPLAY_NAME_MAX = 64;

export interface StoredUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  passwordHash: string;
  createdAt: string;
  passwordChangedAt: string;
  /**
   * Written by versions before logins.json; still read as a fallback for the last sign-in time and
   * kept as is when the CLI rewrites the file. Nothing writes it any more.
   */
  lastLoginAt?: string | null;
}

const userSchema = z.object({
  id: z.string().min(1),
  username: z.string().regex(USERNAME_RE),
  displayName: z.string().min(1).max(DISPLAY_NAME_MAX),
  role: z.enum(['family', 'admin']),
  passwordHash: z.string().min(1),
  createdAt: z.string(),
  passwordChangedAt: z.string(),
  lastLoginAt: z.string().nullable().optional(),
});

const fileSchema = z.object({ version: z.literal(1), users: z.array(userSchema) });

export function normaliseUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function toSessionUser(user: StoredUser): SessionUser {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
}

export type UserPatch = Partial<
  Pick<StoredUser, 'displayName' | 'role' | 'passwordHash' | 'passwordChangedAt'>
>;

export interface NewUser {
  username: string;
  displayName: string;
  role: Role;
  passwordHash: string;
}

export interface UserStore {
  readonly file: string;
  /** Cached list; re-read from disk when users.json changed (checked at most every `reloadIntervalMs`). */
  list(): Promise<StoredUser[]>;
  findByUsername(username: string): Promise<StoredUser | undefined>;
  findById(id: string): Promise<StoredUser | undefined>;
  /** Reads users.json now; throws when the file is invalid. */
  reload(): Promise<StoredUser[]>;
  add(user: NewUser): Promise<StoredUser>;
  update(id: string, patch: UserPatch): Promise<StoredUser | undefined>;
  remove(id: string): Promise<boolean>;
  /**
   * Non-null while users.json exists but cannot be read or parsed (as of the last check). The
   * server then refuses sign-ins and never treats the store as empty; the file is not rewritten.
   */
  loadError(): string | null;
}

export interface UserStoreOptions {
  clock: Clock;
  reloadIntervalMs?: number;
  onLoadError?: (message: string) => void;
}

export class UserStoreError extends Error {}

async function readUsersFile(file: string): Promise<StoredUser[]> {
  let data: unknown;
  try {
    data = await readJsonFile(file);
  } catch (error) {
    throw new UserStoreError(`Файл ${path.basename(file)} повреждён (${(error as Error).message}).`);
  }
  if (data === undefined) return [];
  const parsed = fileSchema.safeParse(data);
  if (!parsed.success) {
    throw new UserStoreError(`Файл ${path.basename(file)} имеет неверный формат.`);
  }
  return parsed.data.users;
}

export function createUserStore(dataDir: string, options: UserStoreOptions): UserStore {
  const file = path.join(dataDir, 'users.json');
  const reloadIntervalMs = options.reloadIntervalMs ?? 2000;
  const queue = createSerialQueue();
  let users: StoredUser[] = [];
  let signature: string | null = null;
  let lastCheck = Number.NEGATIVE_INFINITY;
  let lastError: string | null = null;

  async function fileSignature(): Promise<string> {
    try {
      const stat = await fsp.stat(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'missing';
      throw error;
    }
  }

  async function reload(): Promise<StoredUser[]> {
    try {
      const sig = await fileSignature();
      users = sig === 'missing' ? [] : await readUsersFile(file);
      signature = sig;
    } catch (error) {
      // Remembered so the portal does not mistake a broken file for a fresh install.
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      lastCheck = performance.now();
    }
    lastError = null;
    return users;
  }

  async function list(): Promise<StoredUser[]> {
    if (signature !== null && performance.now() - lastCheck < reloadIntervalMs) return users;
    lastCheck = performance.now();
    try {
      const sig = await fileSignature();
      // While the file is broken, re-read it on every check so a repair is noticed even when it
      // restores the exact size and timestamp of the last good version.
      if (sig !== signature || lastError !== null) {
        users = sig === 'missing' ? [] : await readUsersFile(file);
        signature = sig;
        lastError = null;
      }
    } catch (error) {
      // Keep serving the previous list; the owner sees the error in the log.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) options.onLoadError?.(message);
      lastError = message;
    }
    return users;
  }

  async function write(next: StoredUser[]): Promise<void> {
    await writeJsonAtomic(file, { version: 1, users: next });
    users = next;
    signature = await fileSignature();
    lastCheck = performance.now();
  }

  return {
    file,
    list,
    reload,
    loadError: () => lastError,
    async findByUsername(username) {
      const name = normaliseUsername(username);
      return (await list()).find((user) => user.username === name);
    },
    async findById(id) {
      return (await list()).find((user) => user.id === id);
    },
    add(input) {
      return queue.run(async () => {
        const current = await readUsersFile(file);
        const username = normaliseUsername(input.username);
        if (!USERNAME_RE.test(username)) throw new UserStoreError('Недопустимый логин.');
        if (current.some((user) => user.username === username)) {
          throw new UserStoreError(`Пользователь «${username}» уже существует.`);
        }
        const now = isoNow(options.clock);
        const user: StoredUser = {
          id: newId(),
          username,
          displayName: input.displayName.trim(),
          role: input.role,
          passwordHash: input.passwordHash,
          createdAt: now,
          passwordChangedAt: now,
        };
        await write([...current, user]);
        return user;
      });
    },
    update(id, patch) {
      return queue.run(async () => {
        // Always re-read so a concurrent CLI change is not overwritten with a stale copy.
        const current = await readUsersFile(file);
        const index = current.findIndex((user) => user.id === id);
        const existing = current[index];
        if (!existing) return undefined;
        const updated: StoredUser = { ...existing, ...patch };
        const next = current.slice();
        next[index] = updated;
        await write(next);
        return updated;
      });
    },
    remove(id) {
      return queue.run(async () => {
        const current = await readUsersFile(file);
        const next = current.filter((user) => user.id !== id);
        if (next.length === current.length) return false;
        await write(next);
        return true;
      });
    },
  };
}
