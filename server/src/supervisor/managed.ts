/**
 * One supervised child process: start, restart with back-off after a crash or a hang, graceful
 * stop. Commands and arguments come only from code (supervisor/apps.ts), never from a request.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, promises as fsp, openSync } from 'node:fs';
import path from 'node:path';

export type AppState = 'starting' | 'running' | 'backoff' | 'stopping' | 'stopped' | 'external';

export interface AppSpec {
  /** Stable id used by the control commands, e.g. "dashboard". */
  name: string;
  /** Russian name for logs and the status output. */
  title: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** The child understands the IPC message {type: 'shutdown'} (the dashboard server does). */
  ipc?: boolean;
  /** Polled while running; also tells whether another instance already serves the port. */
  healthUrl?: string;
  /** How long a fresh start may take before failed health checks count. */
  startupGraceMs?: number;
  /** Asks the app to exit on its own (e.g. through its API) before it is killed. */
  gracefulStop?: () => Promise<void>;
  stopTimeoutMs?: number;
  stdoutLog: string;
  stderrLog: string;
}

export interface AppStatus {
  name: string;
  title: string;
  state: AppState;
  pid: number | null;
  startedAt: string | null;
  /** Restarts after crashes or hangs since the supervisor started. */
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  message: string;
}

export interface ManagedOptions {
  log: (message: string) => void;
  onChange: () => void;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => number;
  healthIntervalMs?: number;
  /** Consecutive failed health checks of a running child that count as a hang. */
  healthFailuresToRestart?: number;
  externalRecheckMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** A child that ran this long is considered stable: the back-off starts from the beginning. */
  stableAfterMs?: number;
}

export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/** Keeps at most one previous log (<file>.1) once the file grew past `limit`. */
export async function rotateLog(file: string, limit = LOG_ROTATE_BYTES): Promise<void> {
  try {
    const stat = await fsp.stat(file);
    if (stat.size < limit) return;
    await fsp.rm(`${file}.1`, { force: true });
    await fsp.rename(file, `${file}.1`);
  } catch {
    // missing file or a locked one: keep appending
  }
}

export class ManagedApp {
  readonly spec: AppSpec;
  private readonly opts: Required<Omit<ManagedOptions, 'fetch'>> & { fetch: typeof fetch };
  private child: ChildProcess | null = null;
  private status: AppStatus;
  private wanted = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthFailures = 0;
  private startedAtMs = 0;
  private exitWaiters: Array<() => void> = [];

  constructor(spec: AppSpec, options: ManagedOptions) {
    this.spec = spec;
    this.opts = {
      fetch: options.fetch ?? fetch,
      now: options.now ?? Date.now,
      healthIntervalMs: options.healthIntervalMs ?? 30_000,
      healthFailuresToRestart: options.healthFailuresToRestart ?? 3,
      externalRecheckMs: options.externalRecheckMs ?? 30_000,
      backoffBaseMs: options.backoffBaseMs ?? 1000,
      backoffMaxMs: options.backoffMaxMs ?? 60_000,
      stableAfterMs: options.stableAfterMs ?? 120_000,
      log: options.log,
      onChange: options.onChange,
    };
    this.status = {
      name: spec.name,
      title: spec.title,
      state: 'stopped',
      pid: null,
      startedAt: null,
      restarts: 0,
      lastExit: null,
      message: 'Не запущен',
    };
  }

  snapshot(): AppStatus {
    return { ...this.status, lastExit: this.status.lastExit ? { ...this.status.lastExit } : null };
  }

  private set(patch: Partial<AppStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onChange();
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.timer = null;
    this.healthTimer = null;
  }

  private async healthy(timeoutMs = 3000): Promise<boolean> {
    if (!this.spec.healthUrl) return false;
    try {
      const res = await this.opts.fetch(this.spec.healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Starts the app (no-op when it already runs). */
  async start(): Promise<void> {
    this.wanted = true;
    if (this.child || this.status.state === 'starting') return;
    this.clearTimers();
    // Someone else (e.g. a server started by hand) already answers on the port: do not fight it.
    if (await this.healthy()) {
      this.set({ state: 'external', pid: null, message: 'Уже работает отдельно от супервизора' });
      this.opts.log(
        `${this.spec.title}: уже запущен вне супервизора, проверяю каждые ${this.opts.externalRecheckMs / 1000} с`,
      );
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.wanted) void this.start();
      }, this.opts.externalRecheckMs);
      return;
    }
    if (!this.wanted) return;
    await this.spawnChild();
  }

