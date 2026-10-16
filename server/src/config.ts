import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type CookieSecureMode = 'auto' | 'always' | 'never';

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly demo: boolean;
  readonly logLevel: LogLevel;
  readonly serviceCheckIntervalSec: number;
  readonly serviceCheckTimeoutMs: number;
  readonly volumes: readonly string[];
  readonly lowSpacePercent: number;
  /** null → the Windows default printer. */
  readonly printerName: string | null;
  readonly tailscaleExe: string;
  readonly publicUrl: string | null;
  readonly lanUrl: string | null;
  readonly cookieSecure: CookieSecureMode;
}

export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_PUBLIC_URL = 'https://server-home.tail89d77e.ts.net';
export const DEFAULT_TAILSCALE_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';

function httpUrlOrEmpty(name: string) {
  return z.string().refine(
    (value) => {
      if (value === '') return true;
      try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
      } catch {
        return false;
      }
    },
    { message: `${name}: нужен адрес http:// или https://` },
  );
}

const schema = z.object({
  HOST: z.string().regex(/^[^\s/]+$/, 'HOST: укажите IP-адрес или имя без пробелов'),
  PORT: z.coerce.number().int().min(1).max(65535),
  DASHBOARD_DATA_DIR: z.string().min(1),
  DASHBOARD_DEMO: z.enum(['0', '1', 'true', 'false']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  SERVICE_CHECK_INTERVAL_SEC: z.coerce.number().int().min(10).max(86_400),
  SERVICE_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000),
  VOLUMES: z.string(),
  LOW_SPACE_PERCENT: z.coerce.number().min(0).max(100),
  PRINTER_NAME: z.string().max(256),
  TAILSCALE_EXE: z.string().min(1),
  PUBLIC_URL: httpUrlOrEmpty('PUBLIC_URL'),
  LAN_URL: httpUrlOrEmpty('LAN_URL'),
  COOKIE_SECURE: z.enum(['auto', 'always', 'never']),
});

function defaultDataDir(env: Env): string {
  const localAppData = env.LOCALAPPDATA?.trim();
  return localAppData
    ? path.join(localAppData, 'FamilyDashboard')
    : path.join(os.homedir(), '.family-dashboard');
}

function trimUrl(value: string): string | null {
  return value === '' ? null : value.replace(/\/+$/, '');
}

/**
 * Builds the typed, frozen configuration from environment variables (design D2).
 * Blank values fall back to defaults, except PUBLIC_URL / PRINTER_NAME / LAN_URL where blank means "none".
 * Throws an Error with a readable Russian message when a value is invalid.
 */
export function loadConfig(env: Env, platform: NodeJS.Platform = process.platform): Config {
  const pick = (name: string, fallback: string): string => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? fallback : value;
  };
  const raw = {
    HOST: pick('HOST', '127.0.0.1'),
    PORT: pick('PORT', '8070'),
    DASHBOARD_DATA_DIR: pick('DASHBOARD_DATA_DIR', defaultDataDir(env)),
    DASHBOARD_DEMO: pick('DASHBOARD_DEMO', '0').toLowerCase(),
    LOG_LEVEL: pick('LOG_LEVEL', 'info').toLowerCase(),
    SERVICE_CHECK_INTERVAL_SEC: pick('SERVICE_CHECK_INTERVAL_SEC', '60'),
    SERVICE_CHECK_TIMEOUT_MS: pick('SERVICE_CHECK_TIMEOUT_MS', '3000'),
    VOLUMES: pick('VOLUMES', platform === 'win32' ? 'C:\\' : '/'),
    LOW_SPACE_PERCENT: pick('LOW_SPACE_PERCENT', '10'),
    PRINTER_NAME: env.PRINTER_NAME?.trim() ?? '',
    TAILSCALE_EXE: pick('TAILSCALE_EXE', DEFAULT_TAILSCALE_EXE),
    PUBLIC_URL: env.PUBLIC_URL === undefined ? DEFAULT_PUBLIC_URL : env.PUBLIC_URL.trim(),
    LAN_URL: env.LAN_URL?.trim() ?? '',
    COOKIE_SECURE: pick('COOKIE_SECURE', 'auto').toLowerCase(),
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const key = String(issue.path[0] ?? '');
        return issue.message.startsWith(`${key}:`) ? issue.message : `${key}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`Некорректная конфигурация (переменные окружения): ${details}`);
  }
  const v = parsed.data;
  const volumes = v.VOLUMES.split(';')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (volumes.length === 0) {
    throw new Error('Некорректная конфигурация (переменные окружения): VOLUMES: укажите хотя бы один том');
  }

  return Object.freeze({
    host: v.HOST,
    port: v.PORT,
    dataDir: path.resolve(v.DASHBOARD_DATA_DIR),
    demo: v.DASHBOARD_DEMO === '1' || v.DASHBOARD_DEMO === 'true',
    logLevel: v.LOG_LEVEL,
    serviceCheckIntervalSec: v.SERVICE_CHECK_INTERVAL_SEC,
    serviceCheckTimeoutMs: v.SERVICE_CHECK_TIMEOUT_MS,
    volumes: Object.freeze(volumes),
    lowSpacePercent: v.LOW_SPACE_PERCENT,
    printerName: v.PRINTER_NAME === '' ? null : v.PRINTER_NAME,
    tailscaleExe: v.TAILSCALE_EXE,
    publicUrl: trimUrl(v.PUBLIC_URL),
    lanUrl: trimUrl(v.LAN_URL),
    cookieSecure: v.COOKIE_SECURE,
  });
}
