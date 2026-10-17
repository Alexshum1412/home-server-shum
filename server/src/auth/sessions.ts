import path from 'node:path';
import { z } from 'zod';
import { randomToken, sha256Hex } from '../lib/ids.ts';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';

export const SESSION_COOKIE = 'fd_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS_PER_USER = 20;
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface StoredSession {
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
}

const fileSchema = z.object({
  version: z.literal(1),
  sessions: z.array(
    z.object({
      tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
      userId: z.string().min(1),
      createdAt: z.string(),
      lastSeenAt: z.string(),
    }),
  ),
});

export interface SessionStore {
  load(): Promise<void>;
  /** `startedAt`: when the sign-in began (before the slow password check); default — now. */
  create(userId: string, startedAt?: string): Promise<{ token: string; session: StoredSession }>;
  /** Finds a live (not expired) session by its raw token. */
  lookup(token: string): StoredSession | undefined;
  /** Slides the expiry; returns true when lastSeenAt was actually updated (at most once per minute). */
  touch(session: StoredSession): boolean;
  delete(token: string): Promise<boolean>;
  deleteByHash(tokenHash: string): Promise<void>;
  /** Writes pending lastSeenAt updates (called on shutdown). */
  flush(): Promise<void>;
  count(): number;
}

export interface SessionStoreOptions {
  clock: Clock;
  onError?: (message: string) => void;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function createSessionStore(dataDir: string, options: SessionStoreOptions): SessionStore {
  const file = path.join(dataDir, 'sessions.json');
  const sessions = new Map<string, StoredSession>();
  const { clock } = options;
  let dirty = false;
  let tail: Promise<void> = Promise.resolve();
  let queued: Promise<void> | null = null;

  const now = () => clock().getTime();
  const expired = (session: StoredSession) => now() - Date.parse(session.lastSeenAt) > SESSION_TTL_MS;

  /** Serialised, coalesced snapshot write: the snapshot is taken when the write starts. */
  function persist(): Promise<void> {
    dirty = true;
    if (queued) return queued;
    const run = tail.then(async () => {
      queued = null;
      dirty = false;
      await writeJsonAtomic(file, { version: 1, sessions: [...sessions.values()] });
    });
    queued = run;
    tail = run.catch((error: unknown) => {
      dirty = true;
      options.onError?.(`Не удалось сохранить sessions.json: ${(error as Error).message}`);
    });
    return run;
  }

  function persistInBackground(): void {
    persist().catch(() => undefined);
  }

  return {
    async load() {
      sessions.clear();
      let data: unknown;
      try {
        data = await readJsonFile(file);
      } catch (error) {
        options.onError?.(`Файл sessions.json повреждён, все сессии сброшены: ${(error as Error).message}`);
        return;
      }
      if (data === undefined) return;
      const parsed = fileSchema.safeParse(data);
      if (!parsed.success) {
        options.onError?.('Файл sessions.json имеет неверный формат, все сессии сброшены.');
        return;
      }
      for (const session of parsed.data.sessions) {
        if (!expired(session)) sessions.set(session.tokenHash, session);
      }
    },

    async create(userId, startedAt) {
      const token = randomToken(32);
      const at = clock().toISOString();
      const session: StoredSession = {
        tokenHash: sha256Hex(token),
        userId,
        createdAt: startedAt ?? at,
        lastSeenAt: at,
      };
      const own = [...sessions.values()]
        .filter((item) => item.userId === userId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      for (const old of own.slice(0, Math.max(0, own.length - (MAX_SESSIONS_PER_USER - 1)))) {
        sessions.delete(old.tokenHash);
      }
      sessions.set(session.tokenHash, session);
      await persist();
      return { token, session };
    },

    lookup(token) {
      if (!TOKEN_RE.test(token)) return undefined;
      const session = sessions.get(sha256Hex(token));
      if (!session) return undefined;
      if (expired(session)) {
        sessions.delete(session.tokenHash);
        persistInBackground();
        return undefined;
      }
      return session;
    },

    touch(session) {
      if (now() - Date.parse(session.lastSeenAt) < TOUCH_INTERVAL_MS) return false;
      session.lastSeenAt = clock().toISOString();
      persistInBackground();
      return true;
    },

    async delete(token) {
      if (!TOKEN_RE.test(token)) return false;
      const removed = sessions.delete(sha256Hex(token));
      if (removed) await persist();
      return removed;
    },

    async deleteByHash(tokenHash) {
      if (sessions.delete(tokenHash)) await persist();
    },

    async flush() {
      await tail;
      if (dirty) await persist().catch(() => undefined);
    },

    count: () => sessions.size,
  };
}
