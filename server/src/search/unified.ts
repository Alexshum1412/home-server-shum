/**
 * One search box for the whole portal (Ctrl+K). It asks each place for what THIS person may see and
 * nothing else — there is no administrator shortcut: another person's private files, notes, events,
 * tasks and chats never appear, whoever asks. Search is by words of the title or text; files and
 * photos by NAME only (never by content). Every source is bounded in time and size, and a source that
 * fails is reported as «недоступно» with a reason instead of an empty list that looks like «ничего нет».
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { StorageSpace } from '../../../shared/api.ts';
import {
  SEARCH_KINDS,
  SEARCH_LABEL,
  type SearchGroup,
  type SearchHit,
  type SearchKind,
  type SearchResponse,
} from '../../../shared/search.ts';
import type { StoredUser, UserStore } from '../auth/users.ts';
import { type ChatStore, type ConversationRec, FAMILY_ID } from '../chat/store.ts';
import type { Config } from '../config.ts';
import { type FoundFile, normalise, searchNames, words } from '../files/search.ts';
import type { Storage } from '../files/storage.ts';
import { type JellyfinClient, JellyfinError } from '../jellyfin/client.ts';
import type { Clock } from '../lib/time.ts';
import type { CalendarStore } from '../planner/calendar.ts';
import { addDays, occursOn } from '../planner/dates.ts';
import { NOTE_EXT, NOTES_FOLDER } from '../planner/notes.ts';

export const QUERY_MAX = 80;
export const DEFAULT_LIMIT = 6;
export const MAX_LIMIT = 30;
/** One source that does not answer within this time is shown as unavailable; the others still arrive. */
export const SOURCE_TIMEOUT_MS = 4000;

const NOTE_SCAN_FILES = 300;
const NOTE_SCAN_BYTES = 64 * 1024;
const CHAT_SCAN_MESSAGES = 5000;
const HITS_PER_CHAT = 3;

export type TaskSearch = (user: StoredUser, query: string, limit: number) => Promise<SearchHit[]>;

export interface UnifiedSearchDeps {
  config: Pick<Config, 'filesDir' | 'photosDir'>;
  clock: Clock;
  catalog: JellyfinClient;
  calendar: Pick<CalendarStore, 'visibleEvents'>;
  storage: Pick<Storage, 'spaceDir'>;
  chatStore: Pick<ChatStore, 'conversations' | 'messages'>;
  users: Pick<UserStore, 'list'>;
  /** The family tasks (optional until that part exists). */
  tasks?: TaskSearch;
}

export interface UnifiedSearch {
  search(
    user: StoredUser,
    query: string,
    options?: { kinds?: readonly SearchKind[]; limit?: number },
  ): Promise<SearchResponse>;
}

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** «2026-03-05» → «5 марта 2026». */
export function russianDate(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const name = MONTHS[(month ?? 1) - 1];
  return year && month && date && name ? `${date} ${name} ${year}` : day;
}

const MEDIA_KIND: Record<string, string> = {
  movie: 'Фильм',
  series: 'Сериал',
  season: 'Сезон',
  episode: 'Серия',
  track: 'Трек',
  album: 'Альбом',
  book: 'Аудиокнига',
  audiobook: 'Глава',
  video: 'Видео',
  other: 'Файл',
};

/** A piece of `text` around the first of the words, for a line under the title. */
export function snippet(text: string, stems: readonly string[], radius = 45): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = normalise(flat);
  let at = -1;
  for (const stem of stems) {
    const index = lower.indexOf(stem);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) return flat.slice(0, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(flat.length, at + radius);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}

/** Words of a sentence that are not part of a name: «фото на даче» is a search for «фото» and «дача». */
const LITTLE_WORDS = new Set([
  'на',
  'в',
  'во',
  'и',
  'по',
  'за',
  'из',
  'от',
  'до',
  'для',
  'про',
  'что',
  'как',
  'где',
  'мой',
  'моя',
  'мои',
  'моё',
  'наш',
  'наша',
  'наши',
  'найди',
  'найти',
  'покажи',
]);

/** The query without little words (kept as it was when nothing else is left). */
export function significant(query: string): string {
  const tokens = query.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
  const kept = tokens.filter((token) => !LITTLE_WORDS.has(normalise(token)));
  return (kept.length > 0 ? kept : tokens).join(' ');
}

const matchesAll = (text: string, stems: readonly string[]): boolean => {
  const lower = normalise(text);
  return stems.every((stem) => lower.includes(stem));
};

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Link to a file or a photo found by name (the same places the pages open). */
export function fileHref(root: 'files' | 'photos', file: FoundFile): string {
  const params = new URLSearchParams({ space: file.space });
  if (root === 'photos') {
    const month = file.folder.split('/')[0] ?? '';
    if (month) params.set('month', month);
    return `/photos?${params.toString()}`;
  }
  const folder = file.isFolder ? (file.folder ? `${file.folder}/${file.name}` : file.name) : file.folder;
  if (folder) params.set('path', folder);
  return `/files?${params.toString()}`;
}

