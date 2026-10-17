import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ServiceState, ServiceStatus } from '../../../shared/api.ts';
import type { Config } from '../config.ts';
import { readJsonFile } from '../lib/json-store.ts';
import { type Clock, formatSeconds, isoNow } from '../lib/time.ts';
import {
  DEFAULT_SERVICES,
  type LoadedServices,
  loadServicesConfig,
  type ServiceDefinition,
  safeHttpUrl,
} from './config.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface CheckResult {
  url: string;
  state: 'online' | 'degraded' | 'offline';
  checkedAt: string;
  latencyMs: number | null;
  /** Plain words for everyone. */
  message: string;
  /** Technical detail for the admin, e.g. "HTTP 503", "ECONNREFUSED 127.0.0.1:8096". */
  detail: string | null;
}

export interface ServiceRegistry {
  /** Loads services.json (creating it from defaults when missing) without running checks. */
  init(): Promise<void>;
  /** Re-reads services.json and checks every enabled, configured service in parallel. */
  checkAll(): Promise<void>;
  statuses(): ServiceStatus[];
  configError(): string | null;
  start(): void;
  stop(): void;
}

export interface ServiceRegistryOptions {
  config: Config;
  clock: Clock;
  fetch: FetchLike;
  onConfigError?: (message: string) => void;
}

/** What the supervisor (run/supervisor.json) says about a program; see supervisor/managed.ts. */
export interface ProcessInfo {
  state: string;
  restarts: number;
  message: string;
}

/** Plain-words status for a program that does not answer its health check, by supervisor state. */
export function describeProcess(info: ProcessInfo | undefined): { message: string; hint: string } | null {
  switch (info?.state) {
    case 'stopped':
      return {
        message: 'Остановлен',
        hint: 'Сервис остановлен на сервере. Попросите администратора запустить его снова.',
      };
    case 'stopping':
      return { message: 'Останавливается', hint: 'Подождите минуту и попробуйте ещё раз.' };
    case 'starting':
      return { message: 'Запускается', hint: 'Подождите минуту и попробуйте ещё раз.' };
    case 'backoff':
      return {
        message: 'Сбой: сервис перезапускается автоматически',
        hint: 'Подождите минуту. Если ошибка повторяется, сообщите администратору.',
      };
    default:
      return null;
  }
}

async function readSupervisorApps(dataDir: string): Promise<Map<string, ProcessInfo>> {
  const map = new Map<string, ProcessInfo>();
  try {
    const data = (await readJsonFile(path.join(dataDir, 'run', 'supervisor.json'))) as
      | { apps?: Array<{ name?: unknown; state?: unknown; restarts?: unknown; message?: unknown }> }
      | undefined;
    for (const app of data?.apps ?? []) {
      if (typeof app.name !== 'string' || typeof app.state !== 'string') continue;
      map.set(app.name, {
        state: app.state,
        restarts: typeof app.restarts === 'number' ? app.restarts : 0,
        message: typeof app.message === 'string' ? app.message.slice(0, 200) : '',
      });
    }
  } catch {
    // no supervisor (manual start, tests) or an unreadable file: plain health results only
  }
  return map;
}

const OFFLINE_HINT =
  'Проверьте, что компьютер-сервер включён и сервис запущен. Если не помогает — сообщите администратору.';
const DEGRADED_HINT = 'Попробуйте открыть позже. Если ошибка повторяется, сообщите администратору.';

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** Error code of a failed fetch (undici puts it on `cause`), with the address when known. */
function connectionErrorDetail(error: unknown): string | null {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null ? error.cause : null;
  for (const source of [cause, error]) {
    if (typeof source !== 'object' || source === null) continue;
    const { code, address, port } = source as { code?: unknown; address?: unknown; port?: unknown };
    if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) {
      return typeof address === 'string' && typeof port === 'number' ? `${code} ${address}:${port}` : code;
    }
  }
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 160) : null;
}

