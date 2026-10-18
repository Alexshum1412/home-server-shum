/**
 * Notifications: the list shown in the portal, what each person wants to hear about, and the push
 * messages that reach a phone or computer while the portal is closed.
 *
 * Every notification goes to named people only. Nothing here reads a message or a file: the
 * module that has the news (chat, downloads, monitoring) passes the title and text.
 */
import path from 'node:path';
import { z } from 'zod';
import type {
  NotificationKind,
  NotificationPrefs,
  NotificationsResponse,
  NotificationView,
  PushSubscriptionRequest,
} from '../../../shared/api.ts';
import { newId } from '../lib/ids.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import {
  generateVapidKeys,
  isPushEndpointAllowed,
  isValidVapidKeys,
  type PushFetch,
  sendPush,
  type VapidKeys,
} from './webpush.ts';

export const FEED_LIMIT = 100;
export const FEED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DEVICES_PER_USER = 10;

export const DEFAULT_PREFS: NotificationPrefs = {
  messages: true,
  calls: true,
  downloads: true,
  alerts: true,
  print: true,
  previews: false,
};

const PREF_OF_KIND: Record<NotificationKind, keyof NotificationPrefs> = {
  message: 'messages',
  call: 'calls',
  download: 'downloads',
  backup: 'alerts',
  disk: 'alerts',
  service: 'alerts',
  system: 'alerts',
  print: 'print',
};

const subscriptionSchema = z.object({
  endpoint: z.string().max(2048),
  p256dh: z.string().max(200),
  auth: z.string().max(100),
  label: z.string().max(80),
  createdAt: z.string(),
});

const feedItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['message', 'call', 'download', 'backup', 'disk', 'service', 'print', 'system']),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  at: z.string(),
  read: z.boolean(),
  key: z.string().optional(),
});

const prefsSchema = z.object({
  messages: z.boolean(),
  calls: z.boolean(),
  downloads: z.boolean(),
  alerts: z.boolean(),
  print: z.boolean(),
  previews: z.boolean(),
});

const fileSchema = z.object({
  version: z.literal(1),
  prefs: z.record(z.string(), prefsSchema).default({}),
  feed: z.record(z.string(), z.array(feedItemSchema)).default({}),
  subs: z.record(z.string(), z.array(subscriptionSchema)).default({}),
});

type FeedItem = z.infer<typeof feedItemSchema>;
type Subscription = z.infer<typeof subscriptionSchema>;

export interface NotifyInput {
  users: readonly string[];
  kind: NotificationKind;
  title: string;
  body: string;
  /** Text used instead of `body` for people who allowed previews. */
  previewBody?: string;
  /** Page of the portal opened by a click. */
  url: string;
  /** Put it into the portal's list (default true; chat messages have their own unread counters). */
  feed?: boolean;
  /** Send to the phones (default true). */
  push?: boolean;
  /** An unread notification with the same key is replaced, not duplicated. */
  key?: string;
  ttlSec?: number;
  urgency?: 'low' | 'normal' | 'high';
  /** Same topic replaces a push that has not been delivered yet. */
  topic?: string;
}

export interface NotificationCenter {
  load(): Promise<void>;
  list(userId: string): NotificationsResponse;
  notify(input: NotifyInput): Promise<void>;
  markRead(userId: string, ids: readonly string[] | 'all'): void;
  setPrefs(userId: string, patch: Partial<NotificationPrefs>): NotificationPrefs;
  subscribe(userId: string, subscription: PushSubscriptionRequest): void;
  unsubscribe(userId: string, endpoint: string): boolean;
  /** Forget everything about a removed person. */
  forget(userId: string): void;
  /** Waits for pushes and writes that are under way (tests, shutdown). */
  idle(): Promise<void>;
}

export interface NotificationCenterOptions {
  dataDir: string;
  clock: Clock;
  hub: RealtimeHub;
  /** "mailto:" or https address sent to the push services. */
  subject: string;
  fetch?: PushFetch;
  onError?: (message: string) => void;
}

function toView(item: FeedItem): NotificationView {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    url: item.url,
    at: item.at,
    read: item.read,
  };
}

