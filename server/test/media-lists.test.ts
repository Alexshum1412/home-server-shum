import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMediaLists,
  MAX_FAVOURITES,
  MAX_OPEN_PER_PERSON,
  MediaListError,
  type MediaLists,
  NOTE_MAX,
  TITLE_MAX,
  titleKey,
} from '../src/jellyfin/lists.ts';
import { createFakeClock, type FakeClock, makeTempDir, removeDir } from './helpers.ts';

const id = (n: number) => n.toString(16).padStart(32, '0');
const MAMA = 'user-mama';
const PAPA = 'user-papa';
const SASHA = 'user-sasha';

let dir: string;
let clock: FakeClock;
let errors: string[];
let lists: MediaLists;

const open = (dataDir = dir) =>
  createMediaLists({ dataDir, clock, onError: (message) => errors.push(message) });

beforeEach(async () => {
  dir = await makeTempDir('fd-lists-');
  clock = createFakeClock('2026-10-16T10:00:00.000Z');
  errors = [];
  lists = open();
  await lists.load();
});

afterEach(async () => {
  await lists.idle();
  await removeDir(dir);
});

const later = (ms: number) => clock.advance(ms);

describe('favourites, «later» and watched', () => {
  it('keeps each list per person, the newest mark first', async () => {
    await lists.setFavourite(MAMA, id(1), true, null);
    later(1000);
    await lists.setFavourite(MAMA, id(2), true, null);
    later(1000);
    await lists.setLater(MAMA, id(3), true);
    expect(lists.marks(MAMA)).toEqual({ favourites: [id(2), id(1)], later: [id(3)], watched: [] });
    expect(lists.state(MAMA, id(1))).toEqual({ id: id(1), favourite: true, later: false, watched: false });

    await lists.setFavourite(MAMA, id(1), false, null);
    expect(lists.marks(MAMA).favourites).toEqual([id(2)]);
    // switching on twice changes nothing, not even the date
    later(5000);
    await lists.setFavourite(MAMA, id(2), true, null);
    expect(lists.favourites(MAMA)[0]?.at).toBe('2026-10-16T10:00:01.000Z');
  });

  it('watched by hand, both ways; a watched item leaves «Посмотреть позже»', async () => {
    await lists.setLater(MAMA, id(1), true);
    await lists.setWatched(MAMA, id(1), true, null);
    expect(lists.state(MAMA, id(1))).toMatchObject({ later: false, watched: true });
    expect(lists.watched(MAMA)[0]).toMatchObject({ id: id(1), how: 'manual' });
    await lists.setWatched(MAMA, id(1), false, null);
    expect(lists.state(MAMA, id(1)).watched).toBe(false);
    expect(lists.watched(MAMA)).toEqual([]);
  });

  it('refuses a list that grew past its limit, in plain words, and changes nothing', async () => {
    // a list that is already full, as it would be read from the disk
    const full = Object.fromEntries(
      Array.from({ length: MAX_FAVOURITES }, (_, i) => [
        id(i + 1),
        { at: '2026-10-01T10:00:00.000Z', parent: null },
      ]),
    );
    await writeFile(
      path.join(dir, 'media-lists.json'),
      JSON.stringify({ version: 1, users: { [MAMA]: { favourites: full } }, suggestions: [] }),
    );
    const crowded = open();
    await crowded.load();
    await expect(crowded.setFavourite(MAMA, id(9999), true, null)).rejects.toMatchObject({
      status: 409,
      code: 'too_many',
      message: expect.stringContaining('Уберите'),
    });
    expect(crowded.marks(MAMA).favourites).toHaveLength(MAX_FAVOURITES);
    // taking one off makes room again
    await crowded.setFavourite(MAMA, id(1), false, null);
    await crowded.setFavourite(MAMA, id(9999), true, null);
    expect(crowded.state(MAMA, id(9999)).favourite).toBe(true);
  });
});