const isNotesFolder = (file: FoundFile): boolean =>
  file.root === 'files' && (file.folder === NOTES_FOLDER || file.folder.startsWith(`${NOTES_FOLDER}/`));

export function createUnifiedSearch(deps: UnifiedSearchDeps): UnifiedSearch {
  const { config, clock } = deps;

  const group = (kind: SearchKind, hits: SearchHit[], limit: number): SearchGroup => ({
    kind,
    label: SEARCH_LABEL[kind],
    hits: hits.slice(0, limit),
    more: hits.length > limit,
    unavailable: null,
  });

  // --- places -----------------------------------------------------------------------------------

  async function media(stems: string[], limit: number): Promise<SearchHit[]> {
    const longest = [...stems].sort((a, b) => b.length - a.length)[0];
    const page = await deps.catalog.list(
      { sort: 'name', start: 0, limit: 60, ...(longest ? { search: longest } : {}) },
      () => undefined,
    );
    return page.items
      .filter((item) => matchesAll(`${item.title} ${item.seriesTitle ?? ''}`, stems))
      .slice(0, limit + 1)
      .map((item) => ({
        id: `media:${item.id}`,
        kind: 'media' as const,
        title: item.title,
        detail: [
          MEDIA_KIND[item.kind] ?? 'Файл',
          item.seriesTitle && item.seriesTitle !== item.title ? item.seriesTitle : null,
          item.year ? String(item.year) : null,
        ]
          .filter(Boolean)
          .join(', '),
        href: `/cinema?item=${encodeURIComponent(item.id)}`,
      }));
  }

  async function filesIn(
    root: 'files' | 'photos',
    user: StoredUser,
    query: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const base = root === 'files' ? config.filesDir : config.photosDir;
    const places: Array<{ root: string; space: StorageSpace; dir: string }> = [
      { root, space: 'personal', dir: path.join(base, 'users', user.username) },
      { root, space: 'shared', dir: path.join(base, 'shared') },
    ];
    const found = await searchNames(places, query, {
      maxResults: limit * 3,
      maxVisited: 30_000,
      maxDepth: 7,
    });
    return found
      .filter((file) => !isNotesFolder(file))
      .slice(0, limit + 1)
      .map((file) => ({
        id: `${root}:${file.space}:${file.folder}/${file.name}`,
        kind: root,
        title: file.name,
        detail: `${root === 'photos' ? 'Фото' : 'Файлы'} / ${file.space === 'shared' ? 'общее' : 'личное'}${
          file.folder ? ` / ${file.folder}` : ''
        }`,
        href: fileHref(root, file),
      }));
  }

  async function notes(user: StoredUser, stems: string[]): Promise<SearchHit[]> {
    const hits: Array<SearchHit & { at: number }> = [];
    for (const space of ['personal', 'shared'] as const) {
      const dir = path.join(deps.storage.spaceDir('files', space, user.username), NOTES_FOLDER);
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const fileName of names.slice(0, NOTE_SCAN_FILES)) {
        if (fileName.startsWith('.') || path.extname(fileName).toLowerCase() !== NOTE_EXT) continue;
        const full = path.join(dir, fileName);
        const stat = await fsp.lstat(full).catch(() => null);
        if (!stat?.isFile()) continue;
        const title = fileName.slice(0, -NOTE_EXT.length);
        let text = '';
        const handle = await fsp.open(full, 'r').catch(() => null);
        if (handle) {
          const buffer = Buffer.alloc(Math.min(NOTE_SCAN_BYTES, stat.size));
          await handle.read(buffer, 0, buffer.length, 0).catch(() => undefined);
          await handle.close();
          text = buffer.toString('utf8').replace(/^﻿/, '');
        }
        if (!matchesAll(`${title}\n${text}`, stems)) continue;
        hits.push({
          id: `notes:${space}:${title}`,
          kind: 'notes',
          title,
          detail: `${space === 'shared' ? 'Общая' : 'Личная'}: ${snippet(text, stems)}`,
          href: `/notes?${new URLSearchParams({ space, note: title }).toString()}`,
          at: stat.mtimeMs,
        });
      }
    }
    return hits.sort((a, b) => b.at - a.at).map(({ at: _at, ...hit }) => hit);
  }

  async function events(user: StoredUser, stems: string[]): Promise<SearchHit[]> {
    const now = clock();
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const list = await deps.calendar.visibleEvents({
      username: user.username,
      isAdmin: user.role === 'admin',
    });
    const found: Array<SearchHit & { sortKey: string }> = [];
    for (const event of list) {
      if (!matchesAll(`${event.title} ${event.note}`, stems)) continue;
      // The date to show: the next appearance of a repeating event, else the day itself.
      let day = event.date;
      if (event.repeat !== 'none' && event.date < today) {
        let next: string | null = null;
        for (let offset = 0; offset <= 1500 && next === null; offset += 1) {
          const candidate = addDays(today, offset);
          if (occursOn(event.date, event.repeat, candidate)) next = candidate;
        }
        day = next ?? event.date;
      }
      const when = `${russianDate(day)}${event.time ? `, ${event.time}` : ''}`;
      const repeat =
        event.repeat === 'weekly'
          ? ', каждую неделю'
          : event.repeat === 'monthly'
            ? ', каждый месяц'
            : event.repeat === 'yearly'
              ? ', каждый год'
              : '';
      found.push({
        id: `events:${event.id}`,
        kind: 'events',
        title: event.title,
        detail: `${when}${repeat}${event.private ? ' · личное' : ''}`,
        href: `/calendar?${new URLSearchParams({ day, month: day.slice(0, 7) }).toString()}`,
        // Coming events first (soonest first), then past ones (latest first).
        sortKey:
          day >= today
            ? `0${day}${event.time ?? ''}`
            : `1${String(99_999_999 - Number(day.replace(/-/g, '')))}`,
      });
    }
    return found.sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ sortKey: _key, ...hit }) => hit);
  }

  async function chats(user: StoredUser, stems: string[], limit: number): Promise<SearchHit[]> {
    const all = await deps.users.list();
    const names = new Map(all.map((person) => [person.id, person.displayName]));
    const titleOf = (conversation: ConversationRec): string => {
      if (conversation.kind === 'family' || conversation.id === FAMILY_ID) return 'Семейный чат';
      if (conversation.kind === 'group') return conversation.title ?? 'Группа';
      const other = conversation.members.find((id) => id !== user.id);
      return (other && names.get(other)) || 'Собеседник';
    };
    const found: Array<SearchHit & { at: string }> = [];
    for (const conversation of deps.chatStore.conversations()) {
      // Only conversations the person belongs to — the family room for everybody, the rest by membership.
      const member = conversation.kind === 'family' || conversation.members.includes(user.id);
      if (!member) continue;
      const messages = await deps.chatStore.messages(conversation.id).catch(() => []);
      let count = 0;
      for (
        let index = messages.length - 1;
        index >= 0 && index >= messages.length - CHAT_SCAN_MESSAGES;
        index -= 1
      ) {
        const message = messages[index];
        if (!message || message.deletedAt !== null || message.sys !== null || message.text === '') continue;
        if (!matchesAll(message.text, stems)) continue;
        const who =
          message.sender === user.id
            ? 'Вы'
            : message.sender
              ? (names.get(message.sender) ?? 'Бывший участник')
              : 'Сервер';
        found.push({
          id: `chats:${conversation.id}:${message.id}`,
          kind: 'chats',
          title: titleOf(conversation),
          detail: `${who}: ${snippet(message.text, stems)}`,
          href: `/chat?${new URLSearchParams({ c: conversation.id }).toString()}`,
          at: message.at,
        });
        count += 1;
        if (count >= HITS_PER_CHAT) break;
      }
    }
    return found
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit + 1)
      .map(({ at: _at, ...hit }) => hit);
  }

  // --- the answer -------------------------------------------------------------------------------

  return {
    async search(user, rawQuery, options = {}) {
      const typed = rawQuery.trim().slice(0, QUERY_MAX);
      // «фото на даче» looks for «фото» and «дач»: little words of the sentence are not part of a name.
      const query = significant(typed);
      const stems = words(query);
      const kinds = SEARCH_KINDS.filter((kind) => !options.kinds || options.kinds.includes(kind));
      const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      if (stems.length === 0) {
        return { query: typed, groups: kinds.map((kind) => group(kind, [], limit)) };
      }

      const run = async (kind: SearchKind): Promise<SearchGroup> => {
        try {
          let hits: SearchHit[];
          switch (kind) {
            case 'media':
              hits = await withTimeout(media(stems, limit), SOURCE_TIMEOUT_MS);
              break;
            case 'photos':
              hits = await withTimeout(filesIn('photos', user, query, limit), SOURCE_TIMEOUT_MS);
              break;
            case 'files':
              hits = await withTimeout(filesIn('files', user, query, limit), SOURCE_TIMEOUT_MS);
              break;
            case 'notes':
              hits = await withTimeout(notes(user, stems), SOURCE_TIMEOUT_MS);
              break;
            case 'events':
              hits = await withTimeout(events(user, stems), SOURCE_TIMEOUT_MS);
              break;
            case 'tasks':
              hits = deps.tasks
                ? await withTimeout(deps.tasks(user, query, limit + 1), SOURCE_TIMEOUT_MS)
                : [];
              break;
            case 'chats':
              hits = await withTimeout(chats(user, stems, limit), SOURCE_TIMEOUT_MS);
              break;
          }
          return group(kind, hits, limit);
        } catch (error) {
          let reason = 'Поиск здесь не ответил вовремя. Попробуйте ещё раз.';
          if (error instanceof JellyfinError) reason = 'Кинотеатр сейчас недоступен, фильмы не проверены.';
          else if ((error as Error).message !== 'timeout') reason = 'Здесь поиск сейчас не работает.';
          return { kind, label: SEARCH_LABEL[kind], hits: [], more: false, unavailable: reason };
        }
      };

      return { query: typed, groups: await Promise.all(kinds.map(run)) };
    },
  };
}
