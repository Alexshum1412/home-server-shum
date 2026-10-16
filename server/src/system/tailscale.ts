import { type ExecFileException, execFile } from 'node:child_process';
import type { TailscaleInfo, TailscaleState } from '../../../shared/api.ts';
import { formatSeconds } from '../lib/time.ts';
import { ProbeError, parseJsonOutput } from './powershell.ts';

export const TAILSCALE_TIMEOUT_MS = 5000;

interface MappedState {
  state: TailscaleState;
  reason: string | null;
}

export const TAILSCALE_REASON = {
  stopped: 'Tailscale на сервере остановлен',
  /**
   * BackendState "NoState": the service runs but nobody has brought the connection up — typical
   * after a reboot when the Tailscale app has not been started and Unattended mode is off.
   */
  noState:
    'Tailscale на сервере не подключён к сети. Откройте приложение Tailscale на сервере (или включите режим Unattended).',
  starting: 'Tailscale подключается…',
  needsLogin: 'Tailscale на сервере требует входа в учётную запись',
  notInstalled: 'Tailscale не найден на этом компьютере',
  /** The CLI is installed but the background service (tailscaled) is not running. */
  serviceNotRunning: 'Служба Tailscale на сервере не запущена',
  unknown: 'Tailscale сообщает неизвестное состояние',
} as const;

/** What family members see instead of the technical reason while remote access is down. */
export const TAILSCALE_FAMILY_DOWN_REASON = 'Удалённый доступ сейчас не работает. Сообщите администратору.';

/** Maps ipn.State names reported by `tailscale status --json` (BackendState). */
function mapState(backendState: string): MappedState {
  switch (backendState) {
    case 'Running':
      return { state: 'running', reason: null };
    case 'Stopped':
      return { state: 'stopped', reason: TAILSCALE_REASON.stopped };
    case 'NoState':
      return { state: 'stopped', reason: TAILSCALE_REASON.noState };
    case 'Starting':
      // Transitional: not an outage yet, so no alert is raised for it.
      return { state: 'unknown', reason: TAILSCALE_REASON.starting };
    case 'NeedsLogin':
    case 'NeedsMachineAuth':
      return { state: 'needs_login', reason: TAILSCALE_REASON.needsLogin };
    default:
      return { state: 'unknown', reason: TAILSCALE_REASON.unknown };
  }
}

/** Normalises `tailscale status --json`. */
export function parseTailscaleStatus(raw: unknown): Omit<TailscaleInfo, 'collectedAt'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      state: 'unknown',
      dnsName: null,
      peersOnline: null,
      version: null,
      reason: 'Tailscale вернул ответ в неожиданном формате',
    };
  }
  const status = raw as Record<string, unknown>;
  const { state, reason } = mapState(typeof status.BackendState === 'string' ? status.BackendState : '');
  const self = status.Self as Record<string, unknown> | null | undefined;
  const dns = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
  const peers = status.Peer && typeof status.Peer === 'object' ? Object.values(status.Peer as object) : [];
  // Peer "Online" flags are only meaningful while connected; otherwise the count is unknown, not 0.
  const peersOnline =
    state === 'running'
      ? peers.filter(
          (peer) =>
            typeof peer === 'object' && peer !== null && (peer as { Online?: unknown }).Online === true,
        ).length
      : null;
  const version =
    typeof status.Version === 'string' && status.Version !== '' ? status.Version.split('-')[0] : null;
  return {
    state,
    dnsName: dns === '' ? null : dns,
    peersOnline,
    version: version ?? null,
    reason,
  };
}

/**
 * What the CLI prints to stderr when the background service (tailscaled) is not running:
 * "failed to connect to local Tailscale service" (Windows) / "... local tailscaled" (Linux, macOS).
 */
const SERVICE_NOT_RUNNING_RE = /failed to connect to local tail(scale|scaled)/i;

/**
 * Turns the outcome of `tailscale status --json` into parsed JSON or a ProbeError:
 * ENOENT → `not_installed`, killed → `timeout`, service down → `not_running`, else `failed`.
 */
export function interpretTailscaleResult(
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
  timeoutMs: number,
): unknown {
  if (!error) return parseJsonOutput(stdout);
  if (error.code === 'ENOENT') throw new ProbeError('not_installed', TAILSCALE_REASON.notInstalled);
  if (error.killed || error.signal) {
    throw new ProbeError('timeout', `Tailscale не ответил за ${formatSeconds(timeoutMs)} с`);
  }
  // `tailscale status` exits non-zero in some states but still prints JSON.
  try {
    const parsed = parseJsonOutput(stdout);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  if (SERVICE_NOT_RUNNING_RE.test(stderr) || SERVICE_NOT_RUNNING_RE.test(stdout)) {
    throw new ProbeError('not_running', TAILSCALE_REASON.serviceNotRunning);
  }
  throw new ProbeError('failed', 'Не удалось получить состояние Tailscale');
}

/** Runs the Tailscale CLI with fixed arguments (see `interpretTailscaleResult`). */
export function runTailscaleStatus(exe: string, timeoutMs = TAILSCALE_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      ['status', '--json'],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        try {
          resolve(interpretTailscaleResult(error, stdout, stderr, timeoutMs));
        } catch (failure) {
          reject(failure);
        }
      },
    );
  });
}