describe('watched automatically from about 90 %', () => {
  const report = (user: string, item: string, position: number, duration = 1000) =>
    lists.noteProgress(user, item, position, duration);

  it('marks the item at 90 %, not before, and only once', async () => {
    expect(await report(MAMA, id(1), 850)).toBe(false);
    expect(lists.state(MAMA, id(1)).watched).toBe(false);
    expect(await report(MAMA, id(1), 900)).toBe(true);
    expect(lists.watched(MAMA)[0]).toMatchObject({ id: id(1), how: 'auto' });
    later(30_000);
    expect(await report(MAMA, id(1), 960)).toBe(false);
    expect(lists.watched(MAMA)[0]?.at).toBe('2026-10-16T10:00:00.000Z');
  });

  it('ignores the first seconds and unknown lengths', async () => {
    expect(await report(MAMA, id(1), 5, 8)).toBe(false);
    expect(await lists.noteProgress(MAMA, id(1), 100, 0)).toBe(false);
    expect(lists.watched(MAMA)).toEqual([]);
  });

  it('watching it again much later moves the date; a hand mark stays a hand mark', async () => {
    await lists.setWatched(MAMA, id(1), true, null);
    later(60 * 60 * 1000);
    expect(await report(MAMA, id(1), 990)).toBe(false); // an hour later: still the same viewing
    later(13 * 60 * 60 * 1000);
    expect(await report(MAMA, id(1), 990)).toBe(true);
    expect(lists.watched(MAMA)[0]).toMatchObject({ how: 'manual', at: '2026-10-17T00:00:00.000Z' });
  });

  it('asks for the series only when it is about to mark, and remembers it', async () => {
    let asked = 0;
    const resolve = async () => {
      asked += 1;
      return { parent: id(77), countable: true };
    };
    await lists.noteProgress(MAMA, id(5), 100, 1000, resolve);
    expect(asked).toBe(0);
    await lists.noteProgress(MAMA, id(5), 950, 1000, resolve);
    await lists.noteProgress(MAMA, id(5), 960, 1000, resolve);
    expect(asked).toBe(1);
    expect(lists.watched(MAMA)[0]).toMatchObject({ id: id(5), parent: id(77) });
    expect(lists.seenIds(MAMA)).toEqual(new Set([id(5), id(77)]));
  });

  it('a song does not count, and a Jellyfin that does not answer does not lose the mark', async () => {
    expect(
      await lists.noteProgress(MAMA, id(6), 950, 1000, async () => ({ parent: id(9), countable: false })),
    ).toBe(false);
    expect(lists.watched(MAMA)).toEqual([]);
    expect(
      await lists.noteProgress(MAMA, id(7), 950, 1000, async () => {
        throw new Error('Jellyfin is down');
      }),
    ).toBe(true);
    expect(lists.watched(MAMA)[0]).toMatchObject({ id: id(7), parent: null });
  });

  it('the history keeps only the newest finished items', async () => {
    // the cap is large; here only the order and the date of two marks are checked
    await report(MAMA, id(1), 950);
    later(1000);
    await report(MAMA, id(2), 950);
    expect(lists.watched(MAMA).map((entry) => entry.id)).toEqual([id(2), id(1)]);
  });
});

describe('what one person marks stays theirs', () => {
  it("has no way to read another person's lists; only bare counts cross over", async () => {
    await lists.setFavourite(MAMA, id(1), true, null);
    await lists.setLater(MAMA, id(2), true);
    await lists.setWatched(MAMA, id(3), true, id(30));
    await lists.setFavourite(PAPA, id(1), true, null);

    expect(lists.marks(PAPA)).toEqual({ favourites: [id(1)], later: [], watched: [] });
    expect(lists.marks(SASHA)).toEqual({ favourites: [], later: [], watched: [] });
    expect(lists.seenIds(PAPA).size).toBe(0);

    // counts for MAMA: only what PAPA did (id 1); for SASHA: both people, once each per title
    expect([...lists.community(MAMA)]).toEqual([[id(1), 1]]);
    expect(Object.fromEntries(lists.community(SASHA))).toEqual({ [id(1)]: 2, [id(3)]: 1, [id(30)]: 1 });
    // a title that someone watched AND favourited counts that person once
    await lists.setFavourite(MAMA, id(3), true, id(30));
    expect(lists.community(SASHA).get(id(3))).toBe(1);
  });

  it('the community counts never carry a name', async () => {
    await lists.setFavourite(MAMA, id(1), true, null);
    const counts = lists.community(PAPA);
    expect(JSON.stringify([...counts])).not.toContain('mama');
    expect(counts.get(id(1))).toBe(1);
  });

  it("forgetting a person removes their marks but leaves the family's suggestions", async () => {
    await lists.setFavourite(MAMA, id(1), true, null);
    await lists.addSuggestion({ id: MAMA, displayName: 'Мама' }, 'Брат', '');
    await lists.forget(MAMA);
    expect(lists.marks(MAMA).favourites).toEqual([]);
    expect(lists.community(PAPA).size).toBe(0);
    expect(lists.suggestions().map((entry) => entry.title)).toEqual(['Брат']);
  });
});

