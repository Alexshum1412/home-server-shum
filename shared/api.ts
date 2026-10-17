/**
 * Shared API contract between the backend (server/) and the frontend (web/).
 *
 * Rules that both sides rely on:
 * - Every measured value carries the time it was collected (`collectedAt`, ISO 8601 UTC).
 * - `null` always means "no data" and is never the same as `0`.
 * - Nothing here is ever invented: a value is either measured, or explicitly
 *   `null` with a human-readable reason, or marked `demo: true` (demo mode only).
 * - All human-readable text (`message`, `hint`, `reason`) is Russian and is
 *   rendered as plain text by the frontend (never as HTML).
 */

export type Role = 'family' | 'admin';

/**
 * Extra rights an admin grants to a family member (user.cmd allow <login> <right>).
 * Admins always have all of them.
 *   downloads — add files to the download queue (P3)
 *   print     — send documents to the home printer (P7)
 */
export type Permission = 'downloads' | 'print';
export const PERMISSIONS: readonly Permission[] = ['downloads', 'print'];

export interface SessionUser {
  id: string;
  /** Login name, lowercase latin, e.g. "mama". */
  username: string;
  /** Name shown in the greeting, e.g. "Мама". */
  displayName: string;
  role: Role;
  /** Effective rights (admins: all). */
  permissions: Permission[];
}

/** GET /api/health — public liveness probe, no auth, minimal info. */
export interface HealthResponse {
  status: 'ok';
  version: string;
  time: string;
}

/** GET /api/session — current session (401 if not signed in). */
export interface SessionResponse {
  user: SessionUser;
  /** True when the server runs in demo mode (fake data, clearly labelled). */
  demo: boolean;
  /**
   * True after signing in with a generated (temporary) password: every other API answers
   * 403 password_change_required until POST /api/password succeeds.
   */
  mustChangePassword: boolean;
}

/**
 * POST /api/password — the signed-in user changes their own password. On success all other
 * sessions of the user end, this device gets a fresh session and the body is a SessionResponse.
 * Errors: 400 bad_request / weak_password / wrong_password, 401 unauthorized, 429 too_many_attempts.
 */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** GET /api/setup-state — public: tells the login screen whether any user exists yet. */
export interface SetupStateResponse {
  /** Also true when users.json exists but cannot be read: a broken file is never a first run. */
  hasUsers: boolean;
  /** Command the owner must run on the server to create the first admin. */
  createAdminCommand: string;
}

/**
 * POST /api/login body. Errors: 401 invalid_credentials, 429 too_many_attempts,
 * 503 users_unavailable (users.json on the server cannot be read).
 */
export interface LoginRequest {
  username: string;
  password: string;
}

/**
 * Error body used by every non-2xx JSON response. Any request to an unknown host name
 * (DNS rebinding) gets 421 bad_host.
 */
export interface ApiError {
  error: string;
  /** Russian, safe to show to the user. */
  message: string;
}

// ---------------------------------------------------------------------------
// Services (Jellyfin, Immich, files, downloads, ...)
// ---------------------------------------------------------------------------

export type ServiceKind = 'media' | 'photos' | 'files' | 'downloads' | 'print' | 'calendar' | 'other';

/**
 * online         — health check succeeded (HTTP 2xx/3xx) within the timeout
 * degraded       — service answered but with an error status (HTTP 4xx/5xx)
 * offline        — connection refused / DNS error / timeout
 * not_configured — no URL configured yet (the service is not installed/set up)
 * disabled       — configured but switched off by the admin
 * unknown        — configured but not checked yet (e.g. right after start)
 */
export type ServiceState = 'online' | 'degraded' | 'offline' | 'not_configured' | 'disabled' | 'unknown';

