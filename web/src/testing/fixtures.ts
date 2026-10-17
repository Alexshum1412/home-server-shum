/**
 * Test data and providers for rendering pages without a server. Test-only.
 */
import { type ComponentChildren, h } from 'preact';
import { vi } from 'vitest';
import type {
  Permission,
  Role,
  ServiceStatus,
  ServicesResponse,
  SessionResponse,
  SystemResponse,
} from '../../../shared/api.ts';
import type { ApiFailure } from '../api.ts';
import type { PollingResult } from '../hooks/usePolling.ts';
import { DataContext, type DataContextValue, SessionProvider } from '../state.tsx';

export const NOW_ISO = '2026-10-16T10:00:00.000Z';

export function service(overrides: Partial<ServiceStatus> & Pick<ServiceStatus, 'kind'>): ServiceStatus {
  return {
    id: overrides.kind,
    name: `Сервис ${overrides.kind}`,
    description: 'Описание',
    openUrl: null,
    state: 'not_configured',
    checkedAt: null,
    latencyMs: null,
    message: 'Сервис ещё не подключён',
    hint: null,
    detail: null,
    demo: false,
    ...overrides,
  };
}

export function servicesResponse(services: ServiceStatus[]): ServicesResponse {
  return { services, generatedAt: NOW_ISO, configError: null };
}

export function systemResponse(overrides: Partial<SystemResponse> = {}): SystemResponse {
  return {
    generatedAt: NOW_ISO,
    demo: false,
    server: {
      version: '0.1.0',
      startedAt: NOW_ISO,
      hostname: null,
      osRelease: null,
      uptimeSeconds: { value: 3600, collectedAt: NOW_ISO, source: 'os.uptime()', reason: null },
    },
    cpu: {
      model: 'Процессор',
      cores: 4,
      usagePercent: { value: 12, collectedAt: NOW_ISO, source: 'os.cpus()', reason: null },
    },
    memory: {
      totalBytes: 8 * 1024 ** 3,
      usedBytes: { value: 4 * 1024 ** 3, collectedAt: NOW_ISO, source: 'os.freemem()', reason: null },
    },
    temperatureC: {
      value: null,
      collectedAt: null,
      source: 'нет поддерживаемого источника',
      reason: 'Датчик температуры недоступен на этом компьютере',
    },
    volumes: [
      {
        path: 'C:\\',
        totalBytes: 500 * 1024 ** 3,
        freeBytes: 200 * 1024 ** 3,
        collectedAt: NOW_ISO,
        reason: null,
        lowSpace: false,
      },
    ],
    physicalDisks: {
      value: null,
      collectedAt: null,
      source: 'Get-PhysicalDisk',
      reason: 'Подробности доступны администратору',
    },
    tailscale: {
      state: 'running',
      dnsName: null,
      peersOnline: null,
      version: null,
      collectedAt: NOW_ISO,
      reason: null,
    },
    printer: { name: null, state: 'not_configured', message: 'Принтер не выбран', collectedAt: null },
    backup: {
      state: 'not_configured',
      lastSuccessAt: null,
      restoreTested: false,
      message: 'Резервные копии не настроены',
    },
    programs: {
      value: [{ name: 'dashboard', title: 'Портал', state: 'running', restarts: 0, startedAt: NOW_ISO }],
      collectedAt: NOW_ISO,
      source: 'test',
      reason: null,
    },
    overall: { level: 'ok', text: 'Всё работает' },
    alerts: [],
    ...overrides,
  };
}

export function polling<T>(data: T | null, overrides: Partial<PollingResult<T>> = {}): PollingResult<T> {
  return {
    data,
    error: null,
    loading: false,
    receivedAt: data === null ? null : Date.parse(NOW_ISO),
    refresh: vi.fn(),
    replace: vi.fn(),
    ...overrides,
  };
}

export function failure(unreachable = true): ApiFailure {
  // A plain object is enough: components read only these fields.
  return {
    name: 'ApiFailure',
    kind: unreachable ? 'network' : 'http',
    status: unreachable ? undefined : 500,
    code: undefined,
    message: unreachable ? 'Нет связи с домашним сервером' : 'Ошибка на домашнем сервере (код 500).',
    unreachable,
  } as ApiFailure;
}

export interface ProvidersOptions {
  role?: Role;
  permissions?: Permission[];
  demo?: boolean;
  services?: PollingResult<ServicesResponse>;
  system?: PollingResult<SystemResponse>;
  refreshAll?: () => void;
}

/** Wraps `children` in a signed-in session and fixed (not polled) data. */
export function withProviders(children: ComponentChildren, options: ProvidersOptions = {}) {
  const role = options.role ?? 'family';
  const session: SessionResponse = {
    user: {
      id: role,
      username: role,
      displayName: role === 'admin' ? 'Админ' : 'Мама',
      role,
      permissions: role === 'admin' ? ['downloads', 'print'] : (options.permissions ?? []),
    },
    demo: options.demo ?? false,
    mustChangePassword: false,
  };
  const data: DataContextValue = {
    services: options.services ?? polling(servicesResponse([])),
    system: options.system ?? polling(systemResponse()),
    refreshAll: options.refreshAll ?? vi.fn(),
  };
  return h(SessionProvider, {
    value: { session, logout: async () => {} },
    children: h(DataContext.Provider, { value: data }, children),
  });
}
