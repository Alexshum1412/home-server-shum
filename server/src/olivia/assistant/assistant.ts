/**
 * «Оливия» for the family: understands a question, looks things up or explains, shows the result.
 *
 * She is a front for the portal's own, already protected functions — she has no powers of her own:
 *  - she sees exactly what the asking person may see (their own and the shared folders, the
 *    catalogue, their downloads, the events they may see);
 *  - she never starts a download, deletes or changes anything: for a download she only prepares the
 *    check and shows the same «Скачать» button the Downloads page has;
 *  - her answers are made from facts by fixed templates, not written by the model; the model (when
 *    there is one) only helps to understand the question.
 */
import path from 'node:path';
import type {
  CatalogItem,
  DownloadCheckResponse,
  OliviaAnswer,
  OliviaCard,
  OliviaStatusResponse,
  StorageSpace,
} from '../../../../shared/api.ts';
import { hasPermission, type StoredUser } from '../../auth/users.ts';
import type { Config } from '../../config.ts';
import { DownloadError, type DownloadManager } from '../../downloads/manager.ts';
import type { TorrentManager } from '../../downloads/torrents.ts';
import { type FoundFile, normalise, searchNames, words } from '../../files/search.ts';
import type { JellyfinClient } from '../../jellyfin/client.ts';
import { JellyfinError } from '../../jellyfin/client.ts';
import type { ProgressStore } from '../../jellyfin/progress.ts';
import { formatBytes } from '../../lib/format.ts';
import type { Clock } from '../../lib/time.ts';
import type { ServiceRegistry } from '../../services/checker.ts';
import type { SystemCollector } from '../../system/collector.ts';
import type { LlmFetch, OliviaLlmConfig } from '../llm.ts';
import type { CalendarStoreLike } from './calendar-port.ts';
import { FAQ, faqById } from './knowledge.ts';
import { chooseWithModel, ModelUnavailable } from './model.ts';
import { type Plan, routeByRules } from './router.ts';

export interface AssistantDeps {
  config: Config;
  clock: Clock;
  registry: ServiceRegistry;
  collector: SystemCollector;
  catalog: JellyfinClient;
  progress: ProgressStore;
  downloads: DownloadManager;
  torrents: TorrentManager;
  calendar: CalendarStoreLike;
  llm: OliviaLlmConfig | null;
  llmFetch: LlmFetch;
}

export interface Assistant {
  /** `channel`: through the open-internet address she does not prepare downloads (they start only at home or over Tailscale). */
  ask(user: StoredUser, message: string, channel?: 'private' | 'public'): Promise<OliviaAnswer>;
  status(): Promise<OliviaStatusResponse>;
}

type Outcome = { reply: string; cards: OliviaCard[]; tool?: string };

const PLURAL = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

function agoText(from: string | null, now: number): string {
  if (!from) return 'неизвестно когда';
  const minutes = Math.max(0, Math.round((now - Date.parse(from)) / 60_000));
  if (minutes < 2) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  return `${days} ${PLURAL(days, 'день', 'дня', 'дней')} назад`;
}

const NOT_ALLOWED =
  'У вас нет разрешения на загрузки. Попросите администратора открыть его («Администрирование» → «Пользователи»).';

