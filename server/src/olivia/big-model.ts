import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface BigModelOptions {
  /** llama-server.exe */
  exe: string;
  /** The bigger model file (about 2.5 GB, needs about 4 GB of memory while it runs), or null. */
  model: string | null;
  port: number;
  keyFile: string | undefined;
  threads: number;
  /** It is stopped when nobody used it for this long. */
  idleMs: number;
  fetch?: typeof fetch;
}

/**
 * The bigger local model, started when somebody needs it (a deeper conversation, the night digest) and stopped when it
 * has been idle for a while: it takes about 4 GB of memory and a lot of the processor, so it must not stay on for nothing.
 */
export function createBigModel(options: BigModelOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const url = `http://127.0.0.1:${options.port}/v1`;
  let child: ChildProcess | null = null;
  let starting: Promise<boolean> | null = null;
  let active = 0;
  let idleTimer: NodeJS.Timeout | undefined;

  const available = () => options.model !== null && existsSync(options.model) && existsSync(options.exe);

  async function healthy(): Promise<boolean> {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${options.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  function stop(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (child && !child.killed) child.kill();
    child = null;
    starting = null;
  }

  function armIdle(afterMs: number): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (active === 0) stop();
    }, afterMs);
    idleTimer.unref();
  }

  async function ensure(): Promise<boolean> {
    if (!available() || options.model === null) return false;
    if (child && (await healthy())) return true;
    if (starting) return starting;
    starting = (async () => {
      const args = [
        '-m',
        options.model as string,
        '--host',
        '127.0.0.1',
        '--port',
        String(options.port),
        '--alias',
        'local',
        '-c',
        '4096',
        '-t',
        String(options.threads),
        '-np',
        '1',
        '--no-webui',
      ];
      if (options.keyFile) args.push('--api-key-file', options.keyFile);
      child = spawn(options.exe, args, {
        cwd: path.dirname(options.exe),
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => undefined);
      child.on('exit', () => {
        child = null;
        starting = null;
      });
      try {
        if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // priority is a courtesy
      }
      const until = Date.now() + 240_000;
      while (Date.now() < until) {
        if (await healthy()) return true;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      stop();
      return false;
    })();
    return starting;
  }

  return {
    available,
    url,
    /** Runs `work` with the address of the model (null if it cannot be started); stops it after `idleMs` of rest. */
    async use<T>(work: (address: string | null) => Promise<T>, idleMs = options.idleMs): Promise<T> {
      active += 1;
      if (idleTimer) clearTimeout(idleTimer);
      try {
        return await work((await ensure()) ? url : null);
      } finally {
        active -= 1;
        if (active === 0) armIdle(idleMs);
      }
    },
    isRunning: () => child !== null,
    stop,
  };
}

export type BigModel = ReturnType<typeof createBigModel>;
