import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DigestMine, DigestSettings } from '../../../shared/extras.ts';
import { isDisabled, type StoredUser } from '../auth/users.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';
import type { NotificationCenter } from '../notify/center.ts';
import { localMoment } from '../planner/task-dates.ts';
import { currencyToday, weatherToday } from './external.ts';
import type { DigestLlm } from './llm.ts';

interface StoredUserState {
  enabled: boolean;
  telegramChatId: string;
  last: { at: string; text: string; how: 'model' | 'template' } | null;
}

interface StoredFile {
  settings: {
    enabled: boolean;
    time: string;
    city: string;
    latitude: number | null;
    longitude: number | null;
    currency: boolean;
  };
  users: Record<string, StoredUserState>;
  lastRunDay: string;
}

const DEFAULTS: StoredFile = {
  settings: { enabled: true, time: '07:30', city: '', latitude: null, longitude: null, currency: true },
  users: {},
  lastRunDay: '',
};

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
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

export const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export const isChatId = (value: string) => value === '' || /^-?\d{3,20}$/.test(value);

/** What the digest may know about one person: gathered by the portal and handed over as plain lines. */
export interface FactSources {
  /** Overdue and today's tasks of the person. */
  tasks: (user: StoredUser, today: string) => Promise<string[]>;
  /** Events of today and tomorrow that the person may see. */
  events: (user: StoredUser, today: string, tomorrow: string) => Promise<string[]>;
  deadlines: (user: StoredUser) => Promise<string[]>;
  downloads: (user: StoredUser, sinceIso: string) => Promise<string[]>;
  /** Server matters: administrators only. */
  server: (sinceIso: string) => Promise<string[]>;
}

