import { describe, expect, it } from 'vitest';
import type {
  AlertLevel,
  BackupState,
  DiskHealth,
  PrinterState,
  ServiceState,
  TailscaleState,
} from '../../../shared/api.ts';
import { STATUS_ICONS } from '../components/icons.ts';
import {
  ALERT_LEVEL,
  adminDetail,
  auditActionLabel,
  BACKUP_STATE,
  DISK_HEALTH,
  openableUrl,
  PRINTER_STATE,
  SERVICE_STATE,
  type StatusView,
  sortAlerts,
  TAILSCALE_STATE,
} from './labels.ts';

/**
 * Lists every member of a union. `Record<T, true>` makes the compiler reject the
 * list when a state is added to shared/api.ts and forgotten here.
 */
function members<T extends string>(all: Record<T, true>): T[] {
  return Object.keys(all) as T[];
}

const SERVICE_STATES = members<ServiceState>({
  online: true,
  degraded: true,
  offline: true,
  not_configured: true,
  disabled: true,
  unknown: true,
});
const PRINTER_STATES = members<PrinterState>({
  ready: true,
  printing: true,
  offline: true,
  error: true,
  unknown: true,
  not_found: true,
  not_configured: true,
});
const BACKUP_STATES = members<BackupState>({
  not_configured: true,
  ok: true,
  failed: true,
  stale: true,
  unknown: true,
});
const TAILSCALE_STATES = members<TailscaleState>({
  running: true,
  stopped: true,
  needs_login: true,
  not_installed: true,
  unknown: true,
});
const DISK_HEALTHS = members<DiskHealth>({ healthy: true, warning: true, unhealthy: true, unknown: true });
const ALERT_LEVELS = members<AlertLevel>({ info: true, warning: true, critical: true });

const TABLES: Array<[string, readonly string[], Record<string, StatusView>]> = [
  ['ServiceState', SERVICE_STATES, SERVICE_STATE],
  ['PrinterState', PRINTER_STATES, PRINTER_STATE],
  ['BackupState', BACKUP_STATES, BACKUP_STATE],
  ['TailscaleState', TAILSCALE_STATES, TAILSCALE_STATE],
  ['DiskHealth', DISK_HEALTHS, DISK_HEALTH],
  ['AlertLevel', ALERT_LEVELS, ALERT_LEVEL],
];

/** Starts with a capital Cyrillic letter; Latin only inside product names. */
const RUSSIAN_LABEL = /^[А-ЯЁ][А-Яа-яЁё ,.-]*(Tailscale)?$/u;

describe('status labels', () => {
  for (const [name, states, table] of TABLES) {
    it(`every ${name} has a Russian word and an icon`, () => {
      for (const state of states) {
        const view = table[state];
        expect(view, `${name}.${state}`).toBeDefined();
        expect(view?.label.trim(), `${name}.${state} label`).not.toBe('');
        expect(view?.label, `${name}.${state} label`).toMatch(RUSSIAN_LABEL);
        expect(STATUS_ICONS[view?.icon ?? 'unknown'], `${name}.${state} icon`).toBeTypeOf('function');
        expect(view?.icon, `${name}.${state} icon key`).toBeTruthy();
      }
    });
  }

  it('uses the agreed words for the main service states', () => {
    expect(SERVICE_STATE.online.label).toBe('Работает');
    expect(SERVICE_STATE.degraded).toEqual({ label: 'Отвечает с ошибкой', tone: 'warn', icon: 'warn' });
    expect(SERVICE_STATE.offline.label).toBe('Не отвечает');
    expect(SERVICE_STATE.not_configured.label).toBe('Не настроено');
    expect(SERVICE_STATE.unknown.label).toBe('Нет данных');
  });

  it('never presents a service as available unless it is online', () => {
    for (const state of SERVICE_STATES) {
      if (state === 'online') continue;
      expect(SERVICE_STATE[state].label, state).not.toMatch(/работает/i);
      expect(SERVICE_STATE[state].tone, state).not.toBe('ok');
    }
  });

  it('never tells working and broken apart by colour alone', () => {
    expect(SERVICE_STATE.online.icon).not.toBe(SERVICE_STATE.offline.icon);
    expect(SERVICE_STATE.online.label).not.toBe(SERVICE_STATE.offline.label);
    expect(SERVICE_STATE.not_configured.icon).not.toBe(SERVICE_STATE.offline.icon);
  });
});

describe('sortAlerts', () => {
  it('puts critical first and keeps the order inside a level', () => {
    const alerts = [
      { id: 'a', level: 'info' as const },
      { id: 'b', level: 'warning' as const },
      { id: 'c', level: 'critical' as const },
      { id: 'd', level: 'warning' as const },
    ];
    expect(sortAlerts(alerts).map((alert) => alert.id)).toEqual(['c', 'b', 'd', 'a']);
  });
});

describe('openableUrl', () => {
  it('opens only online services with an http(s) address', () => {
    expect(openableUrl({ state: 'online', openUrl: 'http://127.0.0.1:8096/' })).toBe(
      'http://127.0.0.1:8096/',
    );
    expect(openableUrl({ state: 'offline', openUrl: 'http://127.0.0.1:8096/' })).toBeNull();
    expect(openableUrl({ state: 'online', openUrl: null })).toBeNull();
    expect(openableUrl({ state: 'online', openUrl: 'javascript:alert(1)' })).toBeNull();
    expect(openableUrl({ state: 'online', openUrl: 'not a url' })).toBeNull();
    expect(openableUrl(undefined)).toBeNull();
  });
});

describe('adminDetail', () => {
  it('gives the technical detail to administrators only', () => {
    expect(adminDetail({ detail: 'HTTP 503' }, true)).toBe('HTTP 503');
    expect(adminDetail({ detail: 'HTTP 503' }, false)).toBeNull();
  });

  it('treats a missing or blank detail as none', () => {
    expect(adminDetail({ detail: null }, true)).toBeNull();
    expect(adminDetail({}, true)).toBeNull();
    expect(adminDetail({ detail: '  ' }, true)).toBeNull();
    expect(adminDetail(undefined, true)).toBeNull();
  });
});

describe('auditActionLabel', () => {
  it('translates known actions and keeps unknown codes as they are', () => {
    expect(auditActionLabel('login.success')).toBe('Вход');
    expect(auditActionLabel('logout')).toBe('Выход');
    expect(auditActionLabel('something.new')).toBe('something.new');
  });
});
