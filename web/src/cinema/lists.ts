/**
 * The pure part of the cinema's personal lists: which mark an item has, how a list is narrowed by the
 * page's search and filters, and how dates and states are worded. No network, no DOM, so it is tested alone.
 */
import type {
  CatalogItem,
  CatalogKind,
  CatalogLibrary,
  CatalogMarks,
  CatalogShelfEntry,
  CatalogShelvesResponse,
  CatalogSuggestionStatus,
} from '../../../shared/api.ts';

export type MarkFlag = 'favourite' | 'later' | 'watched';

/** The rows that have a page of their own («Показать все») and a chip in «Мои подборки». */
export const VIEWS = ['foryou', 'news', 'later', 'favourites', 'history'] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_TITLE: Record<View, string> = {
  foryou: 'Для вас',
  news: 'Новое',
  later: 'Мой список',
  favourites: 'Избранное',
  history: 'История: что я смотрел',
};

/** Short names for the chips (the history keeps its row title for the page itself). */
export const VIEW_CHIP: Record<View, string> = {
  foryou: 'Для вас',
  news: 'Новое',
  later: 'Мой список',
  favourites: 'Избранное',
  history: 'История',
};

export function readView(value: string): View | '' {
  return (VIEWS as readonly string[]).includes(value) ? (value as View) : '';
}

export interface MarkSets {
  favourite: ReadonlySet<string>;
  later: ReadonlySet<string>;
  watched: ReadonlySet<string>;
}

export function toSets(marks: CatalogMarks | null): MarkSets {
  return {
    favourite: new Set(marks?.favourites ?? []),
    later: new Set(marks?.later ?? []),
    watched: new Set(marks?.watched ?? []),
  };
}

export type WatchState = 'watched' | 'watching' | 'none';

/** Finished beats started; started is «there is a saved place» (the portal's own record of this person). */
export function watchState(sets: MarkSets, item: Pick<CatalogItem, 'id' | 'resumeSec'>): WatchState {
  if (sets.watched.has(item.id)) return 'watched';
  return item.resumeSec !== null && item.resumeSec > 0 ? 'watching' : 'none';
}

/** The item kinds a library section holds (the «type» filter of the lists, which carry no library id). */
export function kindsOfLibrary(kind: CatalogLibrary['kind']): readonly CatalogKind[] | null {
  switch (kind) {
    case 'movies':
      return ['movie', 'video'];
    case 'tvshows':
      return ['series', 'season', 'episode'];
    case 'music':
      return ['album', 'track'];
    case 'books':
      return ['book', 'audiobook'];
    case 'homevideos':
      return ['video', 'movie'];
    default:
      return null;
  }
}

export interface ListFilter {
  /** Kinds allowed, or null for every kind. */
  kinds: readonly CatalogKind[] | null;
  genre: string;
  /** Part of the title, any case. */
  q: string;
}

const lower = (text: string) => text.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');

/** The same three narrowings the library search has — type, genre, title — applied to a list the page already holds. */
export function filterEntries(
  entries: readonly CatalogShelfEntry[],
  filter: ListFilter,
): CatalogShelfEntry[] {
  const needle = lower(filter.q.trim());
  return entries.filter(({ item }) => {
    if (filter.kinds !== null && !filter.kinds.includes(item.kind)) return false;
    if (filter.genre !== '' && !item.genres.includes(filter.genre)) return false;
    if (needle === '') return true;
    return lower(`${item.title} ${item.seriesTitle ?? ''}`).includes(needle);
  });
}

export function entriesOf(shelves: CatalogShelvesResponse, view: View): CatalogShelfEntry[] {
  switch (view) {
    case 'foryou':
      return shelves.forYou;
    case 'news':
      return shelves.news;
    case 'later':
      return shelves.later;
    case 'favourites':
      return shelves.favourites;
    case 'history':
      return shelves.history;
  }
}

// --- words and dates -----------------------------------------------------------------------

const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dayYearFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const clockFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** «сегодня в 20:15», «вчера в 09:30», «17 октября», «3 марта 2025». */
export function whenLabel(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (sameDay(date, now)) return `сегодня в ${clockFormat.format(date)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `вчера в ${clockFormat.format(date)}`;
  return (date.getFullYear() === now.getFullYear() ? dayFormat : dayYearFormat).format(date);
}

/** The line under a card: the reason, the state with its date, or when it was added. Empty when there is nothing to say. */
export function noteOf(view: View, entry: CatalogShelfEntry, now: Date = new Date()): string {
  if (view === 'foryou') return entry.note ?? '';
  if (view === 'news') return entry.at ? `Добавлено ${whenLabel(entry.at, now)}` : '';
  if (view === 'history') return [entry.note, whenLabel(entry.at, now)].filter((part) => part).join(' · ');
  return '';
}

export interface SuggestionStatusView {
  label: string;
  tone: 'info' | 'ok' | 'neutral';
}

export const SUGGESTION_STATUS: Record<CatalogSuggestionStatus, SuggestionStatusView> = {
  open: { label: 'Ждёт ответа', tone: 'info' },
  added: { label: 'Добавлено', tone: 'ok' },
  declined: { label: 'Отклонено', tone: 'neutral' },
};

/** «Ждут ответа: 3» for the button; nothing when none wait. */
export function waitingLabel(count: number): string {
  return count > 0 ? `ждут ответа: ${count}` : '';
}
