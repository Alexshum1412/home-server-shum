/**
 * The personal rows of the cinema's start page, built for ONE person from the library (Jellyfin, kept
 * for a minute), that person's marks and saved places, and bare counts of what the others did.
 * Another person's list never gets in here; the only thing that looks across people is the counts.
 */
import type { CatalogItem, CatalogShelfEntry, CatalogShelvesResponse } from '../../../shared/api.ts';
import type { Clock } from '../lib/time.ts';
import { type CatalogEntry, type JellyfinClient, JellyfinError } from './client.ts';
import type { MediaLists, WatchedTarget } from './lists.ts';
import type { ProgressStore } from './progress.ts';
import { FOR_YOU_LIMIT, newsOf, recommend, type Signal } from './recommend.ts';

/** One shelf shows at most this many (the lists themselves may be longer). */
export const SHELF_LIMIT = 200;
export const HISTORY_LIMIT = 100;
/** How many of the latest marks feed the recommendations. */
const SIGNALS_FAVOURITE = 60;
const SIGNALS_WATCHED = 80;
const SIGNALS_WATCHING = 30;
/** Items that are not cards of the library (episodes, chapters) are looked up in one go, at most this many. */
const LOOKUP_LIMIT = 160;

export interface ShelvesDeps {
  client: JellyfinClient;
  progress: ProgressStore;
  lists: MediaLists;
  clock: Clock;
}

export interface Shelves {
  build(userId: string): Promise<CatalogShelvesResponse>;
  /** What the portal needs to know about an item that is about to be marked (null: Jellyfin has no such item). */
  describe(itemId: string): Promise<CatalogEntry | null>;
  /** For the automatic «просмотрено»: the series of the item and whether it counts. */
  watchedTarget(itemId: string): Promise<WatchedTarget | null>;
}

const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

export function createShelves(deps: ShelvesDeps): Shelves {
  const { client, progress, lists, clock } = deps;

  /** The card without the library-only fields, with the saved place of this person. */
  function card(entry: CatalogEntry, userId: string): CatalogItem {
    const { addedAt: _addedAt, parentId: _parentId, ...item } = entry;
    const saved = progress.get(userId, entry.id);
    return {
      ...item,
      resumeSec: saved ? Math.round(saved.positionSec) : null,
      durationSec: saved ? Math.round(saved.durationSec) : item.durationSec,
    };
  }

  const shelfEntry = (
    entry: CatalogEntry,
    userId: string,
    note: string | null,
    at: string | null,
  ): CatalogShelfEntry => ({ item: card(entry, userId), note, at });

  return {
    async build(userId) {
      const marks = lists.marks(userId);
      const openSuggestions = lists.suggestions().filter((entry) => entry.status === 'open').length;
      const base: CatalogShelvesResponse = {
        marks,
        reason: null,
        forYou: [],
        forYouHint: null,
        news: [],
        later: [],
        favourites: [],
        history: [],
        openSuggestions,
      };
      const reason = await client.availability();
      if (reason !== null) return { ...base, reason };

      try {
        const library = await client.scan();
        const known = new Map<string, CatalogEntry>(library.map((entry) => [entry.id, entry]));

        const favourites = lists.favourites(userId);
        const wishes = lists.later(userId);
        const watched = lists.watched(userId);
        const saved = progress.entries(userId);

        // Episodes and chapters are not cards of the library: look up the few that the rows mention.
        const wanted = [
          ...favourites.slice(0, SHELF_LIMIT),
          ...wishes.slice(0, SHELF_LIMIT),
          ...watched.slice(0, HISTORY_LIMIT),
          ...saved.slice(0, HISTORY_LIMIT),
        ].map((mark) => mark.id);
        const missing = [...new Set(wanted)].filter((id) => !known.has(id)).slice(0, LOOKUP_LIMIT);
        if (missing.length > 0) {
          for (const entry of await client.entriesByIds(missing)) known.set(entry.id, entry);
        }

        const news = newsOf(library, clock().getTime()).map((entry) =>
          shelfEntry(entry, userId, null, entry.addedAt),
        );

        const onShelf = (marked: Array<{ id: string; at: string }>): CatalogShelfEntry[] => {
          const out: CatalogShelfEntry[] = [];
          for (const mark of marked) {
            const entry = known.get(mark.id);
            if (entry) out.push(shelfEntry(entry, userId, null, mark.at));
            if (out.length >= SHELF_LIMIT) break;
          }
          return out;
        };

        // History: finished items (with the day they were marked) and started ones (with the last time), newest first.
        const story = new Map<string, { at: string; watched: boolean }>();
        for (const mark of watched) story.set(mark.id, { at: mark.at, watched: true });
        for (const place of saved) {
          const before = story.get(place.id);
          story.set(
            place.id,
            before
              ? { at: later(before.at, place.updatedAt), watched: true }
              : { at: place.updatedAt, watched: false },
          );
        }
        const history: CatalogShelfEntry[] = [];
        const ordered = [...story].sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at));
        for (const [id, state] of ordered) {
          const entry = known.get(id);
          if (entry)
            history.push(shelfEntry(entry, userId, state.watched ? 'Просмотрено' : 'Смотрю', state.at));
          if (history.length >= HISTORY_LIMIT) break;
        }

        // «Для вас»: the person's own marks say what they like; the others only lift by how many they are.
        // An episode or a chapter stands for its series or book; when that is not known, it says nothing.
        const titleOf = (id: string, parent: string | null): CatalogEntry | undefined => {
          const entry = known.get(id);
          const owner = parent ?? entry?.parentId ?? null;
          return owner ? known.get(owner) : entry;
        };
        const signals: Signal[] = [];
        for (const mark of favourites.slice(0, SIGNALS_FAVOURITE)) {
          const entry = titleOf(mark.id, mark.parent);
          if (entry) signals.push({ entry, role: 'favourite' });
        }
        for (const mark of watched.slice(0, SIGNALS_WATCHED)) {
          const entry = titleOf(mark.id, mark.parent);
          if (entry) signals.push({ entry, role: 'watched' });
        }
        for (const place of saved.slice(0, SIGNALS_WATCHING)) {
          const entry = titleOf(place.id, null);
          if (entry) signals.push({ entry, role: 'watching' });
        }

        const exclude = lists.seenIds(userId);
        for (const mark of [...favourites, ...wishes]) {
          exclude.add(mark.id);
          if (mark.parent) exclude.add(mark.parent);
        }
        for (const place of saved) {
          exclude.add(place.id);
          const parent = known.get(place.id)?.parentId;
          if (parent) exclude.add(parent);
        }
        const found = recommend({
          candidates: library,
          signals,
          exclude,
          community: lists.community(userId),
          limit: FOR_YOU_LIMIT,
        });

        return {
          ...base,
          forYou: found.items.map((item) => shelfEntry(item.entry, userId, item.reason, item.entry.addedAt)),
          forYouHint: found.hint,
          news,
          later: onShelf(wishes),
          favourites: onShelf(favourites),
          history,
        };
      } catch (error) {
        if (error instanceof JellyfinError) return { ...base, reason: error.message };
        throw error;
      }
    },

    async describe(itemId) {
      const [entry] = await client.entriesByIds([itemId]);
      return entry ?? null;
    },

    async watchedTarget(itemId) {
      const [entry] = await client.entriesByIds([itemId]);
      if (!entry) return null;
      return { parent: entry.parentId, countable: entry.kind !== 'track' };
    },
  };
}