export function createAssistant(deps: AssistantDeps): Assistant {
  const { config, clock } = deps;
  // The slow model answers one question at a time; the rest are understood by the rules.
  let modelBusy = false;

  async function modelPlan(message: string): Promise<{ plan: Plan | null; note: string | null }> {
    if (!deps.llm) return { plan: null, note: null };
    if (modelBusy) return { plan: null, note: 'модель занята другим вопросом' };
    modelBusy = true;
    try {
      return { plan: await chooseWithModel(message, deps.llm, deps.llmFetch), note: null };
    } catch (error) {
      return { plan: null, note: error instanceof ModelUnavailable ? error.message : 'модель недоступна' };
    } finally {
      modelBusy = false;
    }
  }

  // --- tools -----------------------------------------------------------------------------------

  function faq(id: string, message: string): Outcome {
    const entry =
      faqById(id) ?? FAQ.find((item) => item.match.test(message.toLowerCase())) ?? faqById('capabilities');
    return {
      reply: entry?.answer ?? 'Спросите меня, что я умею.',
      cards: (entry?.links ?? []).map((link) => ({
        kind: 'link' as const,
        label: link.label,
        href: link.href,
      })),
      tool: 'faq',
    };
  }

  function status(user: StoredUser): Outcome {
    const snapshot = deps.collector.snapshot(user.role);
    const lines = [`Сейчас: ${snapshot.overall.text}`];
    for (const alert of snapshot.alerts.slice(0, 3)) lines.push(`• ${alert.title}. ${alert.text}`);
    const services = deps.registry
      .statuses()
      .filter((service) => service.state === 'offline' || service.state === 'degraded');
    for (const service of services.slice(0, 3)) lines.push(`• «${service.name}»: ${service.message}`);
    if (snapshot.alerts.length === 0 && services.length === 0) lines.push('Всё, что я проверяю, работает.');
    return {
      reply: lines.join('\n'),
      cards: [
        {
          kind: 'link',
          label: user.role === 'admin' ? 'Состояние системы' : 'Главная',
          href: user.role === 'admin' ? '/system' : '/',
        },
      ],
      tool: 'status',
    };
  }

  function disk(user: StoredUser): Outcome {
    const volumes = deps.collector.snapshot(user.role).volumes;
    const lines = volumes.map((volume) => {
      if (volume.totalBytes === null || volume.freeBytes === null)
        return `Диск ${volume.path}: нет данных (${volume.reason ?? 'не удалось измерить'}).`;
      const share = Math.round((volume.freeBytes / volume.totalBytes) * 100);
      return `Диск ${volume.path} свободно ${formatBytes(volume.freeBytes)} из ${formatBytes(volume.totalBytes)} (${share} %)${volume.lowSpace ? ' — места мало, сообщите администратору' : ''}.`;
    });
    return {
      reply: lines.length > 0 ? lines.join('\n') : 'Не удалось измерить свободное место.',
      cards: [],
      tool: 'disk',
    };
  }

  function backup(user: StoredUser): Outcome {
    const info = deps.collector.snapshot(user.role).backup;
    const now = clock().getTime();
    let text: string;
    switch (info.state) {
      case 'ok':
        text = `Резервная копия в порядке: последняя сделана ${agoText(info.lastSuccessAt, now)}.${info.restoreTested ? ' Восстановление из неё проверено.' : ''}`;
        break;
      case 'stale':
        text = `Копия давно не делалась: последняя была ${agoText(info.lastSuccessAt, now)}. Скажите администратору.`;
        break;
      case 'failed':
        text =
          'Последнее копирование не удалось. Скажите администратору — он посмотрит в «Состоянии системы».';
        break;
      case 'not_configured':
        text = 'Резервное копирование ещё не настроено. Скажите администратору.';
        break;
      default:
        text = 'Не знаю состояния копии: данных пока нет.';
    }
    if (user.role === 'admin') text += ` ${info.message}`;
    return { reply: text, cards: [], tool: 'backup' };
  }

  function mediaCard(item: CatalogItem): OliviaCard {
    return { kind: 'media', item, href: `/cinema?item=${item.id}` };
  }

  async function media(user: StoredUser, plan: Plan): Promise<Outcome> {
    try {
      const resume = (id: string) => deps.progress.get(user.id, id);
      // Jellyfin finds a piece of a title: ask with the longest stem, then keep the titles with all of them.
      const stems = words(plan.query);
      const longest = [...stems].sort((a, b) => b.length - a.length)[0];
      const page = await deps.catalog.list(
        {
          sort: plan.query ? 'name' : 'added',
          start: 0,
          limit: plan.query ? 50 : 6,
          ...(longest ? { search: longest } : {}),
        },
        resume,
      );
      const matching = page.items.filter((item) =>
        stems.every((stem) => normalise(item.title).includes(stem)),
      );
      const result = { items: matching.slice(0, 6), total: matching.length };
      if (result.items.length === 0) {
        return {
          reply: plan.query
            ? `В медиатеке ничего не нашлось по «${plan.query}». Попробуйте другое слово.`
            : 'В медиатеке пока ничего нет.',
          cards: [{ kind: 'link', label: 'Открыть кинотеатр', href: '/cinema' }],
          tool: 'media',
        };
      }
      return {
        reply: plan.query
          ? `Нашла в медиатеке (${result.total}): откройте нужное.`
          : 'Вот что недавно добавили в медиатеку.',
        cards: result.items.map(mediaCard),
        tool: 'media',
      };
    } catch (error) {
      if (!(error instanceof JellyfinError)) throw error;
      // The second way: the library's own folders, by file name — the cinema (Jellyfin) is not needed for that.
      const found = plan.query
        ? await searchNames([{ root: 'media', space: 'shared', dir: config.mediaDir }], plan.query)
        : [];
      return {
        reply:
          found.length > 0
            ? `Кинотеатр (Jellyfin) сейчас недоступен, но по названиям файлов нашла (${found.length}): их можно включить в запасном просмотре.`
            : `Кинотеатр (Jellyfin) сейчас недоступен${plan.query ? `, и по названию «${plan.query}» в папках ничего нет` : ''}. Запасной просмотр без него — на странице кинотеатра.`,
        cards:
          found.length > 0
            ? found.map((file) => ({
                kind: 'file' as const,
                name: file.name,
                where: `медиатека${file.folder ? ` / ${file.folder}` : ''}`,
                sizeBytes: file.sizeBytes,
                isFolder: file.isFolder,
                href: `/cinema?fallback=1&media=${encodeURIComponent(file.folder)}`,
              }))
            : [{ kind: 'link', label: 'Запасной просмотр', href: '/cinema?fallback=1' }],
        tool: 'media',
      };
    }
  }

  async function files(user: StoredUser, plan: Plan): Promise<Outcome> {
    if (!plan.query) {
      return {
        reply: 'Что искать? Назовите слово из названия файла или фотографии, например «договор» или «дача».',
        cards: [],
        tool: 'files',
      };
    }
    const places: Array<{ root: 'files' | 'photos'; space: StorageSpace; dir: string }> = [];
    const roots: Array<['files' | 'photos', string]> = [
      ['files', config.filesDir],
      ['photos', config.photosDir],
    ];
    for (const [root, base] of roots) {
      if (plan.where !== 'any' && plan.where !== root) continue;
      places.push({ root, space: 'personal', dir: path.join(base, 'users', user.username) });
      places.push({ root, space: 'shared', dir: path.join(base, 'shared') });
    }
    const found = await searchNames(places, plan.query);
    if (found.length === 0) {
      return {
        reply: `По названию «${plan.query}» ничего не нашла в ваших и общих папках. Я ищу только по названиям, не по содержимому.`,
        cards: [],
        tool: 'files',
      };
    }
    return {
      reply: `Нашла по названию «${plan.query}»${found.length >= 20 ? ' (показаны первые 20)' : ''}: ${found.length}. Ищу только в ваших и общих папках.`,
      cards: found.map(fileCard),
      tool: 'files',
    };
  }

  function fileCard(file: FoundFile): OliviaCard {
    const where = `${file.root === 'photos' ? 'Фото' : 'Файлы'} / ${file.space === 'shared' ? 'общее' : 'личное'}${file.folder ? ` / ${file.folder}` : ''}`;
    const page = file.root === 'photos' ? '/photos' : '/files';
    const params = new URLSearchParams({ space: file.space });
    if (file.root === 'photos') {
      const month = file.folder.split('/')[0] ?? '';
      if (month) params.set('month', month);
    } else if (file.folder || file.isFolder) {
      params.set(
        'path',
        file.isFolder ? (file.folder ? `${file.folder}/${file.name}` : file.name) : file.folder,
      );
    }
    return {
      kind: 'file',
      name: file.name,
      where,
      sizeBytes: file.sizeBytes,
      isFolder: file.isFolder,
      href: `${page}?${params.toString()}`,
    };
  }

  async function downloads(user: StoredUser): Promise<Outcome> {
    if (!hasPermission(user, 'downloads')) return { reply: NOT_ALLOWED, cards: [], tool: 'downloads' };
    const owner = user.role === 'admin' ? null : user.username;
    const tasks = [...deps.downloads.list(owner), ...(await deps.torrents.list(owner).catch(() => []))].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    if (tasks.length === 0) {
      return {
        reply: 'Загрузок нет. Чтобы скачать, пришлите мне ссылку или откройте «Загрузки».',
        cards: [{ kind: 'link', label: 'Загрузки', href: '/downloads' }],
        tool: 'downloads',
      };
    }
    const active = tasks.filter((task) => task.state === 'downloading' || task.state === 'queued').length;
    const failed = tasks.filter((task) => task.state === 'failed').length;
    const parts = [`Загрузок: ${tasks.length}`];
    if (active > 0) parts.push(`идут или ждут: ${active}`);
    if (failed > 0) parts.push(`с ошибкой: ${failed}`);
    return {
      reply: `${parts.join(', ')}.`,
      cards: tasks.slice(0, 5).map((task) => ({ kind: 'task' as const, task })),
      tool: 'downloads',
    };
  }

  async function addDownload(user: StoredUser, plan: Plan): Promise<Outcome> {
    if (!hasPermission(user, 'downloads')) return { reply: NOT_ALLOWED, cards: [], tool: 'add_download' };
    try {
      const isMagnet = /^magnet:/i.test(plan.url);
      const check: DownloadCheckResponse = isMagnet
        ? await deps.torrents.checkMagnet(user.username, plan.url)
        : {
            ...(await deps.downloads.probe(user.username, plan.url)),
            kind: 'link',
            status: 'ready',
            error: null,
            files: [],
            willDownload: null,
            destinations: [{ id: 'personal', label: 'Файлы → Личное → Загрузки' }],
          };
      return {
        reply: isMagnet
          ? 'Проверяю раздачу. Через несколько секунд ниже появится, что внутри, — тогда выберите, куда сохранить, и нажмите «Скачать». Сама я ничего не скачиваю.'
          : `Проверила ссылку: «${check.fileName}», ${check.sizeBytes === null ? 'размер сайт не сообщает' : formatBytes(check.sizeBytes)}. Если всё верно, нажмите «Скачать». Сама я ничего не скачиваю.`,
        cards: [{ kind: 'download-check', check }],
        tool: 'add_download',
      };
    } catch (error) {
      if (error instanceof DownloadError)
        return {
          reply: error.message,
          cards: [{ kind: 'link', label: 'Загрузки', href: '/downloads' }],
          tool: 'add_download',
        };
      throw error;
    }
  }

  async function calendar(user: StoredUser): Promise<Outcome> {
    const day = (offset: number) => {
      const d = new Date(clock().getTime() + offset * 86_400_000);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const today = day(0);
    const tomorrow = day(1);
    const { occurrences } = await deps.calendar.occurrences(
      { username: user.username, isAdmin: user.role === 'admin' },
      today,
      tomorrow,
    );
    if (occurrences.length === 0) {
      return {
        reply: 'На сегодня и завтра в календаре ничего нет.',
        cards: [{ kind: 'link', label: 'Календарь', href: '/calendar' }],
        tool: 'calendar',
      };
    }
    return {
      reply: `В календаре на сегодня и завтра: ${occurrences.length}.`,
      cards: occurrences.slice(0, 8).map((occurrence) => ({
        kind: 'event' as const,
        when: `${occurrence.day === today ? 'Сегодня' : 'Завтра'}${occurrence.event.time ? `, ${occurrence.event.time}` : ''}`,
        title: occurrence.event.title,
      })),
      tool: 'calendar',
    };
  }

  function unknown(): Outcome {
    return {
      reply:
        'Я не поняла вопрос. Я умею: искать фильмы, фото и файлы по названию, показывать свободное место, состояние сервера и загрузок, события календаря, объяснять, как пользоваться порталом, и проверять ссылку для загрузки. Попробуйте, например: «найди фильм про кота» или «сколько места на диске».',
      cards: [],
      tool: 'unknown',
    };
  }

  async function run(
    user: StoredUser,
    plan: Plan,
    message: string,
    channel: 'private' | 'public',
  ): Promise<Outcome> {
    switch (plan.tool) {
      case 'faq':
        return faq(plan.faqId, message);
      case 'status':
        return status(user);
      case 'disk':
        return disk(user);
      case 'backup':
        return backup(user);
      case 'media':
        return media(user, plan);
      case 'files':
        return files(user, plan);
      case 'downloads':
        return downloads(user);
      case 'add_download':
        if (channel === 'public') {
          return {
            reply:
              'Через внешний адрес загрузки не запускаются. Откройте портал через Tailscale или из домашней сети и спросите меня снова.',
            cards: [],
            tool: 'add_download',
          };
        }
        return addDownload(user, plan);
      case 'calendar':
        return calendar(user);
      default:
        return unknown();
    }
  }

  return {
    async ask(user, message, channel = 'private') {
      const text = message.trim();
      let plan = routeByRules(text);
      let via: 'model' | 'rules' = 'rules';
      let note: string | null = null;
      // The patterns decide the clear cases at once; the model helps with the loose ones.
      if (!plan.confident && deps.llm) {
        const asked = await modelPlan(text);
        note = asked.note;
        if (asked.plan && !(asked.plan.tool === 'unknown' && plan.tool !== 'unknown')) {
          plan = asked.plan;
          via = 'model';
        }
      }
      const outcome = await run(user, plan, text, channel);
      return { reply: outcome.reply, via, tool: outcome.tool ?? plan.tool, cards: outcome.cards, note };
    },

    async status() {
      const llm = deps.llm;
      if (!llm) {
        return {
          enabled: true,
          model: {
            configured: false,
            reachable: false,
            name: null,
            message: 'Языковая модель не подключена: «Оливия» понимает вопросы по готовым правилам.',
          },
        };
      }
      try {
        const response = await deps.llmFetch(`${llm.url.replace(/\/+$/, '')}/models`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error('bad');
        return {
          enabled: true,
          model: {
            configured: true,
            reachable: true,
            name: llm.model,
            message: 'Языковая модель работает на этом компьютере.',
          },
        };
      } catch {
        return {
          enabled: true,
          model: {
            configured: true,
            reachable: false,
            name: llm.model,
            message: 'Языковая модель подключена, но не отвечает. «Оливия» работает по готовым правилам.',
          },
        };
      }
    },
  };
}