describe('saving', () => {
  it('writes media-lists.json atomically and reads it back after a restart', async () => {
    await lists.setFavourite(MAMA, id(1), true, null);
    await lists.setWatched(MAMA, id(2), true, id(20));
    await lists.addSuggestion({ id: MAMA, displayName: 'Мама' }, 'Кот в сапогах', 'для вечера');
    const text = await readFile(path.join(dir, 'media-lists.json'), 'utf8');
    const stored = JSON.parse(text);
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.users)).toEqual([MAMA]);

    const again = open();
    await again.load();
    expect(again.marks(MAMA)).toEqual({ favourites: [id(1)], later: [], watched: [id(2)] });
    expect(again.suggestions()[0]).toMatchObject({
      title: 'Кот в сапогах',
      note: 'для вечера',
      status: 'open',
    });
    expect(errors).toEqual([]);
  });

  it('undoes the change in memory when the disk refuses, and says so in plain words', async () => {
    const blocker = path.join(dir, 'a-file');
    await writeFile(blocker, 'x');
    const broken = open(path.join(blocker, 'inside'));
    await broken.load();
    await expect(broken.setFavourite(MAMA, id(1), true, null)).rejects.toMatchObject({
      status: 503,
      code: 'save_failed',
      message: expect.stringContaining('Не удалось сохранить'),
    });
    expect(broken.marks(MAMA).favourites).toEqual([]);
    expect(errors.some((line) => line.includes('Не удалось сохранить списки кинотеатра'))).toBe(true);
  });

  it('moves a damaged file aside instead of overwriting it with the first new mark', async () => {
    await writeFile(path.join(dir, 'media-lists.json'), '{ not json');
    const fresh = open();
    await fresh.load();
    expect(errors.some((line) => line.includes('media-lists.json'))).toBe(true);
    await fresh.setFavourite(MAMA, id(1), true, null);
    const names = await readdir(dir);
    expect(names.some((name) => name.startsWith('media-lists.damaged-'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(dir, 'media-lists.json'), 'utf8')).users[MAMA]).toBeDefined();
  });

  it('starts empty when the file has the wrong shape', async () => {
    await writeFile(path.join(dir, 'media-lists.json'), JSON.stringify({ version: 2, users: 5 }));
    const fresh = open();
    await fresh.load();
    expect(fresh.marks(MAMA)).toEqual({ favourites: [], later: [], watched: [] });
    expect(errors.some((line) => line.includes('неверный формат'))).toBe(true);
  });

  it('many quick changes at once all arrive, in order', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => lists.setFavourite(MAMA, id(i + 1), true, null)));
    expect(lists.marks(MAMA).favourites).toHaveLength(25);
    const again = open();
    await again.load();
    expect(again.marks(MAMA).favourites).toHaveLength(25);
  });
});

describe('film suggestions', () => {
  const mama = { id: MAMA, displayName: 'Мама' };
  const papa = { id: PAPA, displayName: 'Папа' };

  it('anybody writes a title and an optional note; everybody sees the list, the open ones first', async () => {
    const first = await lists.addSuggestion(mama, '  Кот   в сапогах ', '');
    later(1000);
    const second = await lists.addSuggestion(papa, 'Шрек', 'смотрели у друзей');
    expect(first).toMatchObject({
      title: 'Кот в сапогах',
      note: '',
      by: MAMA,
      byName: 'Мама',
      status: 'open',
    });
    expect(lists.suggestions().map((entry) => entry.title)).toEqual(['Шрек', 'Кот в сапогах']);
    later(1000);
    await lists.decideSuggestion(second.id, 'added');
    expect(lists.suggestions().map((entry) => [entry.title, entry.status])).toEqual([
      ['Кот в сапогах', 'open'],
      ['Шрек', 'added'],
    ]);
    expect(lists.suggestions()[1]?.decidedAt).toBe('2026-10-16T10:00:02.000Z');
    await lists.decideSuggestion(second.id, 'open');
    expect(lists.suggestions().find((entry) => entry.id === second.id)).toMatchObject({
      status: 'open',
      decidedAt: null,
    });
  });

  it('checks the title and the note, and the same title is not queued twice', async () => {
    await expect(lists.addSuggestion(mama, '   ', '')).rejects.toMatchObject({
      status: 400,
      code: 'bad_title',
    });
    await expect(lists.addSuggestion(mama, 'я'.repeat(TITLE_MAX + 1), '')).rejects.toMatchObject({
      status: 400,
      code: 'bad_title',
    });
    await expect(lists.addSuggestion(mama, 'Шрек', 'я'.repeat(NOTE_MAX + 1))).rejects.toMatchObject({
      status: 400,
      code: 'bad_note',
    });
    await lists.addSuggestion(mama, 'Ёжик в тумане', '');
    await expect(lists.addSuggestion(papa, '«ёжик в тумане»!', '')).rejects.toMatchObject({
      status: 409,
      code: 'duplicate',
    });
    expect(titleKey('Ёжик, в Тумане...')).toBe('ежик в тумане');
  });

  it('one person has a limited number open at once', async () => {
    for (let i = 0; i < MAX_OPEN_PER_PERSON; i += 1) await lists.addSuggestion(mama, `Фильм ${i}`, '');
    await expect(lists.addSuggestion(mama, 'Лишний', '')).rejects.toMatchObject({
      status: 429,
      code: 'too_many',
    });
    await lists.addSuggestion(papa, 'Лишний', '');
  });

  it('only the author takes back an open suggestion', async () => {
    const made = await lists.addSuggestion(mama, 'Шрек', '');
    await expect(lists.withdrawSuggestion(PAPA, made.id)).rejects.toMatchObject({ status: 403 });
    await lists.decideSuggestion(made.id, 'declined');
    await expect(lists.withdrawSuggestion(MAMA, made.id)).rejects.toMatchObject({
      status: 409,
      code: 'decided',
    });
    await lists.decideSuggestion(made.id, 'open');
    await lists.withdrawSuggestion(MAMA, made.id);
    expect(lists.suggestions()).toEqual([]);
    await expect(lists.withdrawSuggestion(MAMA, made.id)).rejects.toBeInstanceOf(MediaListError);
    await expect(lists.decideSuggestion('nope', 'added')).rejects.toMatchObject({ status: 404 });
  });
});
