/**
 * The cinema's personal lists (media-lists.json in the data folder): favourites, «Посмотреть позже»,
 * what is watched, and the family's film suggestions.
 *
 * Everything personal is kept per person and handed out only to that person; the one thing that
 * looks across people is `community()`, which gives bare counts per item (never who). Suggestions
 * are the family's shared list by design: everybody sees them, an administrator decides.
 *
 * Writes go through one queue and an atomic file replace; a change that cannot be saved is undone
 * in memory too, so the screen never shows a mark that is not on the disk.
 */
import path from 'node:path';
import { z } from 'zod';
import type { CatalogMarks, CatalogMarkState, CatalogSuggestionStatus } from '../../../shared/api.ts';
import { newId } from '../lib/ids.ts';
import { createSerialQueue, readJsonFile, renameWithRetry, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import { finishedByProgress } from './progress.ts';

export class MediaListError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A film is «watched» from this share of its length on (the progress store has its own, stricter «finished»). */
export const WATCHED_SHARE = 0.9;
/** The first seconds of a player are not a reason to say anything. */
const MIN_POSITION_SEC = 10;
/** Reaching the end again within this time does not move the date of the mark. */
const REWATCH_GAP_MS = 12 * 60 * 60 * 1000;

export const MAX_FAVOURITES = 500;
export const MAX_LATER = 500;
/** The history keeps this many finished items; the oldest are forgotten first. */
export const MAX_WATCHED = 3000;
export const TITLE_MAX = 120;
export const NOTE_MAX = 300;
export const MAX_OPEN_PER_PERSON = 10;
export const MAX_SUGGESTIONS = 300;

const markSchema = z.object({ at: z.string(), parent: z.string().nullable().default(null) });
const watchedSchema = z.object({
  at: z.string(),
  how: z.enum(['auto', 'manual']),
  parent: z.string().nullable().default(null),
});
const personSchema = z.object({
  favourites: z.record(z.string(), markSchema).default({}),
  later: z.record(z.string(), markSchema).default({}),
  watched: z.record(z.string(), watchedSchema).default({}),
});
const suggestionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(TITLE_MAX),
  note: z.string().max(NOTE_MAX),
  by: z.string().min(1),
  byName: z.string().max(80),
  at: z.string(),
  status: z.enum(['open', 'added', 'declined']),
  decidedAt: z.string().nullable(),
});
const fileSchema = z.object({
  version: z.literal(1),
  users: z.record(z.string(), personSchema).default({}),
  suggestions: z.array(suggestionSchema).default([]),
});

type Person = z.infer<typeof personSchema>;
export type StoredSuggestion = z.infer<typeof suggestionSchema>;

interface State {
  users: Record<string, Person>;
  suggestions: StoredSuggestion[];
}

/** One mark with its time; `parent` is the series (or book, album) a part belongs to. */
export interface MarkEntry {
  id: string;
  at: string;
  parent: string | null;
}
export interface WatchedEntry extends MarkEntry {
  how: 'auto' | 'manual';
}

export interface MediaLists {
  load(): Promise<void>;
  /** Item ids of the three lists, the newest mark first. */
  marks(userId: string): CatalogMarks;
  state(userId: string, itemId: string): CatalogMarkState;
  favourites(userId: string): MarkEntry[];
  later(userId: string): MarkEntry[];
  watched(userId: string): WatchedEntry[];
  /** The items (and their series) this person has finished: «unseen» means not in here. */
  seenIds(userId: string): Set<string>;
  setFavourite(userId: string, itemId: string, on: boolean, parent: string | null): Promise<void>;
  setLater(userId: string, itemId: string, on: boolean): Promise<void>;
  /** A finished item leaves «Посмотреть позже» by itself. */
  setWatched(userId: string, itemId: string, on: boolean, parent: string | null): Promise<void>;
  /**
   * Called with every reported place. From about 90 % the item is marked watched (once; again only after
   * a long time). `parentOf` is asked only then. Returns whether the mark was made now.
   */
  noteProgress(
    userId: string,
    itemId: string,
    positionSec: number,
    durationSec: number,
    parentOf?: () => Promise<string | null>,
  ): Promise<boolean>;
  /** How many OTHER people finished or favourited each item (and its series): counts only, never who. */
  community(exceptUserId: string): Map<string, number>;
  /** Open ones first (newest first), then the decided ones (latest decision first). */
  suggestions(): StoredSuggestion[];
  addSuggestion(
    person: { id: string; displayName: string },
    title: string,
    note: string,
  ): Promise<StoredSuggestion>;
  /** The author takes back a suggestion that is still open. */
  withdrawSuggestion(userId: string, id: string): Promise<void>;
  decideSuggestion(id: string, status: CatalogSuggestionStatus): Promise<StoredSuggestion>;
  removeSuggestion(id: string): Promise<void>;
  /** Forgets everything personal about a removed person (their suggestions stay: they are the family's list). */
  forget(userId: string): Promise<void>;
  idle(): Promise<void>;
}

