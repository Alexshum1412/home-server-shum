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
  /** Through the public (open-internet) address the portal offers ordinary features only. */
  channel: 'private' | 'public';
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
  /** Address on the open internet (a protected tunnel), null when none is set up. */
  publicHttpsUrl: string | null;
  /** Which way this very request came in: the private one (Tailscale, home network) or the public one. */
  channel: 'private' | 'public';
  /** Optional fallback address inside the home LAN (plain HTTP), null when LAN access is off. */
  lanUrl: string | null;
  /** Address that works on the server itself. */
  localUrl: string;
  /** Admin only: why the home-network address is switched on but not listening; null otherwise. */
  lanProblem: string | null;
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

/** One summary level for the whole server: работает / предупреждение / ошибка / неизвестно. */
export type HealthLevel = 'ok' | 'warning' | 'error' | 'unknown';

export type ProgramState =
  | 'running'
  | 'starting'
  | 'backoff'
  | 'stopping'
  | 'stopped'
  | 'external'
  | 'unknown';

/** A program run by the supervisor (the portal itself, Jellyfin). */
export interface ProgramStatus {
  /** "dashboard", "jellyfin" */
  name: string;
  /** Russian name, e.g. "Кинотеатр (Jellyfin)". */
  title: string;
  state: ProgramState;
  /** Restarts after crashes or hangs since the supervisor started. */
  restarts: number;
  startedAt: string | null;
}

/** The video card, as the NVIDIA driver reports it (nvidia-smi). */
export interface GpuInfo {
  name: string;
  loadPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  temperatureC: number | null;
  powerWatts: number | null;
  fanPercent: number | null;
  driver: string | null;
}

/** One network connection that is up; the speed is measured between two readings. */
export interface NetworkAdapterInfo {
  name: string;
  description: string;
  /** A real network card (cable, Wi-Fi), not a tunnel or a virtual adapter. */
  physical: boolean;
  linkSpeedMbps: number | null;
  /** Bytes per second since the previous reading; null for the first reading. */
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  rxTotalBytes: number | null;
  txTotalBytes: number | null;
}

/** What the drive itself reports about its health (SMART-like counters that Windows exposes). */
export interface DiskReliabilityInfo {
  model: string;
  temperatureC: number | null;
  /** Wear of an SSD, 0–100 %; null for a hard disk. */
  wearPercent: number | null;
  readErrors: number | null;
  writeErrors: number | null;
  powerOnHours: number | null;
  /** Russian note when a counter looks bad. */
  note: string | null;
}

/** GET /api/system → hardware (administrator only). Every part is a measurement or an honest «Недоступно». */
export interface HardwareInfo {
  /** Load of every processor core, 0..100. */
  cpuCores: Measured<number[]>;
  cpuClock: Measured<{ currentMhz: number; maxMhz: number }>;
  /** The processor's own temperature: only from a sensor program (LibreHardwareMonitor), never guessed. */
  cpuTemperatureC: Measured<number>;
  /** Temperature of the motherboard zone (ACPI); NOT the processor's temperature. */
  boardTemperatureC: Measured<number>;
  gpu: Measured<GpuInfo[]>;
  network: Measured<NetworkAdapterInfo[]>;
  diskReliability: Measured<DiskReliabilityInfo[]>;
}

/** One reading of the history (every minute, kept for a day). null = not measured at that moment. */
export interface MetricsPoint {
  /** Seconds since 1970. */
  t: number;
  cpu: number | null;
  memory: number | null;
  gpu: number | null;
  cpuTemp: number | null;
  gpuTemp: number | null;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
}

/** GET /api/system/history (administrator only). */
export interface MetricsHistoryResponse {
  intervalSec: number;
  points: MetricsPoint[];
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
  /** Details of the processor, video card, network and drives; null for everybody but the administrator. */
  hardware: HardwareInfo | null;
  volumes: VolumeInfo[];
  physicalDisks: Measured<PhysicalDiskInfo[]>;
  tailscale: TailscaleInfo;
  printer: PrinterInfo;
  backup: BackupInfo;
  /** Programs under the supervisor; null with a reason when the supervisor is not running. */
  programs: Measured<ProgramStatus[]>;
  /** Summary of everything above for this user's view. */
  overall: { level: HealthLevel; text: string };
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
      /** Switched off by an administrator: cannot sign in, every session is closed. */
      disabled: boolean;
      /** Open sessions (devices) of the person. */
      sessions: number;
    }
  >;
}