export interface ServiceStatus {
  id: string;
  kind: ServiceKind;
  /** e.g. "Кинотеатр" */
  name: string;
  /** e.g. "Фильмы и сериалы (Jellyfin)" */
  description: string;
  /** URL the user opens in the browser; null when not configured. Only http(s). */
  openUrl: string | null;
  state: ServiceState;
  /** When the last check finished; null when never checked or not configured. */
  checkedAt: string | null;
  /** Round-trip time of the last successful check, ms; null otherwise. */
  latencyMs: number | null;
  /** Short Russian explanation of the state, e.g. "Сервис не отвечает 3 с". */
  message: string;
  /** What to do next (Russian), e.g. how to install/configure. Null when online. */
  hint: string | null;
  /**
   * Technical detail for admins only, e.g. "HTTP 503" or "ECONNREFUSED 127.0.0.1:8096".
   * Always null/absent for family users, whose `message` stays in plain words.
   */
  detail?: string | null;
  demo: boolean;
}

/** GET /api/services */
export interface ServicesResponse {
  services: ServiceStatus[];
  generatedAt: string;
  /** Admin only (null for family): why services.json could not be used, if it is invalid. */
  configError: string | null;
}

/** GET /api/connection — addresses shown on the «Подключение» help page. */
export interface ConnectionResponse {
  /** Main private HTTPS address inside the tailnet, e.g. "https://server-home.tail89d77e.ts.net". */
  tailnetUrl: string | null;
  /** Optional fallback address inside the home LAN (plain HTTP), null when LAN access is off. */
  lanUrl: string | null;
  /** Address that works on the server itself. */
  localUrl: string;
}

// ---------------------------------------------------------------------------
// System status
// ---------------------------------------------------------------------------

/** A measured value or an explicit "no data" with a reason. */
export interface Measured<T> {
  value: T | null;
  /** When the value was collected; null if never collected. */
  collectedAt: string | null;
  /** Where the value comes from, e.g. "Node.js os.cpus()" or "PowerShell Get-PhysicalDisk". */
  source: string;
  /** Russian reason when value is null, e.g. "Датчик температуры недоступен". */
  reason: string | null;
}

export interface CpuInfo {
  model: string;
  cores: number;
  /** Average utilisation over the last sampling window, 0..100. */
  usagePercent: Measured<number>;
}

export interface MemoryInfo {
  totalBytes: number;
  usedBytes: Measured<number>;
}

export interface VolumeInfo {
  /** e.g. "C:\\" */
  path: string;
  totalBytes: number | null;
  freeBytes: number | null;
  collectedAt: string | null;
  reason: string | null;
  /** Low-space flag computed by the server from a configurable threshold. */
  lowSpace: boolean;
}

export type DiskHealth = 'healthy' | 'warning' | 'unhealthy' | 'unknown';

export interface PhysicalDiskInfo {
  model: string;
  sizeBytes: number | null;
  mediaType: string;
  busType: string;
  health: DiskHealth;
  /** Raw HealthStatus / OperationalStatus strings from Windows. */
  rawHealth: string;
  rawOperational: string;
  /** Russian note, e.g. why a disk looks suspicious. */
  note: string | null;
}

export type TailscaleState = 'running' | 'stopped' | 'needs_login' | 'not_installed' | 'unknown';

export interface TailscaleInfo {
  state: TailscaleState;
  /** e.g. "server-home.tail89d77e.ts.net" (admin only, null for family). */
  dnsName: string | null;
  /** Number of other tailnet devices currently online (admin only, null for family). */
  peersOnline: number | null;
  version: string | null;
  collectedAt: string | null;
  reason: string | null;
}

export type PrinterState =
  | 'ready'
  | 'printing'
  | 'offline'
  | 'error'
  | 'unknown'
  | 'not_found'
  | 'not_configured';

export interface PrinterInfo {
  name: string | null;
  state: PrinterState;
  /** Russian explanation of the state as reported by Windows. */
  message: string;
  collectedAt: string | null;
}

export type BackupState = 'not_configured' | 'ok' | 'failed' | 'stale' | 'unknown';

export interface BackupInfo {
  state: BackupState;
  lastSuccessAt: string | null;
  /** Restore test performed and verified? Never true unless actually tested. */
  restoreTested: boolean;
  message: string;
}

export type AlertLevel = 'info' | 'warning' | 'critical';