export function createDigest(options: {
  dataDir: string;
  clock: Clock;
  users: () => Promise<StoredUser[]>;
  sources: FactSources;
  llm: DigestLlm;
  notify: NotificationCenter['notify'];
  telegramTokenFile: string;
  fetch?: typeof fetch;
  onError?: (message: string) => void;
}) {
  const file = path.join(options.dataDir, 'digest.json');
  const queue = createSerialQueue();
  const fetchImpl = options.fetch ?? fetch;
  let running = false;
  // Weather and rates change slowly: one answer is kept for half an hour (a failure for five minutes), so that a click does not wait for a slow site.
  const cache = new Map<string, { at: number; value: string | null }>();
  async function cached(key: string, load: () => Promise<string | null>): Promise<string | null> {
    const now = options.clock().getTime();
    const hit = cache.get(key);
    if (hit && now - hit.at < (hit.value === null ? 300_000 : 1_800_000)) return hit.value;
    const value = await load();
    cache.set(key, { at: now, value });
    return value;
  }
  const lastManual = new Map<string, number>();

  async function load(): Promise<StoredFile> {
    try {
      const data = (await readJsonFile(file)) as Partial<StoredFile> | undefined;
      return {
        settings: { ...DEFAULTS.settings, ...(data?.settings ?? {}) },
        users: data?.users && typeof data.users === 'object' ? data.users : {},
        lastRunDay: typeof data?.lastRunDay === 'string' ? data.lastRunDay : '',
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }
  const save = (data: StoredFile) => writeJsonAtomic(file, { version: 1, ...data });
  const stateOf = (data: StoredFile, username: string): StoredUserState =>
    data.users[username] ?? { enabled: true, telegramChatId: '', last: null };

  async function telegramToken(): Promise<string | null> {
    try {
      const token = (await readFile(options.telegramTokenFile, 'utf8')).trim();
      return /^\d{5,}:[\w-]{20,}$/.test(token) ? token : null;
    } catch {
      return null;
    }
  }

  async function sendTelegram(chatId: string, text: string): Promise<boolean> {
    const token = await telegramToken();
    if (!token || chatId === '') return false;
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** The facts for one person, as short plain lines. */
  async function facts(user: StoredUser, data: StoredFile): Promise<string[]> {
    const now = options.clock();
    const { day: today } = localMoment(now);
    const next = new Date(`${today}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const tomorrow = next.toISOString().slice(0, 10);
    const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const date = new Date(`${today}T00:00:00Z`);
    const lines: string[] = [
      `Сегодня ${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}.`,
    ];
    const settings = data.settings;
    const [weather, currency] = await Promise.all([
      settings.latitude !== null && settings.longitude !== null
        ? cached(`weather:${settings.latitude},${settings.longitude}`, () =>
            weatherToday(settings.latitude as number, settings.longitude as number, fetchImpl),
          )
        : Promise.resolve(null),
      settings.currency ? cached('currency', () => currencyToday(fetchImpl)) : Promise.resolve(null),
    ]);
    if (weather) lines.push(`Погода${settings.city ? ` (${settings.city})` : ''}: ${weather}.`);
    for (const group of await Promise.all([
      options.sources.tasks(user, today),
      options.sources.events(user, today, tomorrow),
      options.sources.deadlines(user),
      options.sources.downloads(user, since),
      user.role === 'admin' ? options.sources.server(since) : Promise.resolve([] as string[]),
    ])) {
      lines.push(...group);
    }
    if (currency) lines.push(`Курсы ЦБ: ${currency}.`);
    return lines;
  }

  /** Plain text without a model: the same facts as short lines under a greeting. */
  function template(user: StoredUser, lines: string[]): string {
    return [`Доброе утро, ${user.displayName}!`, ...lines.map((line) => `• ${line}`), 'Хорошего дня!'].join(
      '\n',
    );
  }

  async function deliver(
    user: StoredUser,
    text: string,
    how: 'model' | 'template',
    data: StoredFile,
  ): Promise<void> {
    const state = stateOf(data, user.username);
    state.last = { at: options.clock().toISOString(), text, how };
    data.users[user.username] = state;
    await options.notify({
      users: [user.id],
      kind: 'reminder',
      title: 'Утренний дайджест',
      body: text.replace(/\s+/g, ' ').slice(0, 160),
      url: '/digest',
      key: `digest:${localMoment(options.clock()).day}`,
      push: false,
    });
    if (state.telegramChatId !== '') await sendTelegram(state.telegramChatId, text);
  }

  const view = (data: StoredFile, telegramReady: boolean): DigestSettings => ({
    enabled: data.settings.enabled,
    time: data.settings.time,
    city: data.settings.city,
    latitude: data.settings.latitude,
    longitude: data.settings.longitude,
    currency: data.settings.currency,
    telegramReady,
  });

  return {
    async state(username: string): Promise<{ settings: DigestSettings; mine: DigestMine }> {
      const data = await queue.run(load);
      const mine = stateOf(data, username);
      return {
        settings: view(data, (await telegramToken()) !== null),
        mine: { enabled: mine.enabled, telegramChatId: mine.telegramChatId, last: mine.last },
      };
    },
    setMine(username: string, patch: { enabled?: boolean; telegramChatId?: string }): Promise<void> {
      return queue.run(async () => {
        const data = await load();
        const state = stateOf(data, username);
        if (patch.enabled !== undefined) state.enabled = patch.enabled;
        if (patch.telegramChatId !== undefined) state.telegramChatId = patch.telegramChatId;
        data.users[username] = state;
        await save(data);
      });
    },
    setSettings(patch: Partial<StoredFile['settings']>): Promise<void> {
      return queue.run(async () => {
        const data = await load();
        data.settings = { ...data.settings, ...patch };
        await save(data);
      });
    },
    /** Right now for one person, with the quick model (at most once in five minutes). */
    async runNow(user: StoredUser): Promise<{ text: string; how: 'model' | 'template' } | 'too_soon'> {
      const before = lastManual.get(user.username) ?? 0;
      if (options.clock().getTime() - before < 5 * 60_000) return 'too_soon';
      lastManual.set(user.username, options.clock().getTime());
      const data = await queue.run(load);
      const lines = await facts(user, data);
      const quick = await options.llm.quick(user.displayName, lines);
      const text = quick ?? template(user, lines);
      const how = quick ? 'model' : 'template';
      await queue.run(async () => {
        const fresh = await load();
        await deliver(user, text, how, fresh);
        await save(fresh);
      });
      return { text, how };
    },
    /** Everybody who wants it, in one session of the bigger model. */
    async runAll(): Promise<number> {
      if (running) return 0;
      running = true;
      try {
        const data = await queue.run(load);
        const people = (await options.users()).filter(
          (user) => !isDisabled(user) && stateOf(data, user.username).enabled,
        );
        let done = 0;
        await options.llm.session(async (write) => {
          for (const user of people) {
            try {
              const lines = await facts(user, data);
              const result = await write(user.displayName, lines);
              const text = result.text ?? template(user, lines);
              await queue.run(async () => {
                const fresh = await load();
                await deliver(user, text, result.text ? 'model' : 'template', fresh);
                await save(fresh);
              });
              done += 1;
            } catch (error) {
              options.onError?.(`Дайджест для одного из людей не получился: ${String(error)}`);
            }
          }
        });
        return done;
      } finally {
        running = false;
      }
    },
    /** Once a minute: at the set time (once a day, a PC that was off then catches up when it is on). */
    async tick(): Promise<void> {
      const data = await queue.run(load);
      if (!data.settings.enabled || running) return;
      const { day, time } = localMoment(options.clock());
      if (data.lastRunDay === day || time < data.settings.time) return;
      await queue.run(async () => {
        const fresh = await load();
        fresh.lastRunDay = day;
        await save(fresh);
      });
      await this.runAll();
    },
  };
}

export type Digest = ReturnType<typeof createDigest>;