/** One sign-in (a device) of the signed-in person. */
export interface SessionInfo {
  /** Opaque id to revoke it with. */
  id: string;
  /** «Chrome · Windows», «Safari · iPhone». */
  label: string;
  createdAt: string;
  lastSeenAt: string;
  /** The one that made this request. */
  current: boolean;
}

/** GET /api/sessions */
export interface SessionsResponse {
  sessions: SessionInfo[];
}

/** POST /api/sessions/revoke — one device by id, or every other device. */
export type RevokeSessionRequest = { id: string } | { others: true };

/**
 * POST /api/admin/users (admin only) — creates an account. The password is always generated: the
 * admin never types or sees a password of someone else, only the temporary one handed out once.
 * Errors: 400 bad_request / bad_username, 409 exists.
 */
export interface CreateUserRequest {
  username: string;
  displayName: string;
  role: Role;
  /** Extra rights for a family member (admins have all of them). */
  permissions?: Permission[];
}

/**
 * Answer of "create user" and "reset password": the temporary password is shown ONCE (it is stored
 * only as a hash). It works for the first sign-in until `expiresAt`; the person then chooses their own.
 */
export interface TemporaryPasswordResponse {
  username: string;
  displayName: string;
  temporaryPassword: string;
  expiresAt: string;
}

/**
 * POST /api/admin/users/:username/access (admin only) — changes the role and/or the extra rights.
 * Errors: 400 bad_request / self, 404 not_found, 409 last_admin.
 */
export interface UpdateAccessRequest {
  role?: Role;
  permissions?: Permission[];
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

/** A direct link (the portal's own queue) or a torrent (through the torrent client on this PC). */
export type DownloadKind = 'link' | 'torrent';

/** Where a finished download is put. */
export type DownloadDestination = 'personal' | 'movies' | 'series' | 'cartoons' | 'music';

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
  kind: DownloadKind;
  /** Torrents only: sending out, peers and the time left (null when it cannot be told honestly). */
  torrent: {
    seeding: boolean;
    uploadedBytes: number;
    uploadSpeedBps: number | null;
    seeders: number | null;
    connections: number | null;
    etaSec: number | null;
    /** Ratio sent / received; the client stops sharing at TORRENT_SEED_RATIO. */
    ratio: number | null;
    fileCount: number;
  } | null;
  /** Where the files go, in words («Файлы → Личное → Загрузки», «Общая медиатека → Фильмы»). */
  destinationLabel: string;
  /** The finished files are in the shared media library (Jellyfin was asked to look for them). */
  inLibrary: boolean;
}

/** GET /api/downloads — own tasks (admins: everyone's). */
export interface DownloadsResponse {
  /** False when the user has no `downloads` permission (the list is then empty). */
  allowed: boolean;
  tasks: DownloadTaskView[];
  limits: { maxFileBytes: number; minFreeBytes: number; freeBytes: number | null };
  /** Where the files of this user land, in words: «Файлы → Личное → Загрузки». */
  folderLabel: string;
  torrentEngine: TorrentEngineView;
}

/**
 * POST /api/downloads/check {url} — looks at the link without downloading it. The answer is shown
 * to the user for confirmation; POST /api/downloads {checkId} then starts the download.
 * Errors: 400 bad_url, 403 private_address / forbidden, 413 too_large, 422 blocked_type /
 * not_a_file, 502 remote_error.
 */
export interface DownloadCheckResponse {
  checkId: string;
  kind: DownloadKind;
  /** A magnet link needs a moment to learn what it contains: poll GET /api/downloads/check/:id. */
  status: 'ready' | 'pending' | 'failed';
  /** Russian reason when `status` is failed. */
  error: string | null;
  url: string;
  host: string;
  fileName: string;
  sizeBytes: number | null;
  contentType: string | null;
  /** The site supports pause/resume. */
  resumable: boolean;
  /** Torrent: what is inside, and what will not be downloaded (programs and scripts). */
  files: Array<{ path: string; sizeBytes: number; skipped: boolean }>;
  /** Torrent: the number of files and the size that will really be downloaded. */
  willDownload: { files: number; sizeBytes: number } | null;
  /** The places the person may choose for the result. */
  destinations: Array<{ id: DownloadDestination; label: string }>;
}

