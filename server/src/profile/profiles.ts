import path from 'node:path';
import { z } from 'zod';
import {
  INTERESTS,
  LEVELS_BY_SCALE,
  type LevelMap,
  type ProfilePatch,
  type ProfileView,
} from '../../../shared/profile.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';

const storedSchema = z.object({
  city: z.string().default(''),
  latitude: z.number().nullable().default(null),
  longitude: z.number().nullable().default(null),
  telegramUsername: z.string().default(''),
  telegramChatId: z.string().default(''),
  telegramNotify: z.boolean().default(true),
  interests: z.array(z.string()).default([]),
  levels: z.record(z.string(), z.string()).default({}),
  about: z.string().default(''),
  onboarded: z.boolean().default(false),
});
export type StoredProfile = z.infer<typeof storedSchema>;
const fileSchema = z.object({ version: z.literal(1), profiles: z.record(z.string(), storedSchema) });

const EMPTY = (): StoredProfile => storedSchema.parse({});
const known = new Set(INTERESTS.map((item) => item.id));
const scaleOf = new Map(INTERESTS.map((item) => [item.id, item.level]));

function cleanLevels(levels: LevelMap): LevelMap {
  const out: LevelMap = {};
  for (const [id, level] of Object.entries(levels)) {
    const scale = scaleOf.get(id);
    if (scale && LEVELS_BY_SCALE[scale].includes(level)) out[id] = level;
  }
  return out;
}

export function cleanPatch(patch: ProfilePatch): ProfilePatch {
  const out: ProfilePatch = {};
  if (patch.city !== undefined) out.city = patch.city.trim().slice(0, 80);
  if (patch.telegramUsername !== undefined) {
    const name = patch.telegramUsername.trim().replace(/^@/, '').slice(0, 40);
    out.telegramUsername = /^[A-Za-z0-9_]{0,40}$/.test(name) ? name : '';
  }
  if (patch.telegramNotify !== undefined) out.telegramNotify = patch.telegramNotify;
  if (patch.interests !== undefined)
    out.interests = [...new Set(patch.interests.filter((id) => known.has(id)))];
  if (patch.levels !== undefined) out.levels = cleanLevels(patch.levels);
  if (patch.about !== undefined) out.about = patch.about.trim().slice(0, 300);
  if (patch.onboarded !== undefined) out.onboarded = patch.onboarded;
  return out;
}

/** Profiles live in `profiles.json`; a person is asked once (first sign-in) and can change everything later. */
export function createProfileStore(dataDir: string) {
  const file = path.join(dataDir, 'profiles.json');
  const queue = createSerialQueue();

  async function load(): Promise<Record<string, StoredProfile>> {
    try {
      const parsed = fileSchema.safeParse(await readJsonFile(file));
      return parsed.success ? parsed.data.profiles : {};
    } catch {
      return {};
    }
  }
  const save = (profiles: Record<string, StoredProfile>) => writeJsonAtomic(file, { version: 1, profiles });

  const view = (item: StoredProfile): ProfileView => ({
    city: item.city,
    hasCoordinates: item.latitude !== null && item.longitude !== null,
    telegramUsername: item.telegramUsername,
    telegramLinked: item.telegramChatId !== '',
    telegramNotify: item.telegramNotify,
    interests: item.interests,
    levels: item.levels,
    about: item.about,
    onboarded: item.onboarded,
  });

  return {
    get(username: string): Promise<StoredProfile> {
      return queue.run(async () => (await load())[username] ?? EMPTY());
    },
    view(username: string): Promise<ProfileView> {
      return queue.run(async () => view((await load())[username] ?? EMPTY()));
    },
    /** `place` is the geocoded city when the city changed (null — unknown city, coordinates are dropped). */
    update(
      username: string,
      patch: ProfilePatch,
      place?: { latitude: number; longitude: number; name: string } | null,
    ): Promise<ProfileView> {
      return queue.run(async () => {
        const all = await load();
        const item = all[username] ?? EMPTY();
        Object.assign(item, cleanPatch(patch));
        if (place !== undefined) {
          item.latitude = place?.latitude ?? null;
          item.longitude = place?.longitude ?? null;
          if (place) item.city = place.name;
        }
        all[username] = item;
        await save(all);
        return view(item);
      });
    },
    setTelegramChat(username: string, chatId: string): Promise<void> {
      return queue.run(async () => {
        const all = await load();
        // One chat belongs to one person.
        if (chatId !== '')
          for (const other of Object.values(all))
            if (other.telegramChatId === chatId) other.telegramChatId = '';
        const item = all[username] ?? EMPTY();
        item.telegramChatId = chatId;
        all[username] = item;
        await save(all);
      });
    },
    /** The person who linked this chat, or null. */
    findByChat(chatId: string): Promise<string | null> {
      return queue.run(
        async () => Object.entries(await load()).find(([, p]) => p.telegramChatId === chatId)?.[0] ?? null,
      );
    },
    forget(username: string): Promise<void> {
      return queue.run(async () => {
        const all = await load();
        if (all[username]) {
          delete all[username];
          await save(all);
        }
      });
    },
  };
}

export type ProfileStore = ReturnType<typeof createProfileStore>;