async function checkOne(
  url: string,
  options: { fetch: FetchLike; timeoutMs: number; clock: Clock },
): Promise<CheckResult> {
  const started = performance.now();
  try {
    // redirect: 'manual' — a 3xx counts as "answering" and is never followed to another host.
    const response = await options.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { 'user-agent': 'family-dashboard-health-check' },
    });
    const latencyMs = Math.round(performance.now() - started);
    await response.body?.cancel().catch(() => undefined);
    const status = response.status;
    if (status === 0 || (status >= 200 && status < 400)) {
      return {
        url,
        state: 'online',
        checkedAt: isoNow(options.clock),
        latencyMs,
        message: 'Работает',
        detail: null,
      };
    }
    return {
      url,
      state: 'degraded',
      checkedAt: isoNow(options.clock),
      latencyMs: null,
      message: 'Сервис отвечает с ошибкой',
      detail: `HTTP ${status}`,
    };
  } catch (error) {
    const timedOut = isTimeout(error);
    return {
      url,
      state: 'offline',
      checkedAt: isoNow(options.clock),
      latencyMs: null,
      message: timedOut ? `Сервис не ответил за ${formatSeconds(options.timeoutMs)} с` : 'Сервис не отвечает',
      detail: timedOut ? `timeout ${options.timeoutMs} мс` : connectionErrorDetail(error),
    };
  }
}

interface Resolved {
  definition: ServiceDefinition;
  openUrl: string | null;
  /** URL to check, or null when the service is not configured / has a bad URL. */
  checkUrl: string | null;
  invalidUrl: boolean;
}

function resolve(definition: ServiceDefinition): Resolved {
  const open = safeHttpUrl(definition.openUrl);
  const health = safeHttpUrl(definition.healthUrl);
  if (!open.ok || !health.ok) return { definition, openUrl: null, checkUrl: null, invalidUrl: true };
  return { definition, openUrl: open.url, checkUrl: health.url ?? open.url, invalidUrl: false };
}

function toStatus(item: Resolved, result: CheckResult | undefined, proc?: ProcessInfo): ServiceStatus {
  const { definition } = item;
  const base = {
    id: definition.id,
    kind: definition.kind,
    name: definition.name,
    description: definition.description,
    demo: false,
  };
  const status = (
    state: ServiceState,
    message: string,
    hint: string | null,
    extra?: Partial<ServiceStatus>,
  ): ServiceStatus => ({
    ...base,
    openUrl: null,
    checkedAt: null,
    latencyMs: null,
    state,
    message,
    hint,
    detail: null,
    ...extra,
  });

  if (!definition.enabled) {
    return status('disabled', 'Сервис отключён администратором', definition.hint);
  }
  if (item.invalidUrl) {
    return status(
      'not_configured',
      'Адрес сервиса указан неверно',
      'Администратору нужно исправить адрес в файле services.json (только http:// или https://).',
    );
  }
  if (item.checkUrl === null) {
    return status('not_configured', 'Сервис ещё не подключён', definition.hint);
  }
  if (!result || result.url !== item.checkUrl) {
    return status('unknown', 'Проверка ещё не выполнялась', null, { openUrl: item.openUrl });
  }
  const hint = result.state === 'online' ? null : result.state === 'degraded' ? DEGRADED_HINT : OFFLINE_HINT;
  const known = result.state === 'offline' ? describeProcess(proc) : null;
  if (known && proc) {
    return status('offline', known.message, known.hint, {
      openUrl: item.openUrl,
      checkedAt: result.checkedAt,
      detail: `${result.detail ?? 'нет ответа'}; супервизор: ${proc.state}, перезапусков ${proc.restarts}`,
    });
  }
  return status(result.state, result.message, hint, {
    openUrl: item.openUrl,
    checkedAt: result.checkedAt,
    latencyMs: result.latencyMs,
    detail: result.detail,
  });
}

