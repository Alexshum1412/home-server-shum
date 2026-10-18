import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { isAbsoluteTargetPath, parseTargetSpec, splitList } from './backup/spec.ts';
import { isPrivateLanAddress } from './lan.ts';
import { REPO_ROOT } from './lib/version.ts';
import { isLoopbackHttpUrl } from './olivia/llm.ts';

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
  /**
   * Extra addresses of the home network the portal listens on besides HOST (LAN_BIND). Empty by
   * default: the portal is then reachable only from this PC and through Tailscale.
   */
  readonly lanBind: readonly string[];
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
  /** BACKUP_GIT_PUSH "<remote>/<branch>": mirror the committed code there on every backup; null — off. */
  readonly backupGitPush: { readonly remote: string; readonly branch: string } | null;
  /** Root of the family files (personal folders, shared folder, downloads), see files/. */
  readonly filesDir: string;
  /** Root of the family photo library. */
  readonly photosDir: string;
  /** Media library (films, series, music, audiobooks), read by Jellyfin and by the fallback player. */
  readonly mediaDir: string;
  /** Jellyfin on this PC, read by the cinema page (loopback only). */
  readonly jellyfinUrl: string;
  /** The torrent client (aria2) on this PC: its RPC address (loopback only), its folder and sharing limits. */
  readonly torrent: {
    readonly rpcUrl: string;
    readonly home: string;
    /** Stop sharing a finished torrent when this much has been sent compared with what was received. */
    readonly seedRatio: number;
    /** Upload limit, KB/s: the home connection must stay usable. */
    readonly uploadLimitKb: number;
  };
  /** Family chat: messages, attachments (part of the daily backup). */
  readonly chatDir: string;
  readonly chatMaxAttachmentBytes: number;
  /** Voice and video calls: help for devices in different networks (all empty → only direct connections). */
  readonly calls: {
    readonly stunUrls: readonly string[];
    readonly turnUrls: readonly string[];
    /** Shared secret of the TURN relay (coturn static-auth-secret); never sent to a browser. */
    readonly turnSecret: string | null;
    readonly turnTtlSec: number;
  };
  readonly downloadMaxFileBytes: number;
  /** One file uploaded through the portal (files and photos). */
  readonly uploadMaxFileBytes: number;
  /** Downloads and uploads stop when the volume would have less than this free. */
  readonly minFreeBytes: number;
  /** «Оливия» (rule-based assistant for the admin); OLIVIA_ENABLED=0 switches it off completely. */
  readonly oliviaEnabled: boolean;
  /** Optional local language model that re-words «Оливия»'s findings (ADR-0008); null — off. Loopback only. */
  readonly oliviaLlm: { readonly url: string; readonly model: string; readonly timeoutMs: number } | null;
  /** IPP address of the home printer for printing through the portal; null — not configured. */
  readonly printerIppUrl: string | null;
  readonly printMaxBytes: number;
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
  LAN_BIND: z.string(),
  COOKIE_SECURE: z.enum(['auto', 'always', 'never']),
  BACKUP_TARGETS: z.string(),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365),
  BACKUP_REPO_DIR: z.string().min(1),
  BACKUP_EXTRA_FILES: z.string(),
  GIT_EXE: z.string().min(1),
  BACKUP_GIT_PUSH: z.string(),
  FAMILY_FILES_DIR: z.string().min(1),
  FAMILY_PHOTOS_DIR: z.string().min(1),
  MEDIA_DIR: z.string().min(1),
  JELLYFIN_URL: z.string(),
  TORRENT_RPC_URL: z.string(),
  TORRENT_HOME: z.string().min(1),
  TORRENT_SEED_RATIO: z.coerce.number().min(0).max(20),
  TORRENT_UPLOAD_LIMIT_KB: z.coerce.number().int().min(10).max(100_000),
  CHAT_DIR: z.string().min(1),
  CHAT_MAX_FILE_MB: z.coerce.number().min(1).max(10_000),
  CALLS_STUN_URLS: z.string(),
  CALLS_TURN_URLS: z.string(),
  CALLS_TURN_SECRET: z.string().max(200),
  CALLS_TURN_TTL_SEC: z.coerce.number().int().min(60).max(86_400),
  DOWNLOAD_MAX_FILE_GB: z.coerce.number().min(0.001).max(1000),
  UPLOAD_MAX_FILE_GB: z.coerce.number().min(0.001).max(1000),
  MIN_FREE_GB: z.coerce.number().min(0).max(10_000),
  OLIVIA_ENABLED: z.enum(['0', '1', 'true', 'false']),
  OLIVIA_LLM_URL: z.string(),
  OLIVIA_LLM_MODEL: z.string().min(1).max(100),
  OLIVIA_LLM_TIMEOUT_SEC: z.coerce.number().min(5).max(600),
  PRINTER_IPP_URL: httpUrlOrEmpty('PRINTER_IPP_URL'),
  PRINT_MAX_MB: z.coerce.number().min(1).max(500),
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

