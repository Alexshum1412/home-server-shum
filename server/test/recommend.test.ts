import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../src/jellyfin/client.ts';
import { newsOf, NEWS_LIMIT, pluralRu, recommend, type Signal } from '../src/jellyfin/recommend.ts';

const id = (n: number) => n.toString(16).padStart(32, '0');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function entry(n: number, title: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: id(n),
    title,
    kind: 'movie',
    year: 2020,
    genres: [],
    runtimeMin: 90,
    rating: null,
    hasPoster: true,
    seriesTitle: null,
    season: null,
    episode: null,
    resumeSec: null,
    durationSec: null,
    addedAt: ago(60),
    parentId: null,
    ...over,
  };
}

const lighthouse = entry(1, 'Тайна старого маяка', { genres: ['Приключения'], rating: 7.1 });
const courier = entry(2, 'Звёздный курьер', { genres: ['Фантастика', 'Приключения'], rating: 8.2 });
const holidays = entry(3, 'Весёлые каникулы', { genres: ['Комедия', 'Семейный'], rating: 7.8 });
const drama = entry(4, 'Фильм без обложки', { genres: ['Драма'] });
const cat = entry(10, 'Приключения кота Мурзика', {
  kind: 'series',
  genres: ['Мультфильм', 'Семейный'],
  rating: 8.5,
});
const songs = entry(30, 'Семейные песни', { kind: 'album', genres: ['Детская'] });
const LIBRARY = [lighthouse, courier, holidays, drama, cat, songs];
const none = new Set<string>();
const nobody = new Map<string, number>();

describe('news: added in the last 14 days', () => {
  it('lists only the recent ones, the newest first, ties by title', () => {
    const library = [
      entry(1, 'Старое', { addedAt: ago(15) }),
      entry(2, 'Вчера', { addedAt: ago(1) }),
      entry(3, 'Неделю назад', { addedAt: ago(7) }),
      entry(4, 'Без даты', { addedAt: null }),
      entry(5, 'Ровно две недели', { addedAt: ago(14) }),
      entry(6, 'Я', { addedAt: ago(1) }),
      entry(7, 'Из будущего', { addedAt: new Date(NOW + 5 * DAY).toISOString() }),
    ];
    expect(newsOf(library, NOW).map((item) => item.title)).toEqual([
      'Вчера',
      'Я',
      'Неделю назад',
      'Ровно две недели',
    ]);
  });

  it('a clock a few hours ahead of Jellyfin does not hide a file added a minute ago', () => {
    const library = [entry(1, 'Только что', { addedAt: new Date(NOW + 3 * 60 * 60 * 1000).toISOString() })];
    expect(newsOf(library, NOW)).toHaveLength(1);
  });

  it('shows a bounded number', () => {
    const library = Array.from({ length: NEWS_LIMIT + 5 }, (_, i) => entry(i + 1, `Фильм ${i}`, { addedAt: ago(1) }));
    expect(newsOf(library, NOW)).toHaveLength(NEWS_LIMIT);
  });
});