/** The state of the torrent client on this PC, in plain words. */
export interface TorrentEngineView {
  state: 'ok' | 'down' | 'not_installed';
  message: string;
  /** What to do, Russian; null when everything is fine. */
  hint: string | null;
}

// ---------------------------------------------------------------------------
// Family files and photos (P4)
// ---------------------------------------------------------------------------

/** `files` — documents and any files; `photos` — the photo and video library. */
export type StorageRoot = 'files' | 'photos';
/** `personal` — only the signed-in user (nobody else, not even an admin); `shared` — the family. */
export type StorageSpace = 'personal' | 'shared';

export interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  sizeBytes: number | null;
  modifiedAt: string;
  /** Content type the server will send (application/octet-stream when not shown inline). */
  mime: string | null;
  /** Photos: a thumbnail exists. */
  hasThumb: boolean;
}

/** GET /api/storage/:root/list?space=&path= */
export interface FileListResponse {
  root: StorageRoot;
  space: StorageSpace;
  /** Relative path inside the space ('' = top), forward slashes. */
  path: string;
  entries: FileEntry[];
  freeBytes: number | null;
  maxUploadBytes: number;
}

/** PUT /api/storage/:root/upload?space=&path=&name=&size= (raw body, header X-Upload: 1). */
export interface UploadResponse {
  name: string;
  sizeBytes: number;
  /** For photos: what the content turned out to be. */
  media: 'image' | 'video' | null;
}

// ---------------------------------------------------------------------------
// Media library fallback (P2): the portal itself plays the library files when Jellyfin is down
// ---------------------------------------------------------------------------

export type MediaKind = 'video' | 'audio';

export interface MediaEntry {
  name: string;
  type: 'dir' | 'file';
  /** Files only: what the browser will play. */
  kind: MediaKind | null;
  sizeBytes: number | null;
  modifiedAt: string;
}

/** GET /api/media/list?path= — the folder of the media library (read-only; every signed-in user). */
export interface MediaListResponse {
  /** False when the library folder is missing; `reason` says so. */
  available: boolean;
  reason: string | null;
  /** Relative path, forward slashes ('' = top). */
  path: string;
  entries: MediaEntry[];
}

// ---------------------------------------------------------------------------
// «Оливия» (P6): rule-based assistant for the admin; works without any AI model
// ---------------------------------------------------------------------------

/** Actions «Оливия» may suggest. The list is fixed in code; nothing else can be run. */
export type OliviaActionId = 'restart-jellyfin' | 'start-jellyfin' | 'run-backup' | 'recheck-services';

export interface OliviaFinding {
  id: string;
  level: HealthLevel;
  title: string;
  /** What is going on, in plain words. */
  explanation: string;
  /** What the admin can do. */
  suggestion: string;
  /** A safe action the admin may run with one click (after confirming), or null. */
  action: OliviaActionId | null;
}

export interface OliviaActionView {
  id: OliviaActionId;
  title: string;
  /** Shown in the confirmation dialog. */
  confirmText: string;
  /** False when the action does not apply right now; `reason` says why. */
  allowed: boolean;
  reason: string | null;
}

/** GET /api/admin/olivia (admin only; 404 when OLIVIA_ENABLED=0). */
export interface OliviaResponse {
  generatedAt: string;
  findings: OliviaFinding[];
  actions: OliviaActionView[];
  /** A local language model is connected (OLIVIA_LLM_URL): findings can be re-worded on request. */
  llm: { configured: boolean };
}

/**
 * POST /api/admin/olivia/explain {id} — a local model re-words ONE finding. The answer is plain text
 * made by a machine, shown with that label; it changes nothing and never triggers an action.
 * Errors: 404 not_configured / not_found, 429 too_many_requests, 502 llm_failed.
 */
export interface OliviaExplainResponse {
  findingId: string;
  text: string;
}

