/**
 * What the administrator's «Сервер» page shows and may do, in plain words.
 *
 * Seeing: the state of the programs the supervisor runs (the last start and the restarts), the last
 * errors of the portal and of the supervisor, the disks, the backups, the language model and the
 * download queue. Doing: start, stop or restart one of four fixed programs, make a backup, check the
 * services — nothing else. A program is named by its id from a fixed list in code; the browser never
 * sends a command line, a path or any other name. Everything that leaves this module as text goes
 * through the sanitiser first (see sanitize.ts).
 */
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';

const DOCKER_PATHS = [
  'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
  'C:/Windows/System32/docker.exe',
];

import type { DownloadTaskView, ProgramState, ServiceStatus, SystemResponse } from '../../../shared/api.ts';
import {
  type DownloadCounts,
  type ErrorLines,
  type ModelView,
  PROGRAM_IDS,
  type ProgramId,
  type ProgramView,
  type ServerAction,
  type ServerActionResponse,
  type ServerPageResponse,
  type ServerReportResponse,
} from '../../../shared/server-page.ts';
import type { StoredUser } from '../auth/users.ts';
import type { Config } from '../config.ts';
import { formatBytes } from '../lib/format.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import { sendCommand } from '../supervisor/main.ts';
import { clockTime, type PreviousRun } from '../system/run-state.ts';
import { reportContext } from './report-context.ts';
import { sanitizeReport } from './sanitize.ts';

export const ERROR_LINES = 20;
const LINE_MAX = 400;
const TAIL_BYTES = 96 * 1024;
/** The same action on the same program is not repeated within this time (a double click). */
export const ACTION_GAP_MS = 15_000;

const PROGRAM_TITLE: Record<ProgramId, string> = {
  dashboard: 'Портал (этот сайт)',
  jellyfin: 'Кинотеатр (Jellyfin)',
  aria2: 'Торрент-клиент (aria2)',
  llama: 'Языковая модель Оливии',
  searxng: 'Поиск в интернете (SearXNG)',
  kavita: 'Читалка комиксов и манги (Kavita)',
  kiwix: 'Офлайн-библиотека (Kiwix)',
  freellm: 'Бесплатные модели (роутер FreeLLMAPI)',
};

const STATE_TEXT: Record<ProgramState, string> = {
  running: 'Работает',
  starting: 'Запускается',
  backoff: 'Сбой, ждёт перезапуска',
  stopping: 'Останавливается',
  stopped: 'Остановлена',
  external: 'Работает отдельно от супервизора',
  unknown: 'Состояние неизвестно',
};

export class ServerPageError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ServerPageDeps {
  config: Config;
  clock: Clock;
  version: string;
  supervisorPipe: string;
  /** The system snapshot: programs, disks and backup as the system page shows them. */
  snapshot: () => SystemResponse;
  services: () => ServiceStatus[];
  recheckServices: () => Promise<void>;
  users: () => Promise<StoredUser[]>;
  downloads: () => Promise<DownloadTaskView[]>;
  model: () => Promise<ModelView>;
  backupRunning: () => Promise<boolean>;
  startBackup: () => Promise<void>;
  /** How the previous run of the portal ended, and when this one started. */
  run: () => { startedAt: string | null; previous: PreviousRun };
  /** Injectable for tests. */
  send?: typeof sendCommand;
  /** The portal answers first and is stopped a moment later (a stop of the portal ends the request that asked for it). */
  later?: (work: () => void, ms: number) => void;
}