export function createNotificationCenter(options: NotificationCenterOptions): NotificationCenter {
  const file = path.join(options.dataDir, 'notifications.json');
  const vapidFile = path.join(options.dataDir, 'push-vapid.json');
  const queue = createSerialQueue();
  const prefs = new Map<string, NotificationPrefs>();
  const feed = new Map<string, FeedItem[]>();
  const subs = new Map<string, Subscription[]>();
  let vapid: VapidKeys | null = null;
  let saveTimer: NodeJS.Timeout | null = null;
  const pending = new Set<Promise<unknown>>();
  const fetchLike: PushFetch =
    options.fetch ??
    ((url, init) =>
      fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal }));

  function save(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, 300);
    saveTimer.unref();
  }

  function persist(): Promise<void> {
    const snapshot = {
      version: 1 as const,
      prefs: Object.fromEntries(prefs),
      feed: Object.fromEntries(feed),
      subs: Object.fromEntries(subs),
    };
    return queue
      .run(() => writeJsonAtomic(file, snapshot))
      .catch((error: unknown) =>
        options.onError?.(`Не удалось сохранить уведомления: ${(error as Error).message}`),
      );
  }

  async function loadVapid(): Promise<void> {
    try {
      const data = (await readJsonFile(vapidFile)) as Partial<VapidKeys> | undefined;
      if (data && typeof data.publicKey === 'string' && typeof data.privateKey === 'string') {
        const keys = { publicKey: data.publicKey, privateKey: data.privateKey };
        if (isValidVapidKeys(keys)) {
          vapid = keys;
          return;
        }
        options.onError?.('Ключи уведомлений повреждены: созданы новые, устройства нужно подписать заново.');
        subs.clear();
      }
    } catch (error) {
      options.onError?.(`Ключи уведомлений не прочитаны: ${(error as Error).message}`);
    }
    try {
      const keys = generateVapidKeys();
      await writeJsonAtomic(vapidFile, keys);
      vapid = keys;
    } catch (error) {
      vapid = null;
      options.onError?.(`Ключи уведомлений не созданы: ${(error as Error).message}`);
    }
  }

  function prefsOf(userId: string): NotificationPrefs {
    return prefs.get(userId) ?? DEFAULT_PREFS;
  }

  function trim(items: FeedItem[]): FeedItem[] {
    const oldest = options.clock().getTime() - FEED_MAX_AGE_MS;
    return items.filter((item) => Date.parse(item.at) >= oldest).slice(-FEED_LIMIT);
  }

  async function pushTo(userId: string, input: NotifyInput, body: string): Promise<void> {
    const keys = vapid;
    const list = subs.get(userId);
    if (!keys || !list || list.length === 0) return;
    const payload = {
      title: input.title,
      body,
      url: input.url,
      kind: input.kind,
      tag: input.topic ?? input.kind,
    };
    const dead: string[] = [];
    await Promise.all(
      list.map(async (sub) => {
        const result = await sendPush(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          payload,
          {
            keys,
            subject: options.subject,
            ttlSec: input.ttlSec ?? 24 * 3600,
            urgency: input.urgency ?? 'normal',
            topic: input.topic
              ? input.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined
              : undefined,
            nowSec: Math.floor(options.clock().getTime() / 1000),
          },
          fetchLike,
        );
        if (result === 'gone') dead.push(sub.endpoint);
      }),
    );
    if (dead.length > 0) {
      subs.set(
        userId,
        (subs.get(userId) ?? []).filter((sub) => !dead.includes(sub.endpoint)),
      );
      save();
    }
  }

  return {
    async load() {
      let data: unknown;
      try {
        data = await readJsonFile(file);
      } catch (error) {
        options.onError?.(`Файл notifications.json повреждён и не прочитан: ${(error as Error).message}`);
      }
      const parsed = data === undefined ? null : fileSchema.safeParse(data);
      if (parsed?.success) {
        for (const [id, value] of Object.entries(parsed.data.prefs)) prefs.set(id, value);
        for (const [id, value] of Object.entries(parsed.data.feed)) feed.set(id, trim(value));
        for (const [id, value] of Object.entries(parsed.data.subs)) subs.set(id, value);
      } else if (parsed && !parsed.success) {
        options.onError?.('Файл notifications.json имеет неверный формат и не прочитан.');
      }
      await loadVapid();
    },

    list(userId) {
      const items = trim(feed.get(userId) ?? []);
      return {
        notifications: items.map(toView).reverse(),
        unread: items.filter((item) => !item.read).length,
        prefs: prefsOf(userId),
        push: {
          available: vapid !== null,
          publicKey: vapid?.publicKey ?? null,
          devices: subs.get(userId)?.length ?? 0,
        },
      };
    },

    async notify(input) {
      const pref = PREF_OF_KIND[input.kind];
      const work: Array<Promise<void>> = [];
      for (const userId of new Set(input.users)) {
        const own = prefsOf(userId);
        if (!own[pref]) continue;
        if (input.feed !== false) {
          const items = (feed.get(userId) ?? []).filter(
            (item) => !(input.key && item.key === input.key && !item.read),
          );
          const item: FeedItem = {
            id: newId(),
            kind: input.kind,
            title: input.title,
            body: input.body,
            url: input.url,
            at: isoNow(options.clock),
            read: false,
            ...(input.key ? { key: input.key } : {}),
          };
          items.push(item);
          feed.set(userId, trim(items));
          options.hub.publish([userId], { type: 'notification', notification: toView(item) });
          save();
        }
        if (input.push !== false) {
          const body = own.previews && input.previewBody !== undefined ? input.previewBody : input.body;
          const job = pushTo(userId, input, body).catch(() => undefined);
          pending.add(job);
          void job.finally(() => pending.delete(job));
          work.push(job);
        }
      }
      await Promise.all(work);
    },

    markRead(userId, ids) {
      const items = feed.get(userId);
      if (!items) return;
      for (const item of items) {
        if (ids === 'all' || ids.includes(item.id)) item.read = true;
      }
      save();
    },

    setPrefs(userId, patch) {
      const next = { ...prefsOf(userId) };
      for (const key of Object.keys(DEFAULT_PREFS) as Array<keyof NotificationPrefs>) {
        const value = patch[key];
        if (typeof value === 'boolean') next[key] = value;
      }
      prefs.set(userId, next);
      save();
      return next;
    },

    subscribe(userId, subscription) {
      if (!isPushEndpointAllowed(subscription.endpoint)) {
        throw Object.assign(new Error('Этот адрес уведомлений не поддерживается.'), {
          status: 400,
          code: 'bad_endpoint',
        });
      }
      const list = (subs.get(userId) ?? []).filter((sub) => sub.endpoint !== subscription.endpoint);
      list.push({
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        label: (subscription.label ?? 'Устройство').slice(0, 80),
        createdAt: isoNow(options.clock),
      });
      subs.set(userId, list.slice(-MAX_DEVICES_PER_USER));
      save();
    },

    unsubscribe(userId, endpoint) {
      const list = subs.get(userId) ?? [];
      const next = list.filter((sub) => sub.endpoint !== endpoint);
      if (next.length === list.length) return false;
      subs.set(userId, next);
      save();
      return true;
    },

    forget(userId) {
      prefs.delete(userId);
      feed.delete(userId);
      subs.delete(userId);
      save();
    },

    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        await persist();
      }
      await queue.idle();
    },
  };
}
