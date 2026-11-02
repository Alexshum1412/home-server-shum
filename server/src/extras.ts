/**
 * The pieces added on 20.10.2026 and how they are put together: deadlines, the journal of incidents, the forecast of
 * the disk, the check of the internet, the decoys, the devices of the home network, the family status and the morning
 * digest. app.ts calls createExtras() once, registers the routes and starts/stops the timers.
 */
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { CalendarOccurrence } from '../../shared/api.ts';
import type { SafetyResponse } from '../../shared/extras.ts';
import type { AuditLog } from './audit/log.ts';
import type { Guards } from './auth/guards.ts';
import { isDisabled, type StoredUser, type UserStore } from './auth/users.ts';
import type { Config } from './config.ts';
import { createDigest } from './digest/digest.ts';
import { createDigestLlm } from './digest/llm.ts';
import { registerDigestRoutes } from './digest/routes.ts';
import { createTopics } from './digest/topics.ts';
import type { DownloadManager } from './downloads/manager.ts';
import { createDiskHistory } from './health/disk-history.ts';
import { createIncidentLog } from './health/incidents.ts';
import { checkInternet, type InternetState } from './health/net-check.ts';
import { buildFamilyStatus } from './health/status.ts';
import type { Clock } from './lib/time.ts';
import type { NotificationCenter } from './notify/center.ts';
import type { BigModel } from './olivia/big-model.ts';
import type { CalendarStore } from './planner/calendar.ts';
import { createDeadlineWatcher, registerDeadlineRoutes } from './planner/deadline-routes.ts';
import { createDeadlineStore } from './planner/deadlines.ts';
import { localMoment } from './planner/task-dates.ts';
import type { TaskStore } from './planner/tasks.ts';
import type { ProfileStore } from './profile/profiles.ts';
import { createDecoys } from './security/decoys.ts';
import { createNetworkWatcher } from './security/network.ts';
import { registerSafetyRoutes } from './security/routes.ts';
import type { SystemCollector } from './system/collector.ts';

export interface ExtrasDeps {
  config: Config;
  clock: Clock;
  users: UserStore;
  guards: Guards;
  audit: AuditLog;
  notify: NotificationCenter;
  collector: SystemCollector;
  tasks: TaskStore;
  calendar: CalendarStore;
  downloads: DownloadManager;
  /** The bigger local model, started on demand. */
  bigModel: BigModel;
  /** The things each person told about themselves. */
  profiles: ProfileStore;
  /** Sends a text to a Telegram chat (the family's bot); false when it cannot. */
  sendTelegram?: (chatId: string, text: string, html?: boolean) => Promise<boolean>;
  /** People from outside the family who subscribed to the digest in the bot. */
  guests?: { subscribers: () => Promise<import('./guests/guests.ts').Guest[]> };
  freeBytes: (dir: string) => Promise<number | null>;
  log: { warn: (message: string) => void };
  /** How the previous run of the portal ended. */
  previousRun: { how: 'clean' | 'crashed' | 'unknown'; at: string | null };
}

