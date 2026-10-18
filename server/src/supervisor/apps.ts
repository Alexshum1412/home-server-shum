/**
 * The fixed list of programs the supervisor runs. Paths come from the code and from .env set by the
 * owner on this PC — never from the portal or any request.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config, Env } from '../config.ts';
import { ensureAria2SecretSync } from '../downloads/aria2.ts';
import { REPO_ROOT } from '../lib/version.ts';
import type { AppSpec } from './managed.ts';

export const JELLYFIN_PORT = 8096;

export interface JellyfinPaths {
  /** Folder with jellyfin.exe from the official ZIP. */
  home: string;
  exe: string;
  /** Jellyfin's own data (database, metadata), config, cache and logs. */
  dataRoot: string;
  /** API key file the supervisor uses for a clean shutdown (written by scripts/jellyfin-setup). */
  apiKeyFile: string;
}

function systemDrive(env: Env): string {
  const drive = env.SystemDrive?.trim() ?? env.SYSTEMDRIVE?.trim() ?? '';
  return /^[a-zA-Z]:$/.test(drive) ? drive.toUpperCase() : 'C:';
}

export function jellyfinPaths(env: Env, config: Pick<Config, 'dataDir'>): JellyfinPaths {
  const root = `${systemDrive(env)}\\FamilyServer`;
  const home = env.JELLYFIN_HOME?.trim() || `${root}\\apps\\jellyfin`;
  return {
    home,
    exe: path.join(home, 'jellyfin.exe'),
    dataRoot: env.JELLYFIN_DATA_DIR?.trim() || `${root}\\data\\jellyfin`,
    apiKeyFile: path.join(config.dataDir, 'jellyfin-api.json'),
  };
}

export interface Aria2Paths {
  exe: string;
  /** Session (unfinished tasks survive a restart), peer cache and the settings file with the RPC secret. */
  dataRoot: string;
  conf: string;
  port: number;
}

export function aria2Paths(env: Env, config: Pick<Config, 'torrent'>): Aria2Paths {
  const root = `${systemDrive(env)}\\FamilyServer`;
  const dataRoot = env.ARIA2_DATA_DIR?.trim() || `${root}\\data\\aria2`;
  return {
    exe: path.join(config.torrent.home, 'aria2c.exe'),
    dataRoot,
    conf: path.join(dataRoot, 'aria2.conf'),
    port: Number(new URL(config.torrent.rpcUrl).port || 6800),
  };
}

/**
 * The settings file of the torrent client. The RPC secret lives here, not on the command line
 * (every program on the PC can read a command line). Loopback only, no cross-site access, an upload
 * limit and a sharing limit so that the home connection stays usable.
 */
export function aria2Conf(paths: Aria2Paths, secret: string, config: Pick<Config, 'torrent'>): string {
  const session = path.join(paths.dataRoot, 'session.txt');
  return [
    'enable-rpc=true',
    `rpc-listen-port=${paths.port}`,
    'rpc-listen-all=false',
    'rpc-allow-origin-all=false',
    'rpc-max-request-size=12M',
    `rpc-secret=${secret}`,
    `input-file=${session}`,
    `save-session=${session}`,
    'save-session-interval=30',
    `dir=${path.join(paths.dataRoot, 'incoming')}`,
    'max-concurrent-downloads=3',
    'file-allocation=none',
    'allow-overwrite=false',
    'auto-file-renaming=true',
    'enable-dht=true',
    'enable-dht6=false',
    `dht-file-path=${path.join(paths.dataRoot, 'dht.dat')}`,
    'enable-peer-exchange=true',
    'bt-enable-lpd=false',
    'bt-max-peers=80',
    'disable-ipv6=true',
    `seed-ratio=${config.torrent.seedRatio}`,
    'seed-time=1440',
    `max-overall-upload-limit=${config.torrent.uploadLimitKb}K`,
    'disk-cache=32M',
    'console-log-level=warn',
    'summary-interval=0',
    'quiet=false',
    '',
  ].join('\n');
}

export interface LlamaPaths {
  /** Folder with llama-server.exe (llama.cpp CPU build, installed by scripts/ai-setup). */
  exe: string;
  /** The model file (GGUF). */
  model: string;
  port: number;
}

/** The video card of this PC has 2 GB, so the model runs on the processor: a small model, a short context. */
export function llamaPaths(env: Env, config: Pick<Config, 'oliviaLlm'>): LlamaPaths {
  const root = `${systemDrive(env)}\\FamilyServer`;
  const home = env.LLAMA_HOME?.trim() || `${root}\\apps\\llama`;
  return {
    exe: path.join(home, 'llama-server.exe'),
    model: env.OLIVIA_MODEL_FILE?.trim() || `${root}\\data\\models\\qwen2.5-1.5b-instruct-q4_k_m.gguf`,
    port: Number(new URL(config.oliviaLlm?.url ?? 'http://127.0.0.1:8081/v1').port || 8081),
  };
}

export function llamaArgs(paths: LlamaPaths, config: Pick<Config, 'oliviaLlm'>, env: Env): string[] {
  const threads = Math.max(1, Math.min(16, Number(env.OLIVIA_LLM_THREADS) || 3));
  const context = Math.max(512, Math.min(8192, Number(env.OLIVIA_LLM_CONTEXT) || 2048));
  return [
    '-m',
    paths.model,
    '--host',
    '127.0.0.1',
    '--port',
    String(paths.port),
    '--alias',
    config.oliviaLlm?.model ?? 'local',
    '-c',
    String(context),
    '-t',
    String(threads),
    '-np',
    '1',
    '--no-webui',
  ];
}