/** POST /api/admin/olivia/actions/:id with {confirm: true}. */
export interface OliviaActionResult {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Printing (P7): PDF/JPEG sent over IPP to the home printer
// ---------------------------------------------------------------------------

export type PrintSides = 'one-sided' | 'two-sided-long-edge' | 'two-sided-short-edge';
export type PrintColorMode = 'auto' | 'monochrome' | 'color';
/**
 * checked   — the printer validated the job (Validate-Job); waits for the user's «Напечатать»
 * held      — the printer did not answer; the document is kept and the user may queue it
 * queued    — the user chose «напечатать, когда принтер включат»: sent by itself, within a day
 * sent/printing — accepted by the printer / being printed
 * completed / canceled / failed — final; expired — not confirmed in time
 */
export type PrintJobState =
  | 'checked'
  | 'held'
  | 'queued'
  | 'sent'
  | 'printing'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'expired';

export interface PrintJobView {
  id: string;
  owner: string;
  fileName: string;
  sizeBytes: number;
  format: 'pdf' | 'jpeg';
  copies: number;
  sides: PrintSides;
  colorMode: PrintColorMode;
  state: PrintJobState;
  /** Russian status text from the printer or the portal. */
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrinterIppStatus {
  /** PRINTER_IPP_URL is set. */
  configured: boolean;
  reachable: boolean | null;
  state: 'idle' | 'processing' | 'stopped' | null;
  acceptingJobs: boolean | null;
  /** printer-state-reasons other than "none", e.g. "media-empty". */
  reasons: string[];
  /** Toner levels exactly as the printer reports them; null when it does not report a level. */
  markers: Array<{ name: string; color: string | null; levelPercent: number | null }>;
  checkedAt: string | null;
  message: string;
}

/** GET /api/print */
export interface PrintResponse {
  /** The user has the `print` right. */
  allowed: boolean;
  printer: PrinterIppStatus;
  jobs: PrintJobView[];
  maxBytes: number;
}

// ---------------------------------------------------------------------------
// Family planner (P10): calendar and notes built into the portal
// ---------------------------------------------------------------------------

export type CalendarRepeat = 'none' | 'weekly' | 'monthly' | 'yearly';

/** What a person fills in. Dates are «YYYY-MM-DD», times «HH:MM» in the family's wall-clock time (no zones). */
export interface CalendarEventInput {
  title: string;
  date: string;
  /** Last day of a multi-day event (repeat «none» only); null — one day. */
  endDate: string | null;
  /** null — all day. */
  time: string | null;
  /** End time on the same day; needs `time`. */
  endTime: string | null;
  repeat: CalendarRepeat;
  note: string;
  /** Only the author sees a private event; everybody else sees the family ones. */
  private: boolean;
}

export interface CalendarEventView extends CalendarEventInput {
  id: string;
  owner: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
  /** The author and administrators may change or delete it. */
  canEdit: boolean;
}

/** One appearance of an event on a particular day. */
export interface CalendarOccurrence {
  day: string;
  event: CalendarEventView;
}

/** GET /api/calendar?from=&to= (at most 120 days). */
export interface CalendarResponse {
  from: string;
  to: string;
  occurrences: CalendarOccurrence[];
  /** The period has more appearances than one answer carries: show a narrower period. */
  truncated: boolean;
}

/** Notes are plain text files in the folder «Заметки» of «Личное» or «Общее» (so they are also in «Файлы» and in backups). */
export interface NoteSummary {
  /** Title = file name without «.txt». */
  name: string;
  modifiedAt: string;
  sizeBytes: number;
  /** First line(s) of the text. */
  preview: string;
}

/** GET /api/notes?space= */
export interface NotesResponse {
  space: StorageSpace;
  notes: NoteSummary[];
}

/** GET /api/notes/read?space=&name= */
export interface NoteResponse {
  space: StorageSpace;
  name: string;
  text: string;
  /** Opaque value to send back when saving: a save is refused if the note changed meanwhile. */
  revision: string;
  modifiedAt: string;
}

/** POST /api/notes/save. `revision` null — a new note. Errors: 409 exists / conflict, 413 too_large, 400 bad_name. */
export interface SaveNoteRequest {
  space: StorageSpace;
  name: string;
  text: string;
  revision: string | null;
}
export interface SaveNoteResponse {
  name: string;
  revision: string;
  modifiedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Family chat, calls and notifications
// ---------------------------------------------------------------------------------------------

export interface ChatPerson {
  id: string;
  displayName: string;
}

export type ChatAttachmentKind = 'image' | 'video' | 'audio' | 'file';

export interface ChatAttachment {
  name: string;
  sizeBytes: number;
  mime: string;
  kind: ChatAttachmentKind;
}

/** Text made by the server for events in a chat (joins, calls); never typed by a person. */
export type ChatSystemKind =
  | 'created'
  | 'member-added'
  | 'member-left'
  | 'member-removed'
  | 'call'
  /** A call nobody answered: the only call line that counts as unread. */
  | 'call-missed';

export interface ChatMessage {
  id: string;
  conversationId: string;
  /** Position in the conversation, 1, 2, 3 … */
  seq: number;
  at: string;
  /** null — a system message. */
  senderId: string | null;
  senderName: string;
  /** Empty for a deleted message. */
  text: string;
  attachment: ChatAttachment | null;
  deleted: boolean;
  system: ChatSystemKind | null;
  /** The sender's own id for this message (only the sender gets it back); lets the page match its draft. */
  clientId: string | null;
}

/** family — one room for everybody; direct — two people; group — chosen people. */
export type ChatKind = 'family' | 'direct' | 'group';

export interface ChatConversation {
  id: string;
  kind: ChatKind;
  /** Name of the group, or the other person for a direct chat. */
  title: string;
  members: ChatPerson[];
  ownerId: string | null;
  unread: number;
  updatedAt: string;
  last: { at: string; preview: string; senderName: string } | null;
  /** Position up to which each member has read (for «прочитано»). */
  reads: Record<string, number>;
  canManage: boolean;
}

/** GET /api/chat/conversations */
export interface ChatListResponse {
  me: ChatPerson;
  conversations: ChatConversation[];
  /** Everybody the person can start a chat with. */
  people: ChatPerson[];
  maxAttachmentBytes: number;
}

/** GET /api/chat/conversations/:id/messages?before=&limit= — oldest first. */
export interface ChatMessagesResponse {
  messages: ChatMessage[];
  /** True when older messages exist. */
  more: boolean;
}

export interface CallIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** GET /api/calls/config */
export interface CallConfigResponse {
  iceServers: CallIceServer[];
  maxParticipants: number;
  /** What the server could arrange for a call between different networks; shown to the person as a hint. */
  relay: 'none' | 'stun' | 'turn';
}

export type CallState = 'ringing' | 'active' | 'ended';
export type CallEndReason = 'hangup' | 'declined' | 'missed' | 'cancelled' | 'busy' | 'failed';

export interface CallInfo {
  id: string;
  conversationId: string;
  video: boolean;
  initiator: ChatPerson;
  /** Everybody who was asked to join, with whether they joined. */
  participants: Array<ChatPerson & { joined: boolean; declined: boolean }>;
  state: CallState;
  endReason: CallEndReason | null;
  startedAt: string;
}

export type SignalType = 'offer' | 'answer' | 'candidate';

/** POST /api/calls/:id/signal */
export interface SignalRequest {
  to: string;
  type: SignalType;
  data: unknown;
}

export type NotificationKind =
  | 'message'
  | 'call'
  | 'download'
  | 'backup'
  | 'disk'
  | 'service'
  | 'print'
  | 'system';

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Page of the portal to open. */
  url: string;
  at: string;
  read: boolean;
}

/** What a person wants to be told about (this applies to every device of the person). */
export interface NotificationPrefs {
  messages: boolean;
  calls: boolean;
  downloads: boolean;
  alerts: boolean;
  print: boolean;
  /** Show the text of a message in the notification (otherwise only «Новое сообщение»). */
  previews: boolean;
}

/** GET /api/notifications */
export interface NotificationsResponse {
  notifications: NotificationView[];
  unread: number;
  prefs: NotificationPrefs;
  push: {
    /** False: the server could not make its push keys; the phone then gets notifications only while the portal is open. */
    available: boolean;
    publicKey: string | null;
    /** Devices of this person that are subscribed. */
    devices: number;
  };
}

/** POST /api/notifications/subscribe — the PushSubscription of this browser. */
export interface PushSubscriptionRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Short label of the device (browser and system), shown in the settings. */
  label?: string;
}

/** Server-sent events on GET /api/events. */
export type RealtimeEvent =
  | { type: 'hello'; at: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'conversation'; conversationId: string }
  | { type: 'read'; conversationId: string; userId: string; seq: number }
  | { type: 'call'; call: CallInfo }
  | { type: 'signal'; callId: string; from: string; signal: SignalType; data: unknown }
  | { type: 'notification'; notification: NotificationView };

// ---------------------------------------------------------------------------------------------
// Media catalogue (Jellyfin, read through the portal)
// ---------------------------------------------------------------------------------------------

export type CatalogKind =
  | 'movie'
  | 'series'
  | 'season'
  | 'episode'
  | 'track'
  | 'album'
  /** A whole audiobook (a folder of chapters). */
  | 'book'
  /** One chapter of an audiobook. */
  | 'audiobook'
  | 'video'
  | 'other';

export interface CatalogItem {
  /** Jellyfin item id (32 hex characters). */
  id: string;
  title: string;
  kind: CatalogKind;
  year: number | null;
  genres: string[];
  runtimeMin: number | null;
  /** Community rating 0–10, when known. */
  rating: number | null;
  hasPoster: boolean;
  /** Series name, for a season or an episode. */
  seriesTitle: string | null;
  season: number | null;
  episode: number | null;
  /** Where the person stopped, from this portal's own record (never from another person). */
  resumeSec: number | null;
  durationSec: number | null;
}

export interface CatalogLibrary {
  id: string;
  name: string;
  kind: 'movies' | 'tvshows' | 'music' | 'books' | 'homevideos' | 'other';
}

/** GET /api/catalog — the start page of the cinema. */
export interface CatalogHomeResponse {
  /** False with `reason` when Jellyfin does not answer; the page then offers the fallback player. */
  available: boolean;
  reason: string | null;
  libraries: CatalogLibrary[];
  continueWatching: CatalogItem[];
  latest: CatalogItem[];
  genres: string[];
  /** Address of Jellyfin's own web page for the family (tailnet), or null. */
  jellyfinUrl: string | null;
}

/** GET /api/catalog/items?library=&q=&genre=&sort=&start= */
export interface CatalogItemsResponse {
  items: CatalogItem[];
  total: number;
  start: number;
}

export type CatalogPlayback =
  /** The browser can play the file as it is (portal serves it). */
  | 'direct'
  /** Probably plays in Chrome/Edge, not everywhere (e.g. Matroska). */
  | 'maybe'
  /** Needs Jellyfin (transcoding): offer the Jellyfin link. */
  | 'jellyfin';

/** GET /api/catalog/items/:id */
export interface CatalogDetailResponse {
  item: CatalogItem;
  overview: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  playback: CatalogPlayback;
  /** Why the browser cannot play it directly (Russian), when `playback` is not `direct`. */
  playbackNote: string | null;
  /** Audio or video: which element to use. */
  media: 'video' | 'audio' | null;
  /** Seasons of a series, episodes of a season, tracks of an album. */
  children: CatalogItem[];
  jellyfinUrl: string | null;
}

/** POST /api/catalog/progress */
export interface CatalogProgressRequest {
  id: string;
  positionSec: number;
  durationSec: number;
}

// ---------------------------------------------------------------------------------------------
// «Оливия» for the whole family: a helper that finds, shows and explains — never acts alone
// ---------------------------------------------------------------------------------------------

/** POST /api/olivia/ask */
export interface OliviaAskRequest {
  message: string;
}

export type OliviaCard =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'media'; item: CatalogItem; href: string }
  | { kind: 'file'; name: string; where: string; sizeBytes: number | null; href: string; isFolder: boolean }
  | { kind: 'task'; task: DownloadTaskView }
  /** A download she prepared; it starts only when the person presses the button. */
  | { kind: 'download-check'; check: DownloadCheckResponse }
  | { kind: 'event'; when: string; title: string };

export interface OliviaAnswer {
  reply: string;
  /** Who understood the question: the local language model, or the built-in rules. */
  via: 'model' | 'rules';
  /** What she did to answer (for the person's trust and for tests), e.g. «search_media». */
  tool: string;
  cards: OliviaCard[];
  /** Why the model was not used, when it is set up but did not help. */
  note: string | null;
}

/** GET /api/olivia/status — can she be asked, and with what. */
export interface OliviaStatusResponse {
  enabled: boolean;
  model: { configured: boolean; reachable: boolean; name: string | null; message: string };
}