function defaultFamilyDir(
  env: Env,
  platform: NodeJS.Platform,
  name: 'Files' | 'Photos' | 'Media' | 'Chat',
): string {
  if (platform === 'win32') return `${systemDrive(env)}\\FamilyData\\${name}`;
  return path.join(os.homedir(), '.family-data', name.toLowerCase());
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
    LAN_BIND: env.LAN_BIND?.trim() ?? '',
    COOKIE_SECURE: pick('COOKIE_SECURE', 'auto').toLowerCase(),
    BACKUP_TARGETS: pick('BACKUP_TARGETS', defaultBackupTargets(env, platform)),
    BACKUP_KEEP: pick('BACKUP_KEEP', '14'),
    BACKUP_REPO_DIR: pick('BACKUP_REPO_DIR', REPO_ROOT),
    BACKUP_EXTRA_FILES: env.BACKUP_EXTRA_FILES?.trim() ?? '',
    GIT_EXE: pick('GIT_EXE', 'git'),
    BACKUP_GIT_PUSH: env.BACKUP_GIT_PUSH?.trim() ?? '',
    FAMILY_FILES_DIR: pick('FAMILY_FILES_DIR', defaultFamilyDir(env, platform, 'Files')),
    FAMILY_PHOTOS_DIR: pick('FAMILY_PHOTOS_DIR', defaultFamilyDir(env, platform, 'Photos')),
    MEDIA_DIR: pick('MEDIA_DIR', defaultFamilyDir(env, platform, 'Media')),
    JELLYFIN_URL: pick('JELLYFIN_URL', 'http://127.0.0.1:8096'),
    TORRENT_RPC_URL: pick('TORRENT_RPC_URL', 'http://127.0.0.1:6800/jsonrpc'),
    TORRENT_HOME: pick(
      'TORRENT_HOME',
      platform === 'win32'
        ? `${systemDrive(env)}\\FamilyServer\\apps\\aria2`
        : path.join(os.homedir(), '.family-data', 'aria2'),
    ),
    TORRENT_SEED_RATIO: pick('TORRENT_SEED_RATIO', '1'),
    TORRENT_UPLOAD_LIMIT_KB: pick('TORRENT_UPLOAD_LIMIT_KB', '500'),
    CHAT_DIR: pick('CHAT_DIR', defaultFamilyDir(env, platform, 'Chat')),
    CHAT_MAX_FILE_MB: pick('CHAT_MAX_FILE_MB', '200'),
    CALLS_STUN_URLS: env.CALLS_STUN_URLS?.trim() ?? '',
    CALLS_TURN_URLS: env.CALLS_TURN_URLS?.trim() ?? '',
    CALLS_TURN_SECRET: env.CALLS_TURN_SECRET?.trim() ?? '',
    CALLS_TURN_TTL_SEC: pick('CALLS_TURN_TTL_SEC', '3600'),
    DOWNLOAD_MAX_FILE_GB: pick('DOWNLOAD_MAX_FILE_GB', '50'),
    UPLOAD_MAX_FILE_GB: pick('UPLOAD_MAX_FILE_GB', '20'),
    MIN_FREE_GB: pick('MIN_FREE_GB', '50'),
    OLIVIA_ENABLED: pick('OLIVIA_ENABLED', '1').toLowerCase(),
    OLIVIA_LLM_URL: env.OLIVIA_LLM_URL?.trim() ?? '',
    OLIVIA_LLM_MODEL: pick('OLIVIA_LLM_MODEL', 'local'),
    OLIVIA_LLM_TIMEOUT_SEC: pick('OLIVIA_LLM_TIMEOUT_SEC', '90'),
    PRINTER_IPP_URL: env.PRINTER_IPP_URL?.trim() ?? '',
    PRINT_MAX_MB: pick('PRINT_MAX_MB', '30'),
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
  const backupGitPush = parseGitPush(v.BACKUP_GIT_PUSH);
  const lanBind = parseLanBind(v.LAN_BIND);
  const oliviaLlmUrl = parseLoopbackUrl('OLIVIA_LLM_URL', v.OLIVIA_LLM_URL, 'http://127.0.0.1:8081/v1');
  const jellyfinUrl =
    parseLoopbackUrl('JELLYFIN_URL', v.JELLYFIN_URL, 'http://127.0.0.1:8096') ?? 'http://127.0.0.1:8096';
  // A bound home-network address implies its own URL, unless the owner gave another one (a name).
  const lanUrl = trimUrl(v.LAN_URL) ?? (lanBind[0] ? `http://${lanBind[0]}:${v.PORT}` : null);

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
    lanUrl,
    lanBind: Object.freeze(lanBind),
    cookieSecure: v.COOKIE_SECURE,
    backupTargets: Object.freeze(backupTargets),
    backupKeep: v.BACKUP_KEEP,
    backupRepoDir: path.resolve(v.BACKUP_REPO_DIR),
    backupExtraFiles: backupExtraFiles === null ? null : Object.freeze(backupExtraFiles),
    gitExe: v.GIT_EXE,
    backupGitPush: backupGitPush === null ? null : Object.freeze(backupGitPush),
    filesDir: path.resolve(v.FAMILY_FILES_DIR),
    photosDir: path.resolve(v.FAMILY_PHOTOS_DIR),
    mediaDir: path.resolve(v.MEDIA_DIR),
    jellyfinUrl,
    torrent: Object.freeze({
      rpcUrl:
        parseLoopbackUrl('TORRENT_RPC_URL', v.TORRENT_RPC_URL, 'http://127.0.0.1:6800/jsonrpc') ??
        'http://127.0.0.1:6800/jsonrpc',
      home: path.resolve(v.TORRENT_HOME),
      seedRatio: v.TORRENT_SEED_RATIO,
      uploadLimitKb: v.TORRENT_UPLOAD_LIMIT_KB,
    }),
    chatDir: path.resolve(v.CHAT_DIR),
    chatMaxAttachmentBytes: Math.round(v.CHAT_MAX_FILE_MB * 1024 ** 2),
    calls: Object.freeze({
      stunUrls: Object.freeze(parseIceUrls('CALLS_STUN_URLS', v.CALLS_STUN_URLS, ['stun', 'stuns'])),
      turnUrls: Object.freeze(parseIceUrls('CALLS_TURN_URLS', v.CALLS_TURN_URLS, ['turn', 'turns'])),
      turnSecret: v.CALLS_TURN_SECRET === '' ? null : v.CALLS_TURN_SECRET,
      turnTtlSec: v.CALLS_TURN_TTL_SEC,
    }),
    downloadMaxFileBytes: Math.round(v.DOWNLOAD_MAX_FILE_GB * 1024 ** 3),
    uploadMaxFileBytes: Math.round(v.UPLOAD_MAX_FILE_GB * 1024 ** 3),
    minFreeBytes: Math.round(v.MIN_FREE_GB * 1024 ** 3),
    oliviaEnabled: v.OLIVIA_ENABLED === '1' || v.OLIVIA_ENABLED === 'true',
    oliviaLlm:
      oliviaLlmUrl === null
        ? null
        : Object.freeze({
            url: oliviaLlmUrl,
            model: v.OLIVIA_LLM_MODEL,
            timeoutMs: Math.round(v.OLIVIA_LLM_TIMEOUT_SEC * 1000),
          }),
    printerIppUrl: v.PRINTER_IPP_URL === '' ? null : v.PRINTER_IPP_URL,
    printMaxBytes: Math.round(v.PRINT_MAX_MB * 1024 ** 2),
  });
}

