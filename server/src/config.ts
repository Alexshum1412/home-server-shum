import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { isAbsoluteTargetPath, parseTargetSpec, splitList } from './backup/spec.ts';
import { REPO_ROOT } from './lib/version.ts';

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
  /** Backup target specs (absolute paths or `label:<Label>\<subdir>`), see backup/spec.ts. */
  readonly backupTargets: readonly string[];
  /** Complete snapshots kept per target. */
  readonly backupKeep: number;
  /** Git repository bundled into every snapshot (the dashboard code). */
  readonly backupRepoDir: string;
  /** Extra files stored under config/; null → the project .env when it exists. */
  readonly backupExtraFiles: readonly string[] | null;
  readonly gitExe: string;
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
  BACKUP_TARGETS: z.string(),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365),
  BACKUP_REPO_DIR: z.string().min(1),
  BACKUP_EXTRA_FILES: z.string(),
  GIT_EXE: z.string().min(1),
});

/** "C:" — the drive Windows is installed on (the family server root lives there). */
function systemDrive(env: Env): string {
  const drive = env.SystemDrive?.trim() ?? env.SYSTEMDRIVE?.trim() ?? '';
  return /^[a-zA-Z]:$/.test(drive) ? drive.toUpperCase() : 'C:';
}

function defaultDataDir(env: Env, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `${systemDrive(env)}\\FamilyServer\\data\\dashboard`;
  const localAppData = env.LOCALAPPDATA?.trim();
  return localAppData
    ? path.join(localAppData, 'FamilyDashboard')
    : path.join(os.homedir(), '.family-dashboard');
}

function defaultBackupTargets(env: Env, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `${systemDrive(env)}\\FamilyServer\\backups;label:reserve\\FamilyServerBackups`;
  }
  return path.join(os.homedir(), '.family-dashboard-backups');
}

const CONFIG_ERROR = 'Некорректная конфигурация (переменные окружения)';

function parseBackupTargets(value: string): string[] {
  const specs = splitList(value);
  if (specs.length === 0)
    throw new Error(`${CONFIG_ERROR}: BACKUP_TARGETS: укажите хотя бы одно место для копий`);
  for (const item of specs) {
    const parsed = parseTargetSpec(item);
    if ('error' in parsed) throw new Error(`${CONFIG_ERROR}: BACKUP_TARGETS: ${parsed.error}`);
  }
  return specs;
}

/** Blank → null (the default: project .env when it exists); "none" → no extra files. */
function parseExtraFiles(value: string): string[] | null {
  if (value === '') return null;
  if (value.toLowerCase() === 'none') return [];
  const files = splitList(value);
  for (const file of files) {
    if (!isAbsoluteTargetPath(file)) {
      throw new Error(`${CONFIG_ERROR}: BACKUP_EXTRA_FILES: «${file}» — нужен полный путь к файлу`);
    }
  }
  return files.map((file) => path.resolve(file));
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
    DASHBOARD_DATA_DIR: pick('DASHBOARD_DATA_DIR', defaultDataDir(env, platform)),
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
    BACKUP_TARGETS: pick('BACKUP_TARGETS', defaultBackupTargets(env, platform)),
    BACKUP_KEEP: pick('BACKUP_KEEP', '14'),
    BACKUP_REPO_DIR: pick('BACKUP_REPO_DIR', REPO_ROOT),
    BACKUP_EXTRA_FILES: env.BACKUP_EXTRA_FILES?.trim() ?? '',
    GIT_EXE: pick('GIT_EXE', 'git'),
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const key = String(issue.path[0] ?? '');
        return issue.message.startsWith(`${key}:`) ? issue.message : `${key}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`${CONFIG_ERROR}: ${details}`);
  }
  const v = parsed.data;
  const volumes = splitList(v.VOLUMES);
  if (volumes.length === 0) {
    throw new Error(`${CONFIG_ERROR}: VOLUMES: укажите хотя бы один том`);
  }
  const backupTargets = parseBackupTargets(v.BACKUP_TARGETS);
  const backupExtraFiles = parseExtraFiles(v.BACKUP_EXTRA_FILES);

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
    backupTargets: Object.freeze(backupTargets),
    backupKeep: v.BACKUP_KEEP,
    backupRepoDir: path.resolve(v.BACKUP_REPO_DIR),
    backupExtraFiles: backupExtraFiles === null ? null : Object.freeze(backupExtraFiles),
    gitExe: v.GIT_EXE,
  });
}