/** A confirmed problem the family should know about. Generated only from real checks. */
export interface Alert {
  id: string;
  level: AlertLevel;
  title: string;
  /** Plain-language explanation and next step. */
  text: string;
}

/** GET /api/system — available to every signed-in user; some fields are admin-only. */
export interface SystemResponse {
  generatedAt: string;
  demo: boolean;
  server: {
    version: string;
    startedAt: string;
    hostname: string | null; // admin only
    osRelease: string | null; // admin only, e.g. "Windows 10 Home 22H2 (19045.6456)"
    uptimeSeconds: Measured<number>;
  };
  cpu: CpuInfo;
  memory: MemoryInfo;
  /** Temperature is not available on this machine; kept so the UI can say so honestly. */
  temperatureC: Measured<number>;
  volumes: VolumeInfo[];
  physicalDisks: Measured<PhysicalDiskInfo[]>;
  tailscale: TailscaleInfo;
  printer: PrinterInfo;
  backup: BackupInfo;
  alerts: Alert[];
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AuditEntry {
  time: string;
  /** e.g. "login.success", "login.failure", "logout", "services.refresh", "diagnostics.export" */
  action: string;
  /** Username or null for anonymous. */
  actor: string | null;
  /**
   * Client address. Through Tailscale Serve it is the device's tailnet IP (100.x.y.z), taken from
   * X-Forwarded-For, which is trusted only from the loopback proxy; 127.0.0.1 means the server itself.
   */
  ip: string | null;
  /** Short non-sensitive detail. Never contains passwords, tokens or file contents. */
  detail: string | null;
}

/** GET /api/admin/audit?limit=N (admin only) */
export interface AuditResponse {
  entries: AuditEntry[];
}

/** GET /api/admin/users (admin only) */
export interface UsersResponse {
  users: Array<
    SessionUser & {
      createdAt: string;
      lastLoginAt: string | null;
      /** Still has the generated first-sign-in password (expires at passwordExpiresAt). */
      temporaryPassword: boolean;
      passwordExpiresAt: string | null;
    }
  >;
}

/** GET /api/admin/diagnostics (admin only) — downloadable JSON, no secrets. */
export interface DiagnosticsResponse {
  generatedAt: string;
  app: { version: string; node: string; platform: string; demo: boolean };
  config: Record<string, string | number | boolean | null>;
  system: SystemResponse;
  services: ServiceStatus[];
}

/** POST /api/services/refresh (admin only) — re-run all checks now (rate limited). */
export type RefreshResponse = ServicesResponse;

// ---------------------------------------------------------------------------
// Downloads (P3): direct HTTP(S) links into the user's own «Загрузки» folder
// ---------------------------------------------------------------------------

export type DownloadState = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'canceled';

export interface DownloadTaskView {
  id: string;
  /** Login of the family member who added it. */
  owner: string;
  url: string;
  host: string;
  fileName: string;
  /** null when the site did not say how big the file is. */
  sizeBytes: number | null;
  receivedBytes: number;
  state: DownloadState;
  /** Russian reason when `state` is `failed`. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Bytes per second over the last second, while downloading. */
  speedBps: number | null;
}

/** GET /api/downloads — own tasks (admins: everyone's). */
export interface DownloadsResponse {
  /** False when the user has no `downloads` permission (the list is then empty). */
  allowed: boolean;
  tasks: DownloadTaskView[];
  limits: { maxFileBytes: number; minFreeBytes: number; freeBytes: number | null };
  /** Where the files of this user land, in words: «Файлы → Личное → Загрузки». */
  folderLabel: string;
}

/**
 * POST /api/downloads/check {url} — looks at the link without downloading it. The answer is shown
 * to the user for confirmation; POST /api/downloads {checkId} then starts the download.
 * Errors: 400 bad_url, 403 private_address / forbidden, 413 too_large, 422 blocked_type /
 * not_a_file, 502 remote_error.
 */
export interface DownloadCheckResponse {
  checkId: string;
  url: string;
  host: string;
  fileName: string;
  sizeBytes: number | null;
  contentType: string | null;
  /** The site supports pause/resume. */
  resumable: boolean;
}