const money = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export function createExtras(deps: ExtrasDeps) {
  const { config, clock, users, notify, collector, tasks, calendar, downloads } = deps;
  const incidents = createIncidentLog(config.dataDir, clock);
  const deadlines = createDeadlineStore(config.dataDir, { clock });
  let internet: InternetState = { up: null, dnsUp: null, checkedAt: null };

  const volumes = () =>
    Promise.all(
      config.volumes.map(async (volume) => ({
        path: volume,
        freeBytes: await deps.freeBytes(volume).catch(() => null),
      })),
    );
  const diskHistory = createDiskHistory(config.dataDir, {
    clock,
    probe: volumes,
    reserveBytes: config.minFreeBytes,
  });

  const admins = async () =>
    (await users.list()).filter((user) => user.role === 'admin' && !isDisabled(user));
  const tellAdmins = async (title: string, body: string, key: string, url = '/safety') => {
    const list = await admins();
    if (list.length === 0) return;
    await notify.notify({ users: list.map((a) => a.id), kind: 'system', title, body, url, key });
  };

  const decoys = createDecoys({
    dataDir: config.dataDir,
    sharedDir: () => path.join(config.filesDir, 'shared'),
    clock,
  });

  const network = createNetworkWatcher({
    dataDir: config.dataDir,
    clock,
    onNewDevice: async (device) => {
      await incidents.add('device', 'Новое устройство в домашней сети', `${device.ip}, ${device.mac}`);
      await tellAdmins(
        'Новое устройство в домашней сети',
        `Адрес ${device.ip}. Если оно ваше, подпишите его на странице «Безопасность».`,
        `device:${device.mac}`,
      );
    },
  });

  const llm = createDigestLlm({
    quickUrl: config.oliviaLlm?.url ?? null,
    keyFile: config.oliviaLlm?.keyFile,
    big: deps.bigModel,
  });

  /** The tasks of the person for today and overdue ones (own, or given to them), as short lines. */
  async function tasksLines(user: StoredUser, today: string): Promise<string[]> {
    const { tasks: all } = await tasks.list({ username: user.username, isAdmin: user.role === 'admin' });
    const mine = all.filter(
      (t) =>
        !t.done &&
        t.due !== null &&
        t.due <= today &&
        (t.assignee === user.username || (t.assignee === null && t.owner === user.username)),
    );
    return mine
      .slice(0, 6)
      .map(
        (t) =>
          `${t.due === today ? 'Сегодня' : 'Просрочено'}: «${t.title}»${t.dueTime ? ` в ${t.dueTime}` : ''}`,
      );
  }
  const topics = createTopics({ dataDir: config.dataDir, generate: llm.generate });
  const digest = createDigest({
    dataDir: config.dataDir,
    clock,
    users: () => users.list(),
    topics,
    ...(deps.guests ? { guests: deps.guests } : {}),
    llm,
    notify: (input) => notify.notify(input),
    profile: async (username) => {
      const p = await deps.profiles.get(username);
      return {
        city: p.city,
        latitude: p.latitude,
        longitude: p.longitude,
        interests: p.interests,
        levels: p.levels,
        about: p.about,
        telegramChatId: p.telegramChatId,
      };
    },
    ...(deps.sendTelegram ? { sendTelegram: deps.sendTelegram } : {}),
    telegramTokenFile:
      process.env.DIGEST_TELEGRAM_TOKEN_FILE?.trim() ||
      `${process.env.SystemDrive ?? 'C:'}\\FamilyServer\\secrets\\telegram.token`,
    onError: (message) => deps.log.warn(message),
    sources: {
      tasks: async (user: StoredUser, today: string) => tasksLines(user, today),
      events: async (user: StoredUser, today: string, tomorrow: string) => {
        const { occurrences } = await calendar.occurrences(
          { username: user.username, isAdmin: user.role === 'admin' },
          today,
          tomorrow,
        );
        return occurrences
          .slice(0, 6)
          .map(
            (o: CalendarOccurrence) =>
              `${o.day === today ? 'Сегодня' : 'Завтра'} в календаре: «${o.event.title}»${o.event.time ? ` в ${o.event.time}` : ''}`,
          );
      },
      deadlines: async (user: StoredUser) =>
        (await deadlines.soon(user.username, 14))
          .slice(0, 4)
          .map(
            (d) =>
              `Срок «${d.title}»: ${d.daysLeft < 0 ? `просрочен на ${-d.daysLeft} дн.` : d.daysLeft === 0 ? 'заканчивается сегодня' : `через ${d.daysLeft} дн.`}`,
          ),
      downloads: async (user: StoredUser, since: string) =>
        downloads
          .list(user.username)
          .filter((d) => d.state === 'completed' && d.completedAt !== null && d.completedAt >= since)
          .slice(0, 4)
          .map((d) => `Скачано за ночь: «${d.fileName}»`),
      server: async (since: string) => {
        const lines: string[] = [];
        const snapshot = collector.snapshot('admin');
        if (snapshot.overall.level !== 'ok') lines.push(`Сервер: ${snapshot.overall.text}`);
        const found = await incidents.since(since);
        if (found.length > 0)
          lines.push(
            `За сутки происшествий: ${found.length} (${found
              .slice(0, 3)
              .map((i) => i.title)
              .join('; ')})`,
          );
        const soon = (await diskHistory.forecast()).find((f) => f.daysLeft !== null && f.daysLeft < 30);
        if (soon)
          lines.push(
            `Место на диске ${soon.volume} при нынешней скорости закончится примерно через ${soon.daysLeft} дн.`,
          );
        return lines;
      },
    },
  });

  const deadlineWatcher = createDeadlineWatcher({
    deadlines,
    listUsers: () => users.list(),
    notify: (input) => notify.notify(input),
  });

  async function safety(): Promise<SafetyResponse> {
    return {
      generatedAt: clock().toISOString(),
      forecast: await diskHistory.forecast(),
      incidents: await incidents.list(60),
      devices: await network.list(),
      decoys: (await decoys.list()).map((d) => ({ space: 'shared' as const, ...d })),
      internet,
    };
  }

  const timers: NodeJS.Timeout[] = [];
  const safely = (name: string, job: () => Promise<unknown>) => () => {
    job().catch((error: unknown) => deps.log.warn(`${name}: ${String(error)}`));
  };

  return {
    digest,
    /** Numbers for the reports: the forecast of the disk, the journal, the internet. */
    async reportData() {
      return {
        forecast: await diskHistory.forecast(),
        incidents: await incidents.list(8),
        internetUp: internet.up,
      };
    },
    /** The lines of the week ahead for one person (tasks, events, deadlines, downloads), for the summary report. */
    async weekLines(user: StoredUser) {
      const day = localMoment(clock()).day;
      const end = new Date(`T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 7);
      const { occurrences } = await calendar.occurrences(
        { username: user.username, isAdmin: user.role === 'admin' },
        day,
        end.toISOString().slice(0, 10),
      );
      const since = new Date(clock().getTime() - 7 * 86_400_000).toISOString();
      return {
        tasks: await tasksLines(user, day),
        events: occurrences
          .slice(0, 10)
          .map((o: CalendarOccurrence) => `: ${o.event.title}${o.event.time ? ` в ${o.event.time}` : ''}`),
        deadlines: (await deadlines.soon(user.username, 30))
          .slice(0, 10)
          .map(
            (d) =>
              ` — ${d.daysLeft < 0 ? 'просрочено' : d.daysLeft === 0 ? 'сегодня' : `через ${d.daysLeft} дн.`}`,
          ),
        downloads: deps.downloads
          .list(user.username)
          .filter((d) => d.state === 'completed' && d.completedAt !== null && d.completedAt >= since)
          .slice(0, 10)
          .map((d) => d.fileName),
      };
    },
    incidents,
    /** Called by the file routes when somebody opens a file. */
    onFileOpened(loc: { root: string; space: string; path: string }, username: string): void {
      if (loc.root !== 'files' || loc.space !== 'shared') return;
      void decoys
        .touched(loc.path)
        .then(async (name) => {
          if (name === null) return;
          await incidents.add('decoy', 'Открыт файл-приманка', `«${name}» открыл(а) ${username}`);
          await deps.audit.write({ action: 'decoy.touched', actor: username, ip: null, detail: `«${name}»` });
          await tellAdmins(
            'Открыт файл-приманка',
            `«${name}» открыл(а) ${username}. Если это не вы и не семья, проверьте, кто был в портале.`,
            `decoy:${name}`,
          );
        })
        .catch(() => undefined);
    },
    registerRoutes(app: FastifyInstance): void {
      const { guards, audit } = deps;
      registerDeadlineRoutes(app, { deadlines, guards, audit });
      registerDigestRoutes(app, { digest, users, guards, audit });
      registerSafetyRoutes(app, {
        guards,
        audit,
        decoys,
        network,
        safety,
        status: async () =>
          buildFamilyStatus({
            system: collector.snapshot('family'),
            internet,
            forecast: await diskHistory.forecast(),
            now: clock(),
          }),
      });
    },
    start(): void {
      // How the previous run ended is a fact for the journal.
      if (deps.previousRun.how === 'crashed') {
        void incidents.add(
          'shutdown',
          'Сервер выключился не штатно',
          `Последний раз был жив ${deps.previousRun.at ? money(deps.previousRun.at) : 'неизвестно когда'}: сбой, зависание или отключение питания`,
        );
      }
      // Hourly: reminders about deadlines and a point for the forecast of the disk.
      const hourly = safely('Часовые задачи', async () => {
        await deadlineWatcher.tick();
        await diskHistory.record();
        // Only when the space is really getting short: a steep line through 400 GB of free space is not a worry.
        const soon = (await diskHistory.forecast()).find(
          (f) => f.daysLeft !== null && f.daysLeft < 21 && f.freeBytes < 100 * 1024 ** 3,
        );
        if (soon) {
          await tellAdmins(
            'Диск скоро заполнится',
            `${soon.volume}: при нынешней скорости свободное место закончится примерно через ${soon.daysLeft} дн.`,
            `forecast:${soon.volume}`,
            '/system',
          );
        }
      });
      hourly();
      timers.push(setInterval(hourly, 3_600_000));
      // Every five minutes: the internet and the DNS; a change is written to the journal.
      const net = safely('Проверка интернета', async () => {
        const before = internet;
        internet = await checkInternet(clock);
        if (before.up !== null && before.up !== internet.up) {
          await incidents.add(
            'network',
            internet.up ? 'Интернет снова есть' : 'Пропал интернет',
            'проверка соединения по адресу, без имён',
          );
        }
        if (before.dnsUp !== null && before.up && internet.up && before.dnsUp !== internet.dnsUp) {
          await incidents.add(
            'network',
            internet.dnsUp ? 'DNS снова отвечает' : 'DNS не отвечает',
            'интернет есть, имена сайтов не находятся',
          );
        }
      });
      net();
      timers.push(setInterval(net, 300_000));
      // Every ten minutes: who is in the home network (the neighbour table, nothing is sent anywhere).
      const devices = safely('Список устройств сети', () => network.scan(false));
      setTimeout(devices, 20_000).unref();
      timers.push(setInterval(devices, 600_000));
      // Every minute: a program of the supervisor that fell and was started again is written to the journal.
      const restarts = new Map<string, number>();
      const programs = safely('Программы сервера', async () => {
        for (const program of collector.snapshot('admin').programs.value ?? []) {
          const before = restarts.get(program.name);
          restarts.set(program.name, program.restarts);
          if (before !== undefined && program.restarts > before) {
            await incidents.add(
              'program',
              `Программа перезапущена после сбоя: ${program.title}`,
              `перезапусков с начала работы супервизора: ${program.restarts}`,
            );
          }
        }
      });
      timers.push(setInterval(programs, 60_000));
      // Every minute: at the set time the morning digest goes out.
      timers.push(
        setInterval(
          safely('Утренний дайджест', () => digest.tick()),
          60_000,
        ),
      );
      for (const timer of timers) timer.unref();
    },
    stop(): void {
      for (const timer of timers) clearInterval(timer);
    },
    retireOwner: (username: string) => deadlines.retireOwner(username),
    /** The digest for one person at once (the bot's button). */
    async digestText(user: StoredUser): Promise<string> {
      const result = await digest.runNow(user);
      if (result !== 'too_soon') return result.text;
      return (
        (await digest.state(user.username)).mine.last?.text ??
        'Дайджест только что делали: подождите пять минут.'
      );
    },
    async tasksText(user: StoredUser): Promise<string> {
      const day = localMoment(clock()).day;
      const lines = await tasksLines(user, day);
      return lines.length > 0
        ? `Дела на сегодня:\n${lines.map((line) => `• ${line}`).join('\n')}`
        : 'На сегодня дел нет.';
    },
    async deadlinesText(user: StoredUser): Promise<string> {
      const list = (await deadlines.soon(user.username, 30)).slice(0, 10);
      return list.length > 0
        ? `Ближайшие сроки:\n${list
            .map(
              (d) =>
                `• ${d.title}: ${d.daysLeft < 0 ? `просрочен на ${-d.daysLeft} дн.` : d.daysLeft === 0 ? 'сегодня' : `через ${d.daysLeft} дн.`}`,
            )
            .join('\n')}`
        : 'Ближайших сроков нет.';
    },
    async statusText(): Promise<string> {
      const status = buildFamilyStatus({
        system: collector.snapshot('family'),
        internet,
        forecast: await diskHistory.forecast(),
        now: clock(),
      });
      return `.\n${status.items.map((item) => `• ${item.title}: ${item.text}`).join('\n')}`;
    },
    today: () => localMoment(clock()).day,
  };
}

export type Extras = ReturnType<typeof createExtras>;