/** Same title written differently (case, ё, spaces, quotes) counts as the same. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„'’.,:;!?()[\]-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function newestFirst<T extends { id: string; at: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
}

const empty = (): State => ({ users: {}, suggestions: [] });

export function createMediaLists(options: {
  dataDir: string;
  clock: Clock;
  onError?: (message: string) => void;
}): MediaLists {
  const file = path.join(options.dataDir, 'media-lists.json');
  const queue = createSerialQueue();
  let data: State = empty();

  const person = (userId: string): Person | undefined => data.users[userId];
  const own = (userId: string): Person => {
    let found = data.users[userId];
    if (!found) {
      found = { favourites: {}, later: {}, watched: {} };
      data.users[userId] = found;
    }
    return found;
  };

  /** Runs `change` in the queue, saves, and undoes it in memory when the disk refuses. */
  function commit<T>(change: () => T): Promise<T> {
    return queue.run(async () => {
      const before = structuredClone(data);
      let result: T;
      try {
        result = change();
      } catch (error) {
        data = before;
        throw error;
      }
      try {
        await writeJsonAtomic(file, { version: 1, users: data.users, suggestions: data.suggestions });
      } catch (error) {
        data = before;
        options.onError?.(`Не удалось сохранить списки кинотеатра: ${(error as Error).message}`);
        throw new MediaListError(
          503,
          'save_failed',
          'Не удалось сохранить: файл на сервере занят или нет места. Попробуйте ещё раз чуть позже.',
        );
      }
      return result;
    });
  }

  /** Drops the oldest marks of a list that grew past its limit (the history trims itself). */
  function trimWatched(lists: Person): void {
    const ids = Object.keys(lists.watched);
    if (ids.length <= MAX_WATCHED) return;
    const oldest = ids
      .map((id) => ({ id, at: lists.watched[id]?.at ?? '' }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const entry of oldest.slice(0, ids.length - MAX_WATCHED)) delete lists.watched[entry.id];
  }

  function markWatched(userId: string, itemId: string, how: 'auto' | 'manual', parent: string | null): void {
    const lists = own(userId);
    const before = lists.watched[itemId];
    lists.watched[itemId] = { at: isoNow(options.clock), how, parent: parent ?? before?.parent ?? null };
    delete lists.later[itemId];
    trimWatched(lists);
  }

  const stateOf = (userId: string, itemId: string): CatalogMarkState => {
    const lists = person(userId);
    return {
      id: itemId,
      favourite: lists?.favourites[itemId] !== undefined,
      later: lists?.later[itemId] !== undefined,
      watched: lists?.watched[itemId] !== undefined,
    };
  };

  const entriesOf = (record: Record<string, { at: string; parent: string | null }> | undefined): MarkEntry[] =>
    newestFirst(Object.entries(record ?? {}).map(([id, mark]) => ({ id, at: mark.at, parent: mark.parent })));

  return {
    async load() {
      let raw: unknown;
      try {
        raw = await readJsonFile(file);
      } catch (error) {
        options.onError?.(`Файл media-lists.json не прочитан: ${(error as Error).message}`);
        await keepDamaged();
        return;
      }
      if (raw === undefined) return;
      const parsed = fileSchema.safeParse(raw);
      if (!parsed.success) {
        options.onError?.('Файл media-lists.json имеет неверный формат: списки начаты заново.');
        await keepDamaged();
        return;
      }
      data = { users: parsed.data.users, suggestions: parsed.data.suggestions };
    },

    marks(userId) {
      const lists = person(userId);
      return {
        favourites: entriesOf(lists?.favourites).map((entry) => entry.id),
        later: entriesOf(lists?.later).map((entry) => entry.id),
        watched: entriesOf(lists?.watched).map((entry) => entry.id),
      };
    },

    state: stateOf,

    favourites: (userId) => entriesOf(person(userId)?.favourites),
    later: (userId) => entriesOf(person(userId)?.later),
    watched(userId) {
      const lists = person(userId);
      return newestFirst(
        Object.entries(lists?.watched ?? {}).map(([id, mark]) => ({
          id,
          at: mark.at,
          parent: mark.parent,
          how: mark.how,
        })),
      );
    },

    seenIds(userId) {
      const seen = new Set<string>();
      for (const [id, mark] of Object.entries(person(userId)?.watched ?? {})) {
        seen.add(id);
        if (mark.parent) seen.add(mark.parent);
      }
      return seen;
    },

    setFavourite(userId, itemId, on, parent) {
      return commit(() => {
        const lists = own(userId);
        if (!on) {
          delete lists.favourites[itemId];
          return;
        }
        if (lists.favourites[itemId]) return;
        if (Object.keys(lists.favourites).length >= MAX_FAVOURITES) {
          throw new MediaListError(
            409,
            'too_many',
            `В избранном уже ${MAX_FAVOURITES} позиций. Уберите что-нибудь ненужное и попробуйте снова.`,
          );
        }
        lists.favourites[itemId] = { at: isoNow(options.clock), parent };
      });
    },

    setLater(userId, itemId, on) {
      return commit(() => {
        const lists = own(userId);
        if (!on) {
          delete lists.later[itemId];
          return;
        }
        if (lists.later[itemId]) return;
        if (Object.keys(lists.later).length >= MAX_LATER) {
          throw new MediaListError(
            409,
            'too_many',
            `В списке «Посмотреть позже» уже ${MAX_LATER} позиций. Уберите что-нибудь и попробуйте снова.`,
          );
        }
        lists.later[itemId] = { at: isoNow(options.clock), parent: null };
      });
    },

    setWatched(userId, itemId, on, parent) {
      return commit(() => {
        if (on) {
          if (!person(userId)?.watched[itemId]) markWatched(userId, itemId, 'manual', parent);
          return;
        }
        delete own(userId).watched[itemId];
      });
    },

    async noteProgress(userId, itemId, positionSec, durationSec, parentOf) {
      if (positionSec < MIN_POSITION_SEC || durationSec <= 0) return false;
      if (positionSec < durationSec * WATCHED_SHARE && !finishedByProgress(positionSec, durationSec)) return false;
      const existing = person(userId)?.watched[itemId];
      const gap = existing ? options.clock().getTime() - Date.parse(existing.at) : Number.POSITIVE_INFINITY;
      if (existing && gap < REWATCH_GAP_MS) return false;
      const parent = existing ? existing.parent : ((await parentOf?.().catch(() => null)) ?? null);
      await commit(() => markWatched(userId, itemId, existing?.how ?? 'auto', parent));
      return true;
    },

    community(exceptUserId) {
      const counts = new Map<string, number>();
      for (const [userId, lists] of Object.entries(data.users)) {
        if (userId === exceptUserId) continue;
        const keys = new Set<string>();
        for (const record of [lists.watched, lists.favourites]) {
          for (const [id, mark] of Object.entries(record)) {
            keys.add(id);
            if (mark.parent) keys.add(mark.parent);
          }
        }
        for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    },

    suggestions() {
      const open = data.suggestions.filter((entry) => entry.status === 'open');
      const decided = data.suggestions.filter((entry) => entry.status !== 'open');
      open.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
      decided.sort(
        (a, b) =>
          Date.parse(b.decidedAt ?? b.at) - Date.parse(a.decidedAt ?? a.at) || a.id.localeCompare(b.id),
      );
      return [...open, ...decided].map((entry) => ({ ...entry }));
    },

    addSuggestion(who, rawTitle, rawNote) {
      const title = rawTitle.replace(/\s+/g, ' ').trim();
      const note = rawNote.replace(/[ \t]+/g, ' ').trim();
      if (title === '') throw new MediaListError(400, 'bad_title', 'Напишите название фильма или сериала.');
      if (title.length > TITLE_MAX)
        throw new MediaListError(400, 'bad_title', `Название длиннее ${TITLE_MAX} знаков: сократите его.`);
      if (note.length > NOTE_MAX)
        throw new MediaListError(400, 'bad_note', `Пояснение длиннее ${NOTE_MAX} знаков: сократите его.`);
      return commit(() => {
        const key = titleKey(title);
        if (data.suggestions.some((entry) => entry.status === 'open' && titleKey(entry.title) === key)) {
          throw new MediaListError(409, 'duplicate', 'Такое предложение уже есть в списке и ждёт решения.');
        }
        const mine = data.suggestions.filter((entry) => entry.by === who.id && entry.status === 'open');
        if (mine.length >= MAX_OPEN_PER_PERSON) {
          throw new MediaListError(
            429,
            'too_many',
            `У вас уже ${MAX_OPEN_PER_PERSON} предложений ждут решения. Дождитесь ответа или отзовите лишнее.`,
          );
        }
        if (data.suggestions.length >= MAX_SUGGESTIONS) {
          const oldest = data.suggestions
            .filter((entry) => entry.status !== 'open')
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
          if (!oldest) {
            throw new MediaListError(
              429,
              'too_many',
              'В списке слишком много нерешённых предложений. Подождите, пока администратор их разберёт.',
            );
          }
          data.suggestions = data.suggestions.filter((entry) => entry.id !== oldest.id);
        }
        const created: StoredSuggestion = {
          id: newId(),
          title,
          note,
          by: who.id,
          byName: who.displayName.slice(0, 80),
          at: isoNow(options.clock),
          status: 'open',
          decidedAt: null,
        };
        data.suggestions.push(created);
        return { ...created };
      });
    },

    withdrawSuggestion(userId, id) {
      return commit(() => {
        const found = data.suggestions.find((entry) => entry.id === id);
        if (!found) throw new MediaListError(404, 'not_found', 'Такого предложения нет.');
        if (found.by !== userId)
          throw new MediaListError(403, 'forbidden', 'Отозвать можно только своё предложение.');
        if (found.status !== 'open')
          throw new MediaListError(409, 'decided', 'Администратор уже ответил на это предложение.');
        data.suggestions = data.suggestions.filter((entry) => entry.id !== id);
      });
    },

    decideSuggestion(id, status) {
      return commit(() => {
        const found = data.suggestions.find((entry) => entry.id === id);
        if (!found) throw new MediaListError(404, 'not_found', 'Такого предложения нет.');
        found.status = status;
        found.decidedAt = status === 'open' ? null : isoNow(options.clock);
        return { ...found };
      });
    },

    removeSuggestion(id) {
      return commit(() => {
        if (!data.suggestions.some((entry) => entry.id === id))
          throw new MediaListError(404, 'not_found', 'Такого предложения нет.');
        data.suggestions = data.suggestions.filter((entry) => entry.id !== id);
      });
    },

    forget(userId) {
      return commit(() => {
        delete data.users[userId];
      });
    },

    idle() {
      return queue.idle();
    },
  };

  /** A file that cannot be read is moved aside (never overwritten by the first new mark). */
  async function keepDamaged(): Promise<void> {
    const stamp = isoNow(options.clock).replace(/[:.]/g, '-');
    await renameWithRetry(file, path.join(options.dataDir, `media-lists.damaged-${stamp}.json`)).catch(
      () => undefined,
    );
  }
}