/** Fabricated, clearly labelled states for DASHBOARD_DEMO=1. */
function demoStatuses(clock: Clock): ServiceStatus[] {
  const now = isoNow(clock);
  const byId = new Map(DEFAULT_SERVICES.map((service) => [service.id, service]));
  const make = (id: string, extra: Omit<ServiceStatus, 'id' | 'kind' | 'name' | 'description' | 'demo'>) => {
    const definition = byId.get(id);
    if (!definition) throw new Error(`unknown demo service ${id}`);
    const { kind, name, description } = definition;
    return { id, kind, name, description, demo: true, ...extra } satisfies ServiceStatus;
  };
  return [
    make('media', {
      openUrl: 'http://127.0.0.1:8096',
      state: 'online',
      checkedAt: now,
      latencyMs: 12,
      message: 'Работает (демо)',
      hint: null,
      detail: null,
    }),
    make('photos', {
      openUrl: 'http://127.0.0.1:2283',
      state: 'offline',
      checkedAt: now,
      latencyMs: null,
      message: 'Сервис не отвечает (демо)',
      hint: OFFLINE_HINT,
      detail: 'ECONNREFUSED 127.0.0.1:2283 (демо)',
    }),
    make('files', {
      openUrl: null,
      state: 'not_configured',
      checkedAt: null,
      latencyMs: null,
      message: 'Сервис ещё не подключён (демо)',
      hint: byId.get('files')?.hint ?? null,
      detail: null,
    }),
    make('downloads', {
      openUrl: 'http://127.0.0.1:8080',
      state: 'degraded',
      checkedAt: now,
      latencyMs: null,
      message: 'Сервис отвечает с ошибкой (демо)',
      hint: DEGRADED_HINT,
      detail: 'HTTP 503 (демо)',
    }),
    make('calendar', {
      openUrl: null,
      state: 'not_configured',
      checkedAt: null,
      latencyMs: null,
      message: 'Сервис ещё не подключён (демо)',
      hint: byId.get('calendar')?.hint ?? null,
      detail: null,
    }),
  ];
}

export function createServiceRegistry(options: ServiceRegistryOptions): ServiceRegistry {
  const { config, clock } = options;
  let loaded: LoadedServices = { services: [], configError: null };
  const results = new Map<string, CheckResult>();
  let processes = new Map<string, ProcessInfo>();
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastReportedError: string | null = null;

  async function load(): Promise<void> {
    try {
      loaded = await loadServicesConfig(config.dataDir);
    } catch (error) {
      loaded = { services: [], configError: `Не удалось создать services.json: ${(error as Error).message}` };
    }
    if (loaded.configError && loaded.configError !== lastReportedError)
      options.onConfigError?.(loaded.configError);
    lastReportedError = loaded.configError;
  }

  async function runChecks(): Promise<void> {
    await load();
    const targets = loaded.services
      .filter((service) => service.enabled)
      .map(resolve)
      .filter((item): item is Resolved & { checkUrl: string } => item.checkUrl !== null);
    const checked = await Promise.all(
      targets.map(async (item) => {
        const result = await checkOne(item.checkUrl, {
          fetch: options.fetch,
          timeoutMs: config.serviceCheckTimeoutMs,
          clock,
        });
        return [item.definition.id, result] as const;
      }),
    );
    processes = await readSupervisorApps(config.dataDir);
    const ids = new Set(loaded.services.map((service) => service.id));
    for (const id of results.keys()) if (!ids.has(id)) results.delete(id);
    for (const [id, result] of checked) results.set(id, result);
  }

  function checkAll(): Promise<void> {
    if (config.demo) return Promise.resolve();
    running ??= runChecks().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    init: load,
    checkAll,
    statuses() {
      if (config.demo) return demoStatuses(clock);
      return loaded.services.map((definition) =>
        toStatus(
          resolve(definition),
          results.get(definition.id),
          definition.process ? processes.get(definition.process) : undefined,
        ),
      );
    },
    configError: () => (config.demo ? null : loaded.configError),
    start() {
      if (timer || config.demo) return;
      void checkAll();
      timer = setInterval(() => void checkAll(), config.serviceCheckIntervalSec * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
