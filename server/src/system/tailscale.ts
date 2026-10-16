import { execFile } from 'node:child_process';
import type { TailscaleInfo, TailscaleState } from '../../../shared/api.ts';
import { formatSeconds } from '../lib/time.ts';
import { ProbeError, parseJsonOutput } from './powershell.ts';

export const TAILSCALE_TIMEOUT_MS = 5000;

function mapState(backendState: string): TailscaleState {
  switch (backendState) {
    case 'Running':
      return 'running';
    case 'Stopped':
      return 'stopped';
    case 'NeedsLogin':
    case 'NeedsMachineAuth':
      return 'needs_login';
    default:
      return 'unknown';
  }
}

const STATE_REASON: Record<TailscaleState, string | null> = {
  running: null,
  stopped: 'Tailscale на сервере остановлен',
  needs_login: 'Tailscale на сервере требует входа в учётную запись',
  not_installed: 'Tailscale не найден на этом компьютере',
  unknown: 'Tailscale сообщает неизвестное состояние',
};

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
  const state = mapState(typeof status.BackendState === 'string' ? status.BackendState : '');
  const self = status.Self as Record<string, unknown> | null | undefined;
  const dns = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
  const peers = status.Peer && typeof status.Peer === 'object' ? Object.values(status.Peer as object) : [];
  const peersOnline = peers.filter(
    (peer) => typeof peer === 'object' && peer !== null && (peer as { Online?: unknown }).Online === true,
  ).length;
  const version =
    typeof status.Version === 'string' && status.Version !== '' ? status.Version.split('-')[0] : null;
  return {
    state,
    dnsName: dns === '' ? null : dns,
    peersOnline,
    version: version ?? null,
    reason: STATE_REASON[state],
  };
}

/** Runs the Tailscale CLI with fixed arguments; ENOENT becomes `not_installed`. */
export function runTailscaleStatus(exe: string, timeoutMs = TAILSCALE_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      ['status', '--json'],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          if (error.code === 'ENOENT') {
            reject(new ProbeError('not_installed', STATE_REASON.not_installed ?? ''));
            return;
          }
          if (error.killed || error.signal) {
            reject(new ProbeError('timeout', `Tailscale не ответил за ${formatSeconds(timeoutMs)} с`));
            return;
          }
          // `tailscale status` exits non-zero in some states but still prints JSON.
          try {
            const parsed = parseJsonOutput(stdout);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              resolve(parsed);
              return;
            }
          } catch {
            // fall through
          }
          reject(new ProbeError('failed', 'Не удалось получить состояние Tailscale'));
          return;
        }
        try {
          resolve(parseJsonOutput(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
