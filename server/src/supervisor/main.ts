/**
 * Family server supervisor: keeps the portal (and Jellyfin, when installed) running.
 *
 *   node server/src/supervisor/main.ts            run (Task Scheduler «FamilyServer», scripts\start.cmd)
 *   node server/src/supervisor/main.ts status     JSON status of the running supervisor
 *   node server/src/supervisor/main.ts restart <app> | stop <app> | start <app> | shutdown
 *
 * One instance per data directory: the control pipe name is derived from it, a second instance
 * finds the pipe taken and exits. `shutdown` (scripts\stop.cmd) also leaves run/supervisor-stopped.json
 * so the scheduler's 5-minute watchdog does not bring everything back until the next boot or start.cmd.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, promises as fsp, mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { writeJsonAtomic } from '../lib/json-store.ts';
import { buildAppSpecs } from './apps.ts';
import { type AppStatus, ManagedApp, rotateLog } from './managed.ts';

export interface SupervisorState {
  pid: number;
  pipe: string;
  startedAt: string;
  updatedAt: string;
  apps: AppStatus[];
}

type Command = { cmd: 'status' } | { cmd: 'shutdown' } | { cmd: 'restart' | 'stop' | 'start'; app: string };

export function pipeNameFor(dataDir: string): string {
  const hash = createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\family-server-supervisor-${hash}`
    : path.join(os.tmpdir(), `family-server-supervisor-${hash}.sock`);
}

/** Boot time of this PC (ms since epoch); a stop request older than this is forgotten. */
export function bootTimeMs(now = Date.now()): number {
  return now - os.uptime() * 1000;
}

export function parseCommand(argv: readonly string[]): Command | null {
  const [cmd, app] = argv;
  if (cmd === 'status' || cmd === 'shutdown') return { cmd };
  if ((cmd === 'restart' || cmd === 'stop' || cmd === 'start') && app && /^[a-z]{2,20}$/.test(app)) {
    return { cmd, app };
  }
  return null;
}

/** Sends one command to the running supervisor; resolves with its JSON answer. */
export function sendCommand(pipe: string, command: Command, timeoutMs = 60_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Супервизор не ответил вовремя'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Непонятный ответ супервизора'));
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? new Error('Супервизор не запущен') : error);
    });
  });
}

interface RunOptions {
  dataDir: string;
  logDir: string;
  runDir: string;
  apps: ManagedApp[] | ((hooks: { log: (m: string) => void; onChange: () => void }) => ManagedApp[]);
  pipe?: string;
  /** Exit the process when done (false in tests). */
  exitProcess?: boolean;
}

export interface Supervisor {
  pipe: string;
  state(): SupervisorState;
  shutdown(reason: string): Promise<void>;
  done: Promise<void>;
}

