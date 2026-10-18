/**
 * «Новое» and «Для вас» of the cinema: pure functions over the library as the portal knows it.
 * Nothing here talks to Jellyfin or to a disk, and nothing is random: the same library and the same
 * marks always give the same rows in the same order (so a test can name the exact answer).
 *
 * Recommendations come only from local data: the genres and kinds of what this person favourited,
 * watched or started, and — as a gentle boost — how MANY other people in the family watched or
 * favourited an item. The counts are all that arrives here; who they are never does.
 */
import type { CatalogKind } from '../../../shared/api.ts';
import type { CatalogEntry } from './client.ts';

export const NEWS_DAYS = 14;
export const NEWS_LIMIT = 30;
export const FOR_YOU_LIMIT = 12;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A clock a little ahead of Jellyfin's must not hide a file that was added a minute ago. */
const NEWS_FUTURE_SLACK_MS = DAY_MS;

/** Items added to the library in the last 14 days, newest first. */
export function newsOf(entries: readonly CatalogEntry[], nowMs: number, days = NEWS_DAYS): CatalogEntry[] {
  const since = nowMs - days * DAY_MS;
  return entries
    .filter((entry) => {
      const added = entry.addedAt ? Date.parse(entry.addedAt) : Number.NaN;
      return !Number.isNaN(added) && added >= since && added <= nowMs + NEWS_FUTURE_SLACK_MS;
    })
    .sort(
      (a, b) =>
        Date.parse(b.addedAt as string) - Date.parse(a.addedAt as string) ||
        a.title.localeCompare(b.title, 'ru') ||
        a.id.localeCompare(b.id),
    )
    .slice(0, NEWS_LIMIT);
}

export type SignalRole = 'favourite' | 'watched' | 'watching';

/** One thing this person did with a title (a series stands for its episodes). */
export interface Signal {
  entry: CatalogEntry;
  role: SignalRole;
}

const WEIGHT: Record<SignalRole, number> = { favourite: 3, watched: 2, watching: 1 };

export interface Recommendation {
  entry: CatalogEntry;
  reason: string;
  score: number;
}

export interface RecommendInput {
  /** Every title of the library. */
  candidates: readonly CatalogEntry[];
  /** What the person did, the newest first (the order settles ties). */
  signals: readonly Signal[];
  /** Ids that must not be offered: seen, started, already on one of the person's lists. */
  exclude: ReadonlySet<string>;
  /** How many OTHER people watched or favourited each id. Counts only. */
  community: ReadonlyMap<string, number>;
  limit?: number;
}

export interface RecommendResult {
  items: Recommendation[];
  /** Why there is nothing, in plain words; null when something was found. */
  hint: string | null;
}

const KIND_REASON: Partial<Record<CatalogKind, string>> = {
  movie: 'Вы смотрите фильмы — этот вы ещё не видели',
  series: 'Вы смотрите сериалы — этот вы ещё не видели',
  video: 'Вы смотрите видео — это вы ещё не видели',
  album: 'Вы слушаете музыку — этого альбома вы ещё не слушали',
  book: 'Вы слушаете аудиокниги — эту вы ещё не слушали',
};

/** Russian plural: 1 человек, 2 человека, 5 человек. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

const quoted = (text: string) => `„${text}“`;

function communityReason(count: number): string {
  return `Уже смотрели или отметили: ${count} ${pluralRu(count, 'человек', 'человека', 'человек')} из семьи`;
}

function genreReason(signal: Signal, genre: string): string {
  const title = quoted(signal.entry.title);
  if (signal.role === 'favourite') return `В избранном есть ${title} в жанре ${quoted(genre)}`;
  if (signal.role === 'watching') return `Вы начали смотреть ${title} в жанре ${quoted(genre)}`;
  return `Вы смотрели ещё ${title} в жанре ${quoted(genre)}`;
}

const NOTHING_YET =
  'Отметьте сердечком несколько фильмов или посмотрите что-нибудь — и здесь появятся подсказки.';
const NOTHING_LEFT =
  'Пока нечего предложить: всё подходящее вы уже смотрели или сохранили. Загляните позже или предложите фильм.';

/** Deterministic «Для вас»: unseen titles, by shared genres and kinds, lifted by how many others in the family liked them. */
export function recommend(input: RecommendInput): RecommendResult {
  const limit = input.limit ?? FOR_YOU_LIMIT;
  const genreWeight = new Map<string, number>();
  const kindWeight = new Map<CatalogKind, number>();
  let total = 0;
  for (const signal of input.signals) {
    const weight = WEIGHT[signal.role];
    total += weight;
    kindWeight.set(signal.entry.kind, (kindWeight.get(signal.entry.kind) ?? 0) + weight);
    for (const genre of new Set(signal.entry.genres)) {
      genreWeight.set(genre, (genreWeight.get(genre) ?? 0) + weight);
    }
  }

  const scored: Recommendation[] = [];
  for (const candidate of input.candidates) {
    if (input.exclude.has(candidate.id)) continue;
    const others = Math.min(input.community.get(candidate.id) ?? 0, 3);
    let genreShare = 0;
    if (total > 0) {
      let sum = 0;
      for (const genre of new Set(candidate.genres)) sum += genreWeight.get(genre) ?? 0;
      genreShare = Math.min(sum / total, 2);
    }
    const kindShare = total > 0 ? (kindWeight.get(candidate.kind) ?? 0) / total : 0;
    if (genreShare === 0 && kindShare === 0 && others === 0) continue;
    const score = 4 * genreShare + 2 * kindShare + 1.5 * others + (candidate.rating ?? 0) / 20;

    let reason: string | null = null;
    if (genreShare > 0) {
      // The best shared genre, then the strongest (and, on a tie, the newest) thing the person did with it.
      let bestGenre: string | null = null;
      for (const genre of candidate.genres) {
        const weight = genreWeight.get(genre) ?? 0;
        if (weight > 0 && (bestGenre === null || weight > (genreWeight.get(bestGenre) ?? 0))) bestGenre = genre;
      }
      if (bestGenre !== null) {
        let source: Signal | null = null;
        for (const signal of input.signals) {
          if (!signal.entry.genres.includes(bestGenre)) continue;
          if (source === null || WEIGHT[signal.role] > WEIGHT[source.role]) source = signal;
        }
        if (source) reason = genreReason(source, bestGenre);
      }
    }
    if (reason === null && others > 0) reason = communityReason(input.community.get(candidate.id) ?? others);
    if (reason === null) reason = KIND_REASON[candidate.kind] ?? 'Похоже на то, что вы смотрите';
    scored.push({ entry: candidate, reason, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.entry.rating ?? 0) - (a.entry.rating ?? 0) ||
      a.entry.title.localeCompare(b.entry.title, 'ru') ||
      a.entry.id.localeCompare(b.entry.id),
  );
  const items = scored.slice(0, limit);
  if (items.length > 0) return { items, hint: null };
  return { items, hint: input.signals.length === 0 ? NOTHING_YET : NOTHING_LEFT };
}
