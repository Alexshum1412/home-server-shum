/**
 * Where each person stopped watching or listening (the «Продолжить просмотр» row). The portal keeps
 * this itself, per person: Jellyfin's own viewing history is not touched and nobody sees another
 * person's progress.
 */
import path from 'node:path';
import { z } from 'zod';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import type { Resume } from './client.ts';

const MAX_ITEMS_PER_PERSON = 200;
/** Within this share of the end (or last minute) the item counts as finished. */
const FINISHED_SHARE = 0.95;
const FINISHED_TAIL_SEC = 60;
/** The first seconds are not worth remembering. */
const MIN_POSITION_SEC = 10;

const fileSchema = z.object({
  version: z.literal(1),
  users: z.record(
    z.string(),
    z.record(
      z.string(),
      z.object({ positionSec: z.number(), durationSec: z.number(), updatedAt: z.string() }),
    ),
  ),
});

export interface ProgressStore {
  load(): Promise<void>;
  get(userId: string, itemId: string): Resume | undefined;
  /** Newest first; the ids of what can be continued. */
  continueIds(userId: string, limit: number): string[];
  put(userId: string, itemId: string, positionSec: number, durationSec: number): void;
  forget(userId: string): void;
  idle(): Promise<void>;
}

export function createProgressStore(options: {
  dataDir: string;
  clock: Clock;
  onError?: (message: string) => void;
}): ProgressStore {
  const file = path.join(options.dataDir, 'media-progress.json');
  const queue = createSerialQueue();
  const users = new Map<string, Map<string, Resume & { updatedAt: string }>>();
  let timer: NodeJS.Timeout | null = null;

  function save(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, 1000);
    timer.unref();
  }

  function write(): Promise<void> {
    const snapshot = {
      version: 1 as const,
      users: Object.fromEntries([...users].map(([id, items]) => [id, Object.fromEntries(items)])),
    };
    return queue
      .run(() => writeJsonAtomic(file, snapshot))
      .catch((error: unknown) =>
        options.onError?.(`Не удалось сохранить место остановки: ${(error as Error).message}`),
      );
  }

  return {
    async load() {
      try {
        const data = await readJsonFile(file);
        if (data === undefined) return;
        const parsed = fileSchema.safeParse(data);
        if (!parsed.success) {
          options.onError?.('Файл media-progress.json имеет неверный формат: места остановки сброшены.');
          return;
        }
        for (const [id, items] of Object.entries(parsed.data.users))
          users.set(id, new Map(Object.entries(items)));
      } catch (error) {
        options.onError?.(`Файл media-progress.json не прочитан: ${(error as Error).message}`);
      }
    },

    get(userId, itemId) {
      const item = users.get(userId)?.get(itemId);
      return item ? { positionSec: item.positionSec, durationSec: item.durationSec } : undefined;
    },

    continueIds(userId, limit) {
      return [...(users.get(userId) ?? [])]
        .sort(([, a], [, b]) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, limit)
        .map(([id]) => id);
    },

    put(userId, itemId, positionSec, durationSec) {
      // The first seconds of a player that has not yet jumped to the saved place must not wipe it.
      if (positionSec < MIN_POSITION_SEC) return;
      let items = users.get(userId);
      if (!items) {
        items = new Map();
        users.set(userId, items);
      }
      const finished =
        durationSec > 0 &&
        (positionSec >= durationSec * FINISHED_SHARE || durationSec - positionSec <= FINISHED_TAIL_SEC);
      if (finished) {
        // Watched to the end: nothing to continue.
        if (items.delete(itemId)) save();
        return;
      }
      items.delete(itemId);
      items.set(itemId, { positionSec, durationSec, updatedAt: isoNow(options.clock) });
      while (items.size > MAX_ITEMS_PER_PERSON) {
        const oldest = items.keys().next().value;
        if (oldest === undefined) break;
        items.delete(oldest);
      }
      save();
    },

    forget(userId) {
      if (users.delete(userId)) save();
    },

    async idle() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        await write();
      }
      await queue.idle();
    },
  };
}