export async function runSupervisor(options: RunOptions): Promise<Supervisor | null> {
  const { logDir, runDir } = options;
  mkdirSync(logDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const logFile = path.join(logDir, 'supervisor.log');
  await rotateLog(logFile, 2 * 1024 * 1024);
  const log = (message: string) => {
    const line = `${new Date().toISOString()} [${process.pid}] ${message}\n`;
    try {
      appendFileSync(logFile, line, 'utf8');
    } catch {
      // logging must never stop the supervisor
    }
  };

  const stopFile = path.join(runDir, 'supervisor-stopped.json');
  try {
    const stopped = JSON.parse(await fsp.readFile(stopFile, 'utf8')) as { at?: string };
    const at = Date.parse(stopped.at ?? '');
    if (!Number.isNaN(at) && at > bootTimeMs()) {
      // Stopped on purpose by the owner since this boot: the watchdog trigger must not undo that.
      return null;
    }
    await fsp.rm(stopFile, { force: true });
  } catch {
    // no stop request
  }

  const pipe = options.pipe ?? pipeNameFor(options.dataDir);
  const stateFile = path.join(runDir, 'supervisor.json');
  const startedAt = new Date().toISOString();
  let apps: ManagedApp[] = [];
  let writing: Promise<void> = Promise.resolve();
  let pending = false;
  const state = (): SupervisorState => ({
    pid: process.pid,
    pipe,
    startedAt,
    updatedAt: new Date().toISOString(),
    apps: apps.map((app) => app.snapshot()),
  });
  const onChange = () => {
    if (pending) return;
    pending = true;
    writing = writing.then(async () => {
      pending = false;
      await writeJsonAtomic(stateFile, state()).catch((error: unknown) => {
        log(`Не удалось записать ${stateFile}: ${(error as Error).message}`);
      });
    });
  };
  apps = typeof options.apps === 'function' ? options.apps({ log, onChange }) : options.apps;

  // Single instance: the pipe can be held by one process only.
  const server = net.createServer();
  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(pipe, () => resolve(true));
  });
  if (!listening) return null;

  let shuttingDown: Promise<void> | null = null;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const shutdown = (reason: string): Promise<void> => {
    shuttingDown ??= (async () => {
      log(`Остановка: ${reason}`);
      for (const app of [...apps].reverse()) await app.stop();
      onChange();
      await writing;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      log('Супервизор остановлен');
      finish();
      if (options.exitProcess !== false) process.exit(0);
    })();
    return shuttingDown;
  };

  server.on('connection', (socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => undefined);
    socket.on('data', async (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4096) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      let reply: unknown;
      try {
        const raw = JSON.parse(line) as { cmd?: unknown; app?: unknown };
        const command = parseCommand([String(raw.cmd ?? ''), String(raw.app ?? '')].filter(Boolean));
        if (!command) throw new Error('Неизвестная команда');
        if (command.cmd === 'status') {
          reply = { ok: true, state: state() };
        } else if (command.cmd === 'shutdown') {
          await fsp.writeFile(stopFile, JSON.stringify({ at: new Date().toISOString() }), 'utf8');
          socket.end(`${JSON.stringify({ ok: true, message: 'Останавливаю всё' })}\n`);
          void shutdown('команда shutdown (scripts\\stop.cmd)');
          return;
        } else {
          const app = apps.find((a) => a.spec.name === command.app);
          if (!app) throw new Error(`Нет программы «${command.app}»`);
          log(`Команда ${command.cmd} ${command.app}`);
          if (command.cmd === 'restart') await app.restart();
          else if (command.cmd === 'stop') await app.stop();
          else await app.start();
          reply = { ok: true, app: app.snapshot() };
        }
      } catch (error) {
        reply = { ok: false, error: (error as Error).message };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });

  log(`Супервизор запущен (PID ${process.pid}): ${apps.map((a) => a.spec.name).join(', ')}`);
  onChange();
  for (const app of apps) await app.start();
  return { pipe, state, shutdown, done };
}

async function main(argv: string[]): Promise<number> {
  const config = loadConfig(process.env);
  const runDir = path.join(config.dataDir, 'run');
  const logDir = path.join(config.dataDir, 'logs');
  const pipe = pipeNameFor(config.dataDir);

  if (argv.length > 0) {
    const command = parseCommand(argv);
    if (!command) {
      console.error('Команды: status | restart <app> | stop <app> | start <app> | shutdown');
      return 2;
    }
    try {
      const answer = await sendCommand(pipe, command);
      console.log(JSON.stringify(answer, null, 2));
      return (answer as { ok?: boolean }).ok ? 0 : 1;
    } catch (error) {
      console.error((error as Error).message);
      return 3;
    }
  }

  const supervisor = await runSupervisor({
    dataDir: config.dataDir,
    logDir,
    runDir,
    pipe,
    apps: (hooks) =>
      buildAppSpecs({ config, env: process.env, nodeExe: process.execPath, logDir }).map(
        (spec) => new ManagedApp(spec, hooks),
      ),
  });
  if (!supervisor) return 0; // another instance runs, or stopped on purpose since this boot
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => void supervisor.shutdown(signal));
  }
  await supervisor.done;
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`Супервизор: ${(error as Error).message}`);
      process.exitCode = 1;
    },
  );
}
