/** Contract of the administrator's «Сервер» page: GET /api/admin/server and friends. */
import type { BackupInfo, ProgramState, VolumeInfo } from './api.ts';

/** The programs the supervisor runs; the only names the page may ask to start, stop or restart. */
export type ProgramId = 'dashboard' | 'jellyfin' | 'aria2' | 'llama';

export const PROGRAM_IDS: readonly ProgramId[] = ['dashboard', 'jellyfin', 'aria2', 'llama'];

export interface ProgramView {
  id: ProgramId;
  title: string;
  state: ProgramState;
  /** What the person reads: «Работает», «Остановлена», «Сбой, ждёт перезапуска»… */
  stateText: string;
  startedAt: string | null;
  /** Restarts after crashes or hangs since the supervisor started. */
  restarts: number;
}

export interface ErrorLines {
  source: 'portal-errors' | 'portal-warnings' | 'supervisor';
  label: string;
  /** The last lines, with secrets, names, addresses and family paths already removed. */
  lines: string[];
  /** Why the lines are not there (no file yet, unreadable). */
  note: string | null;
}

export interface DownloadCounts {
  total: number;
  active: number;
  queued: number;
  paused: number;
  failed: number;
  completed: number;
}

export interface ModelView {
  configured: boolean;
  reachable: boolean;
  message: string;
}

export interface ServerPageResponse {
  generatedAt: string;
  /** The supervisor is the only way to start and stop programs from the page. */
  supervisor: { running: boolean; startedAt: string | null; message: string };
  programs: ProgramView[];
  /** The portal itself: when it started and whether the previous run ended cleanly (null = first start). */
  portal: {
    startedAt: string | null;
    previousRun: 'clean' | 'crashed' | 'unknown';
    previousRunAt: string | null;
  };
  errors: ErrorLines[];
  disks: VolumeInfo[];
  backup: BackupInfo;
  backupRunning: boolean;
  model: ModelView;
  downloads: DownloadCounts | null;
}

export type ServerAction = 'start' | 'stop' | 'restart' | 'backup' | 'recheck';

export interface ServerActionRequest {
  action: ServerAction;
  program?: ProgramId;
  /** Required for stop and restart; for the portal itself also `portalConfirmed`. */
  confirm?: boolean;
  portalConfirmed?: boolean;
}

export interface ServerActionResponse {
  ok: boolean;
  message: string;
}

export interface ServerReportResponse {
  generatedAt: string;
  /** The text to copy: nothing in it identifies a person, a device or a secret. */
  text: string;
  /** What was taken out, by kind and number. */
  removed: Array<{ what: string; count: number }>;
}
