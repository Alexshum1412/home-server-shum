/**
 * The fixed list of programs the supervisor runs. Paths come from the code and from .env set by the
 * owner on this PC — never from the portal or any request.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config, Env } from '../config.ts';
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
  return specs;
}