  private async spawnChild(): Promise<void> {
    const { spec } = this;
    this.set({ state: 'starting', message: 'Запускается' });
    await fsp.mkdir(path.dirname(spec.stdoutLog), { recursive: true });
    await rotateLog(spec.stdoutLog);
    await rotateLog(spec.stderrLog);
    const out = openSync(spec.stdoutLog, 'a');
    const err = openSync(spec.stderrLog, 'a');
    let child: ChildProcess;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        stdio: spec.ipc ? ['ignore', out, err, 'ipc'] : ['ignore', out, err],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      closeSync(out);
      closeSync(err);
      this.onExit(null, null, `не удалось запустить: ${(error as Error).message}`);
      return;
    }
    // The child has its own copies of the handles.
    closeSync(out);
    closeSync(err);
    this.child = child;
    this.startedAtMs = this.opts.now();
    this.healthFailures = 0;
    child.once('error', (error) => {
      if (this.child === child) {
        this.child = null;
        this.onExit(null, null, `не удалось запустить: ${error.message}`);
      }
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.onExit(code, signal, null);
    });
    if (child.pid === undefined) return; // 'error' follows
    this.set({
      state: 'running',
      pid: child.pid,
      startedAt: new Date(this.startedAtMs).toISOString(),
      message: 'Работает',
    });
    this.opts.log(`${spec.title}: запущен (PID ${child.pid})`);
    if (spec.healthUrl) {
      this.healthTimer = setInterval(() => void this.checkHealth(child), this.opts.healthIntervalMs);
      this.healthTimer.unref?.();
    }
  }

  private async checkHealth(child: ChildProcess): Promise<void> {
    if (this.child !== child || this.status.state !== 'running') return;
    if (this.opts.now() - this.startedAtMs < (this.spec.startupGraceMs ?? 60_000)) return;
    if (await this.healthy()) {
      this.healthFailures = 0;
      return;
    }
    this.healthFailures += 1;
    if (this.healthFailures < this.opts.healthFailuresToRestart) return;
    this.opts.log(`${this.spec.title}: не отвечает ${this.healthFailures} проверки подряд — перезапуск`);
    this.healthFailures = 0;
    child.kill();
  }

  private onExit(code: number | null, signal: string | null, problem: string | null): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    const at = new Date(this.opts.now()).toISOString();
    this.status.lastExit = { code, signal, at };
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const resolve of waiters) resolve();
    if (!this.wanted) {
      this.set({ state: 'stopped', pid: null, message: 'Остановлен' });
      this.opts.log(`${this.spec.title}: остановлен (код ${code ?? '—'})`);
      return;
    }
    const ranMs = this.startedAtMs ? this.opts.now() - this.startedAtMs : 0;
    if (ranMs >= this.opts.stableAfterMs) this.failures = 0;
    this.failures += 1;
    const delay = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** (this.failures - 1));
    // Windows exit codes are unsigned 32-bit; -1 (killed) reads better than 4294967295.
    const shown = code !== null && code > 0x7fffffff ? code - 0x1_0000_0000 : code;
    const why = problem ?? `завершился с кодом ${shown ?? '—'}${signal ? ` (${signal})` : ''}`;
    this.status.restarts += 1;
    this.set({
      state: 'backoff',
      pid: null,
      message: `Сбой: ${why}; перезапуск через ${Math.round(delay / 1000)} с`,
    });
    this.opts.log(`${this.spec.title}: ${why}; перезапуск через ${Math.round(delay / 1000)} с`);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.wanted) void this.start();
    }, delay);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.child) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Stops the app: graceful request first (IPC or the app's own API), then a hard kill. */
  async stop(): Promise<void> {
    this.wanted = false;
    this.clearTimers();
    const child = this.child;
    if (!child) {
      if (this.status.state !== 'stopped') this.set({ state: 'stopped', pid: null, message: 'Остановлен' });
      return;
    }
    this.set({ state: 'stopping', message: 'Останавливается' });
    const timeout = this.spec.stopTimeoutMs ?? 15_000;
    try {
      if (this.spec.ipc && child.connected) child.send({ type: 'shutdown' });
      else if (this.spec.gracefulStop) await this.spec.gracefulStop();
    } catch (error) {
      this.opts.log(`${this.spec.title}: мягкая остановка не удалась (${(error as Error).message})`);
    }
    if (await this.waitForExit(timeout)) return;
    this.opts.log(`${this.spec.title}: не завершился за ${Math.round(timeout / 1000)} с — принудительно`);
    child.kill();
    await this.waitForExit(5000);
  }

  async restart(): Promise<void> {
    await this.stop();
    this.failures = 0;
    await this.start();
  }
}