describe('«Для вас»', () => {
  const favouriteLighthouse: Signal[] = [{ entry: lighthouse, role: 'favourite' }];

  it('offers unseen titles of the genres the person likes, first, and says why', () => {
    const result = recommend({
      candidates: LIBRARY,
      signals: favouriteLighthouse,
      exclude: new Set([lighthouse.id]),
      community: nobody,
    });
    expect(result.hint).toBeNull();
    const first = result.items[0];
    expect(first?.entry.title).toBe('Звёздный курьер');
    expect(first?.reason).toBe('В избранном есть „Тайна старого маяка“ в жанре „Приключения“');
    // never what is excluded
    expect(result.items.map((item) => item.entry.id)).not.toContain(lighthouse.id);
    // the same kind comes after, with an honest, general reason
    const drama2 = result.items.find((item) => item.entry.title === 'Фильм без обложки');
    expect(drama2?.reason).toBe('Вы смотрите фильмы — этот вы ещё не видели');
    // a title with nothing in common (an album) is not offered at all
    expect(result.items.map((item) => item.entry.title)).not.toContain('Семейные песни');
  });

  it('words the reason after what the person did: watched, started, favourite', () => {
    const watched = recommend({
      candidates: [courier],
      signals: [{ entry: lighthouse, role: 'watched' }],
      exclude: none,
      community: nobody,
    });
    expect(watched.items[0]?.reason).toBe('Вы смотрели ещё „Тайна старого маяка“ в жанре „Приключения“');
    const started = recommend({
      candidates: [courier],
      signals: [{ entry: lighthouse, role: 'watching' }],
      exclude: none,
      community: nobody,
    });
    expect(started.items[0]?.reason).toBe('Вы начали смотреть „Тайна старого маяка“ в жанре „Приключения“');
  });

  it('names the strongest thing behind the best shared genre', () => {
    const result = recommend({
      candidates: [courier],
      signals: [
        { entry: lighthouse, role: 'watching' },
        { entry: entry(5, 'Другое приключение', { genres: ['Приключения'] }), role: 'favourite' },
      ],
      exclude: none,
      community: nobody,
    });
    expect(result.items[0]?.reason).toBe('В избранном есть „Другое приключение“ в жанре „Приключения“');
  });

  it('what many others in the family like is lifted, by number only', () => {
    const community = new Map([[holidays.id, 3]]);
    const lifted = recommend({
      candidates: [courier, holidays],
      signals: favouriteLighthouse,
      exclude: none,
      community,
    });
    expect(lifted.items.map((item) => item.entry.title)).toEqual(['Весёлые каникулы', 'Звёздный курьер']);
    // no shared genre: the reason is the count
    expect(lifted.items[0]?.reason).toBe('Уже смотрели или отметили: 3 человека из семьи');
    expect(JSON.stringify(lifted)).not.toMatch(/mama|papa|user/i);
  });

  it('the boost is bounded, so one popular title does not push out a good match forever', () => {
    const community = new Map([[holidays.id, 50]]);
    const result = recommend({ candidates: [courier, holidays], signals: favouriteLighthouse, exclude: none, community });
    expect(result.items[0]?.reason).toBe('Уже смотрели или отметили: 50 человек из семьи');
    const sameBoost = recommend({
      candidates: [courier, holidays],
      signals: favouriteLighthouse,
      exclude: none,
      community: new Map([[holidays.id, 3]]),
    });
    expect(sameBoost.items.map((i) => i.score)).toEqual(result.items.map((i) => i.score));
  });

  it('with nothing marked yet, only what the family likes is offered; with nothing at all, it says how to start', () => {
    const empty = recommend({ candidates: LIBRARY, signals: [], exclude: none, community: nobody });
    expect(empty.items).toEqual([]);
    expect(empty.hint).toContain('Отметьте сердечком');
    const social = recommend({
      candidates: LIBRARY,
      signals: [],
      exclude: none,
      community: new Map([[cat.id, 1]]),
    });
    expect(social.items.map((item) => [item.entry.title, item.reason])).toEqual([
      ['Приключения кота Мурзика', 'Уже смотрели или отметили: 1 человек из семьи'],
    ]);
  });

  it('when everything suitable is seen, says that and does not invent', () => {
    const result = recommend({
      candidates: LIBRARY,
      signals: favouriteLighthouse,
      exclude: new Set(LIBRARY.map((item) => item.id)),
      community: nobody,
    });
    expect(result.items).toEqual([]);
    expect(result.hint).toContain('нечего предложить');
  });

  it('is deterministic: the order of the library does not change the answer', () => {
    const base = {
      signals: [
        { entry: lighthouse, role: 'favourite' },
        { entry: cat, role: 'watched' },
      ] as Signal[],
      exclude: new Set([lighthouse.id, cat.id]),
      community: new Map([[holidays.id, 1]]),
    };
    const a = recommend({ ...base, candidates: LIBRARY });
    const b = recommend({ ...base, candidates: [...LIBRARY].reverse() });
    const c = recommend({ ...base, candidates: [songs, drama, holidays, courier, cat, lighthouse] });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(recommend({ ...base, candidates: LIBRARY })).toEqual(a);
  });

  it('is cut to the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(100 + i, `Приключение ${i}`, { genres: ['Приключения'] }));
    const result = recommend({ candidates: many, signals: favouriteLighthouse, exclude: none, community: nobody, limit: 5 });
    expect(result.items).toHaveLength(5);
  });
});

describe('Russian plural', () => {
  it.each([
    [1, 'человек'],
    [2, 'человека'],
    [4, 'человека'],
    [5, 'человек'],
    [11, 'человек'],
    [12, 'человек'],
    [21, 'человек'],
    [22, 'человека'],
    [100, 'человек'],
  ])('%i → %s', (n, expected) => {
    expect(pluralRu(n, 'человек', 'человека', 'человек')).toBe(expected);
  });
});