/** Reads the API key saved during setup; null when there is none (the stop is then a hard kill). */
export function readJellyfinApiKey(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { apiKey?: unknown };
    return typeof parsed.apiKey === 'string' && /^[0-9a-f]{32}$/i.test(parsed.apiKey) ? parsed.apiKey : null;
  } catch {
    return null;
  }
}

export function jellyfinArgs(paths: JellyfinPaths): string[] {
  return [
    '--datadir',
    path.join(paths.dataRoot, 'data'),
    '--configdir',
    path.join(paths.dataRoot, 'config'),
    '--cachedir',
    path.join(paths.dataRoot, 'cache'),
    '--logdir',
    path.join(paths.dataRoot, 'log'),
    '--webdir',
    path.join(paths.home, 'jellyfin-web'),
    '--ffmpeg',
    path.join(paths.home, 'ffmpeg.exe'),
  ];
}

export interface AppListOptions {
  config: Config;
  env: Env;
  nodeExe: string;
  logDir: string;
  fetch?: typeof fetch;
}

export function buildAppSpecs(options: AppListOptions): AppSpec[] {
  const { config, env, logDir } = options;
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const specs: AppSpec[] = [
    {
      name: 'dashboard',
      title: 'Портал',
      command: options.nodeExe,
      args: ['--env-file-if-exists=.env', path.join('server', 'src', 'index.ts')],
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      ipc: true,
      healthUrl: `http://${host.includes(':') ? `[${host}]` : host}:${config.port}/api/health`,
      startupGraceMs: 60_000,
      stopTimeoutMs: 15_000,
      stdoutLog: path.join(logDir, 'dashboard.out.log'),
      stderrLog: path.join(logDir, 'dashboard.err.log'),
    },
  ];

  const jf = jellyfinPaths(env, config);
  if (env.SUPERVISE_JELLYFIN?.trim() !== '0' && existsSync(jf.exe)) {
    const doFetch = options.fetch ?? fetch;
    specs.push({
      name: 'jellyfin',
      title: 'Кинотеатр (Jellyfin)',
      command: jf.exe,
      args: jellyfinArgs(jf),
      cwd: jf.home,
      env: { ...process.env },
      healthUrl: `http://127.0.0.1:${JELLYFIN_PORT}/health`,
      // The first start migrates the database and can take minutes on an HDD.
      startupGraceMs: 10 * 60_000,
      stopTimeoutMs: 45_000,
      gracefulStop: async () => {
        const key = readJellyfinApiKey(jf.apiKeyFile);
        if (!key) throw new Error('нет ключа API Jellyfin');
        const res = await doFetch(`http://127.0.0.1:${JELLYFIN_PORT}/System/Shutdown`, {
          method: 'POST',
          headers: { Authorization: `MediaBrowser Token="${key}"` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      },
      stdoutLog: path.join(logDir, 'jellyfin.out.log'),
      stderrLog: path.join(logDir, 'jellyfin.err.log'),
    });
  }
  const aria = aria2Paths(env, config);
  if (env.SUPERVISE_ARIA2?.trim() !== '0' && existsSync(aria.exe)) {
    const doFetch = options.fetch ?? fetch;
    const secret = ensureAria2SecretSync(config.dataDir);
    mkdirSync(path.join(aria.dataRoot, 'incoming'), { recursive: true });
    // The session file must exist, or the client refuses to start with --input-file.
    const session = path.join(aria.dataRoot, 'session.txt');
    if (!existsSync(session)) writeFileSync(session, '');
    writeFileSync(aria.conf, aria2Conf(aria, secret, config), { mode: 0o600 });
    const rpc = `http://127.0.0.1:${aria.port}/jsonrpc`;
    specs.push({
      name: 'aria2',
      title: 'Торрент-клиент (aria2)',
      command: aria.exe,
      args: [`--conf-path=${aria.conf}`],
      cwd: path.dirname(aria.exe),
      env: { ...process.env },
      // «system.*» methods answer without the secret: the page only learns that the client is alive.
      healthUrl: `${rpc}?method=system.listMethods&id=health`,
      startupGraceMs: 60_000,
      stopTimeoutMs: 20_000,
      gracefulStop: async () => {
        // Saves the session and closes connections properly.
        const res = await doFetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'stop',
            method: 'aria2.shutdown',
            params: [`token:${secret}`],
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
      stdoutLog: path.join(logDir, 'aria2.out.log'),
      stderrLog: path.join(logDir, 'aria2.err.log'),
    });
  }
  // The local language model for Olivia: only when it is installed AND switched on in .env (OLIVIA_LLM_URL),
  // so a PC that has the files but never asked for the model does not spend memory on it.
  const llama = llamaPaths(env, config);
  if (
    env.SUPERVISE_LLAMA?.trim() !== '0' &&
    config.oliviaLlm !== null &&
    existsSync(llama.exe) &&
    existsSync(llama.model)
  ) {
    specs.push({
      name: 'llama',
      title: 'Языковая модель Оливии (llama.cpp)',
      command: llama.exe,
      args: llamaArgs(llama, config, env),
      cwd: path.dirname(llama.exe),
      env: { ...process.env },
      healthUrl: `http://127.0.0.1:${llama.port}/health`,
      // Loading a ~1 GB model from a hard disk takes a minute or two.
      startupGraceMs: 5 * 60_000,
      stopTimeoutMs: 10_000,
      stdoutLog: path.join(logDir, 'llama.out.log'),
      stderrLog: path.join(logDir, 'llama.err.log'),
    });
  }
  return specs;
}
