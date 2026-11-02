/**
 * People from outside the family who write to the Telegram bot: they get a limited talk with Olivia and can subscribe to a
 * shared morning digest (topics chosen from what Olivia already makes for everybody). They have no account and no access to
 * anything of the family; the bot keeps only the chat number, the first name Telegram shows, and their choices.
 */
import path from 'node:path';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';

export interface Guest {
  chatId: string;
  name: string;
  joinedAt: string;
  subscribed: boolean;
  topics: string[];
  levels: Record<string, string>;
  city: string;
  latitude: number | null;
  longitude: number | null;
  blocked: boolean;
  /** The name in Telegram (@name), only to recognise the person. */
  username: string;
  /** The administrator allowed this person to talk to Olivia (by default a stranger gets the digest only). */
  chat: boolean;
  /** A note of the administrator («друг Алексея»). */
  note: string;
  lastAt: string;
  /** Messages to Olivia today (the day is kept to reset the count). */
  day: string;
  today: number;
  total: number;
}

/** The topics a guest may choose: general ones, nothing that needs a family account. */
export const GUEST_TOPICS: readonly string[] = [
  'german',
  'english',
  'polish',
  'news',
  'tech',
  'history',
  'science',
  'space',
  'animals',
  'geography',
  'riddle',
  'quote',
  'joke',
  'recipes',
  'books',
  'movies',
  'music',
  'travel',
  'health',
  'psychology',
];

export const GUEST_DAILY_MESSAGES = 15;
export const GUEST_MAX = 100;

export function createGuests(options: { dataDir: string; clock: Clock }) {
  const file = path.join(options.dataDir, 'guests.json');
  const queue = createSerialQueue();
  const today = () => options.clock().toISOString().slice(0, 10);

  async function load(): Promise<Record<string, Guest>> {
    try {
      const data = (await readJsonFile(file)) as { guests?: Record<string, Guest> } | undefined;
      return data?.guests && typeof data.guests === 'object' ? data.guests : {};
    } catch {
      return {};
    }
  }
  const save = (guests: Record<string, Guest>) => writeJsonAtomic(file, { version: 1, guests });

  return {
    /** The guest of this chat (created at the first message, up to GUEST_MAX), or null when there is no room or they are blocked. */
    open(chatId: string, name: string, username = ''): Promise<Guest | null> {
      return queue.run(async () => {
        const all = await load();
        let guest = all[chatId];
        if (!guest) {
          if (Object.keys(all).length >= GUEST_MAX) return null;
          guest = {
            chatId,
            name: name.slice(0, 40),
            joinedAt: options.clock().toISOString(),
            subscribed: false,
            topics: ['news'],
            levels: {},
            city: '',
            latitude: null,
            longitude: null,
            blocked: false,
            username: username.slice(0, 40),
            chat: false,
            note: '',
            lastAt: options.clock().toISOString(),
            day: today(),
            today: 0,
            total: 0,
          };
          all[chatId] = guest;
          await save(all);
        }
        if (!guest.blocked) {
          guest.lastAt = options.clock().toISOString();
          if (username && guest.username !== username.slice(0, 40)) guest.username = username.slice(0, 40);
          await save(all);
        }
        return guest.blocked ? null : guest;
      });
    },
    get: (chatId: string) => queue.run(async () => (await load())[chatId] ?? null),
    /** A message to Olivia: false when today's limit is used up. */
    count(chatId: string): Promise<boolean> {
      return queue.run(async () => {
        const all = await load();
        const guest = all[chatId];
        if (!guest) return false;
        if (guest.day !== today()) {
          guest.day = today();
          guest.today = 0;
        }
        if (guest.today >= GUEST_DAILY_MESSAGES) return false;
        guest.today += 1;
        guest.total += 1;
        await save(all);
        return true;
      });
    },
    update(
      chatId: string,
      patch: Partial<
        Pick<Guest, 'subscribed' | 'topics' | 'levels' | 'city' | 'latitude' | 'longitude' | 'chat' | 'note'>
      >,
    ): Promise<Guest | null> {
      return queue.run(async () => {
        const all = await load();
        const guest = all[chatId];
        if (!guest) return null;
        if (patch.topics)
          guest.topics = [...new Set(patch.topics.filter((id) => GUEST_TOPICS.includes(id)))].slice(0, 8);
        if (patch.subscribed !== undefined) guest.subscribed = patch.subscribed;
        if (patch.chat !== undefined) guest.chat = patch.chat;
        if (patch.note !== undefined) guest.note = patch.note.slice(0, 200);
        if (patch.levels) guest.levels = { ...guest.levels, ...patch.levels };
        if (patch.city !== undefined) {
          guest.city = patch.city.slice(0, 80);
          guest.latitude = patch.latitude ?? null;
          guest.longitude = patch.longitude ?? null;
        }
        await save(all);
        return guest;
      });
    },
    subscribers: () =>
      queue.run(async () =>
        Object.values(await load()).filter((guest) => guest.subscribed && !guest.blocked),
      ),
    list: () => queue.run(async () => Object.values(await load())),
    /** For the administrator: stop a person (they are not answered and get no digest) or let them back. */
    block(chatId: string, blocked: boolean): Promise<boolean> {
      return queue.run(async () => {
        const all = await load();
        const guest = all[chatId];
        if (!guest) return false;
        guest.blocked = blocked;
        if (blocked) guest.subscribed = false;
        await save(all);
        return true;
      });
    },
    remove(chatId: string): Promise<boolean> {
      return queue.run(async () => {
        const all = await load();
        if (!all[chatId]) return false;
        delete all[chatId];
        await save(all);
        return true;
      });
    },
  };
}

export type Guests = ReturnType<typeof createGuests>;