/** CALLS_STUN_URLS / CALLS_TURN_URLS: addresses like stun:host:3478 separated by «,» or «;»; "" or "none" — none. */
function parseIceUrls(name: string, value: string, schemes: readonly string[]): string[] {
  if (value === '' || value.toLowerCase() === 'none') return [];
  const urls = value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  for (const url of urls) {
    const match = /^([a-z]+):([A-Za-z0-9.[\]:-]+)(\?transport=(?:udp|tcp))?$/.exec(url);
    if (!match || !schemes.includes(match[1] ?? '')) {
      throw new Error(`${CONFIG_ERROR}: ${name}: «${url}» — нужен адрес вида ${schemes[0]}:сервер:3478`);
    }
  }
  return urls;
}

/** OLIVIA_LLM_URL: an http address on this PC (the model is never reached over the network); "" or "none" — off. */
function parseLoopbackUrl(name: string, value: string, example: string): string | null {
  if (value === '' || value.toLowerCase() === 'none') return null;
  if (!isLoopbackHttpUrl(value)) {
    throw new Error(
      `${CONFIG_ERROR}: ${name}: нужен адрес на этом же компьютере вида ${example} (не подмена имени и не адрес в сети)`,
    );
  }
  return value.replace(/\/+$/, '');
}

/** LAN_BIND: private IPv4 addresses of the home network separated by «,» or «;»; never a public address or 0.0.0.0. */
function parseLanBind(value: string): string[] {
  if (value === '' || value.toLowerCase() === 'none') return [];
  const addresses = value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  for (const address of addresses) {
    if (!isPrivateLanAddress(address)) {
      throw new Error(
        `${CONFIG_ERROR}: LAN_BIND: «${address}» — нужен адрес домашней сети (192.168.x.x, 10.x.x.x или 172.16–31.x.x); «0.0.0.0» и публичные адреса не допускаются`,
      );
    }
  }
  return [...new Set(addresses)];
}

/** "origin/main" → {remote, branch}; "" or "none" → null. Plain git names only (no options, no spaces). */
function parseGitPush(value: string): { remote: string; branch: string } | null {
  if (value === '' || value.toLowerCase() === 'none') return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(value);
  if (!match || value.includes('..') || value.endsWith('/') || value.endsWith('.lock')) {
    throw new Error(
      `${CONFIG_ERROR}: BACKUP_GIT_PUSH: ожидается «удалённый-репозиторий/ветка», например origin/main, или none`,
    );
  }
  return { remote: match[1] as string, branch: match[2] as string };
}