async function tail(file: string): Promise<string[] | null> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    // The first line of a cut piece is usually half a line.
    if (size > length) lines.shift();
    return lines.filter((line) => line.trim() !== '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

/** One line of the portal's JSON log as «время уровень сообщение», or the line itself when it is not JSON. */
function readableLine(line: string): { text: string; level: number } {
  try {
    const parsed = JSON.parse(line) as {
      level?: number;
      time?: number | string;
      msg?: string;
      err?: { message?: string };
    };
    const level = typeof parsed.level === 'number' ? parsed.level : 30;
    const at =
      parsed.time === undefined ? '' : new Date(parsed.time).toISOString().replace('T', ' ').slice(0, 19);
    const label = level >= 60 ? 'FATAL' : level >= 50 ? 'ERROR' : level >= 40 ? 'WARN' : 'INFO';
    return {
      text: `${at} ${label} ${parsed.msg ?? ''}${parsed.err?.message ? ` (${parsed.err.message})` : ''}`.trim(),
      level,
    };
  } catch {
    return { text: line, level: 50 };
  }
}

export function createServerPage(deps: ServerPageDeps) {
  const { config } = deps;
  const logDir = path.join(config.dataDir, 'logs');
  const lastRun = new Map<string, number>();
  const send = deps.send ?? sendCommand;
  const later = deps.later ?? ((work: () => void, ms: number) => void setTimeout(work, ms).unref());

  async function context() {
    const { names = [], hosts = [] } = reportContext(config, await deps.users());
    return { names, hosts };
  }

  function programs(snapshot: SystemResponse): {
    list: ProgramView[];
    supervisorRunning: boolean;
    note: string;
  } {
    const reported = snapshot.programs.value;
    const list: ProgramView[] = PROGRAM_IDS.map((id) => {
      const found = reported?.find((program) => program.name === id);
      if (found) {
        return {
          id,
          title: PROGRAM_TITLE[id],
          state: found.state,
          stateText: STATE_TEXT[found.state],
          startedAt: found.startedAt,
          restarts: found.restarts,
        };
      }
      // The portal answers this very request: it is running even when the supervisor is not.
      if (id === 'dashboard') {
        return {
          id,
          title: PROGRAM_TITLE[id],
          state: 'external',
          stateText: STATE_TEXT.external,
          startedAt: null,
          restarts: 0,
        };
      }
      return {
        id,
        title: PROGRAM_TITLE[id],
        state: 'unknown',
        stateText: reported
          ? 'Не установлена или выключена в настройках'
          : 'Неизвестно: супервизор не запущен',
        startedAt: null,
        restarts: 0,
      };
    });
    return {
      list,
      supervisorRunning: reported !== null,
      note: reported
        ? 'Супервизор работает и сам перезапускает программы после сбоя.'
        : (snapshot.programs.reason ?? 'Супервизор не запущен.'),
    };
  }

  /** raw: the lines as they are (the report sanitises the whole text once, so it can count what it removed). */
  async function logLines(raw = false): Promise<ErrorLines[]> {
    const { names, hosts } = await context();
    const clean = (list: string[]): string[] =>
      raw
        ? list.map((line) => line.slice(0, LINE_MAX))
        : sanitizeReport(list.map((line) => line.slice(0, LINE_MAX)).join('\n'), { names, hosts }).text.split(
            '\n',
          );
    const result: ErrorLines[] = [];
    const sources: Array<{
      source: ErrorLines['source'];
      label: string;
      file: string;
      pick: (lines: string[]) => string[];
    }> = [
      {
        source: 'portal-errors',
        label: 'Ошибки портала (dashboard.err.log)',
        file: path.join(logDir, 'dashboard.err.log'),
        pick: (lines) => lines,
      },
      {
        source: 'portal-warnings',
        label: 'Предупреждения и ошибки в журнале портала',
        file: path.join(logDir, 'dashboard.out.log'),
        pick: (lines) =>
          lines
            .map(readableLine)
            .filter((entry) => entry.level >= 40)
            .map((entry) => entry.text),
      },
      {
        source: 'supervisor',
        label: 'Журнал супервизора',
        file: path.join(logDir, 'supervisor.log'),
        pick: (lines) => lines,
      },
    ];
    for (const item of sources) {
      try {
        const lines = await tail(item.file);
        if (lines === null) {
          result.push({ source: item.source, label: item.label, lines: [], note: 'Файла журнала ещё нет.' });
          continue;
        }
        const picked = item.pick(lines).slice(-ERROR_LINES);
        result.push({
          source: item.source,
          label: item.label,
          lines: clean(picked),
          note: picked.length === 0 ? 'Нет записей: всё спокойно.' : null,
        });
      } catch {
        result.push({
          source: item.source,
          label: item.label,
          lines: [],
          note: 'Журнал не удалось прочитать.',
        });
      }
    }
    return result;
  }

  function counts(tasks: DownloadTaskView[]): DownloadCounts {
    const count = (...states: DownloadTaskView['state'][]) =>
      tasks.filter((task) => states.includes(task.state)).length;
    return {
      total: tasks.length,
      active: count('downloading'),
      queued: count('queued'),
      paused: count('paused'),
      failed: count('failed'),
      completed: count('completed'),
    };
  }

  /** Docker is not part of the base install: it is only looked for in the usual places. */
  function dockerState(): { installed: boolean; message: string } {
    const installed = DOCKER_PATHS.some((file) => existsSync(file));
    return installed
      ? {
          installed,
          message:
            'Docker установлен. Контейнеры (ArchiveBox, Home Assistant) запускаются вручную: см. docs/runbooks/docker.md.',
        }
      : {
          installed,
          message:
            'Docker не установлен (нужен только для ArchiveBox и Home Assistant; всё остальное работает без него). Как поставить: docs/runbooks/docker.md.',
        };
  }

  async function view(raw = false): Promise<ServerPageResponse> {
    const snapshot = deps.snapshot();
    const { list, supervisorRunning, note } = programs(snapshot);
    const run = deps.run();
    let downloads: DownloadCounts | null = null;
    try {
      downloads = counts(await deps.downloads());
    } catch {
      downloads = null;
    }
    return {
      generatedAt: isoNow(deps.clock),
      supervisor: {
        running: supervisorRunning,
        startedAt: list.map((program) => program.startedAt).find((value) => value !== null) ?? null,
        message: note,
      },
      programs: list,
      portal: {
        startedAt: run.startedAt,
        previousRun: run.previous.how,
        previousRunAt: run.previous.at,
      },
      errors: await logLines(raw),
      disks: snapshot.volumes,
      backup: snapshot.backup,
      backupRunning: await deps.backupRunning(),
      model: await deps.model(),
      downloads,
      docker: dockerState(),
    };
  }

  /** The text for «Скопировать» and «Скачать»: nothing in it identifies a person, a device or a secret. */
  async function report(): Promise<ServerReportResponse> {
    const page = await view(true);
    const snapshot = deps.snapshot();
    const lines: string[] = [];
    const add = (text = '') => lines.push(text);
    add('Семейный сервер: отчёт для помощи');
    add(`Составлен: ${new Date(page.generatedAt).toLocaleString('ru-RU')}`);
    add(
      `Версия портала: ${deps.version}; Node ${process.version}; ${snapshot.server.osRelease ?? process.platform}`,
    );
    add(
      `Портал запущен: ${page.portal.startedAt ? new Date(page.portal.startedAt).toLocaleString('ru-RU') : 'неизвестно'}; прошлый запуск: ${
        page.portal.previousRun === 'clean'
          ? 'завершился штатно'
          : page.portal.previousRun === 'crashed'
            ? `оборвался (последний признак жизни в ${page.portal.previousRunAt ? clockTime(page.portal.previousRunAt) : 'неизвестное время'})`
            : 'сведений нет'
      }`,
    );
    add();
    add('Программы:');
    for (const program of page.programs) {
      add(
        `- ${program.title}: ${program.stateText}${program.restarts > 0 ? `, перезапусков после сбоя: ${program.restarts}` : ''}`,
      );
    }
    add(`Супервизор: ${page.supervisor.message}`);
    add();
    add('Диски:');
    for (const disk of page.disks) {
      add(
        disk.totalBytes === null || disk.freeBytes === null
          ? `- ${disk.path}: нет данных (${disk.reason ?? 'не удалось измерить'})`
          : `- ${disk.path}: свободно ${formatBytes(disk.freeBytes)} из ${formatBytes(disk.totalBytes)}${disk.lowSpace ? ' — места мало' : ''}`,
      );
    }
    add();
    add(`Резервные копии: ${page.backup.message}`);
    if (page.backup.offsite) add(`Зашифрованная копия вне дома: ${page.backup.offsite.message}`);
    for (const remark of page.backup.notes ?? []) add(`- ${remark}`);
    add();
    add(`Языковая модель: ${page.model.message}`);
    add(
      page.downloads
        ? `Загрузки: всего ${page.downloads.total}, идут ${page.downloads.active}, в очереди ${page.downloads.queued}, на паузе ${page.downloads.paused}, с ошибкой ${page.downloads.failed}, готово ${page.downloads.completed}`
        : 'Загрузки: нет данных',
    );
    add();
    add('Службы:');
    for (const service of deps.services()) add(`- ${service.name}: ${service.state}. ${service.message}`);
    for (const block of page.errors) {
      add();
      add(`${block.label}:`);
      if (block.lines.length === 0) add(`  ${block.note ?? '—'}`);
      for (const line of block.lines) add(`  ${line}`);
    }
    const { names, hosts } = await context();
    const clean = sanitizeReport(lines.join('\n'), { names, hosts });
    return { generatedAt: page.generatedAt, text: clean.text, removed: clean.removed };
  }

  async function act(request: {
    action: ServerAction;
    program?: ProgramId | undefined;
    confirm?: boolean | undefined;
    portalConfirmed?: boolean | undefined;
  }): Promise<ServerActionResponse> {
    const { action, program } = request;
    const key = `${action}:${program ?? ''}`;
    const now = deps.clock().getTime();
    if (now - (lastRun.get(key) ?? Number.NEGATIVE_INFINITY) < ACTION_GAP_MS) {
      throw new ServerPageError(
        429,
        'too_many_requests',
        'Это только что выполнялось. Подождите несколько секунд.',
      );
    }

    if (action === 'recheck') {
      lastRun.set(key, now);
      await deps.recheckServices();
      return { ok: true, message: 'Службы проверены.' };
    }

    if (action === 'backup') {
      if (await deps.backupRunning())
        throw new ServerPageError(409, 'not_applicable', 'Копирование уже идёт.');
      lastRun.set(key, now);
      await deps.startBackup();
      return {
        ok: true,
        message: 'Копирование запущено. Результат появится на этой странице через несколько минут.',
      };
    }

    if (!program) throw new ServerPageError(400, 'bad_request', 'Не указана программа.');
    if ((action === 'stop' || action === 'restart') && request.confirm !== true) {
      throw new ServerPageError(400, 'confirm_required', 'Действие нужно подтвердить.');
    }
    if (program === 'dashboard') {
      if (action === 'start')
        throw new ServerPageError(409, 'not_applicable', 'Портал уже работает: вы на его странице.');
      if (request.portalConfirmed !== true) {
        throw new ServerPageError(
          400,
          'portal_confirm_required',
          action === 'stop'
            ? 'Остановка портала отключит эту страницу и весь семейный портал. Включить снова можно только кнопкой «Включить сервер» на рабочем столе компьютера.'
            : 'Перезапуск портала отключит страницу на полминуты, звонки оборвутся.',
        );
      }
    }
    if (!deps.snapshot().programs.value) {
      throw new ServerPageError(
        409,
        'no_supervisor',
        'Супервизор не запущен, поэтому с этой страницы программы не управляются. Запустите сервер кнопкой на рабочем столе или командой scripts\\start.cmd.',
      );
    }

    lastRun.set(key, now);
    const command = { cmd: action, app: program } as const;
    const title = PROGRAM_TITLE[program];
    if (program === 'dashboard') {
      // The portal stops itself: the answer goes out first, the command a moment later.
      later(() => {
        void send(deps.supervisorPipe, command, 120_000).catch(() => undefined);
      }, 400);
      return {
        ok: true,
        message:
          action === 'restart'
            ? 'Портал перезапускается. Страница ненадолго пропадёт — обновите её через полминуты.'
            : 'Портал останавливается. Включить снова можно кнопкой «Включить сервер» на рабочем столе.',
      };
    }
    const answer = (await send(deps.supervisorPipe, command, 120_000)) as { ok?: boolean; error?: string };
    if (!answer.ok)
      throw new ServerPageError(502, 'supervisor_failed', answer.error ?? 'Супервизор отказал.');
    const done = action === 'start' ? 'запускается' : action === 'stop' ? 'остановлена' : 'перезапущена';
    return { ok: true, message: `${title}: ${done}.` };
  }

  return { view, report, act };
}

export type ServerPage = ReturnType<typeof createServerPage>;
