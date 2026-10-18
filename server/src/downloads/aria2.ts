/**
 * The torrent client: aria2 on this PC, talked to over its JSON-RPC on 127.0.0.1 with a secret that
 * only the portal and the supervisor read (a file in the data folder). The portal never exposes the
 * client's own interface, never forwards a request as it came, and decides every option itself.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';

export class Aria2Down extends Error {
  constructor(message = 'Торрент-клиент не отвечает.') {
    super(message);
  }
}

export class Aria2Error extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
}

/** aria2 sends every number as a string. */
export interface Aria2Status {
  gid: string;
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed';
  totalLength?: string;
  completedLength?: string;
  uploadLength?: string;
  downloadSpeed?: string;
  uploadSpeed?: string;
  connections?: string;
  numSeeders?: string;
  seeder?: string;
  infoHash?: string;
  errorCode?: string;
  errorMessage?: string;
  dir?: string;
  files?: Array<{ index: string; path: string; length: string; completedLength: string; selected: string }>;
  bittorrent?: { info?: { name?: string } };
}

export const STATUS_KEYS = [
  'gid',
  'status',
  'totalLength',
  'completedLength',
  'uploadLength',
  'downloadSpeed',
  'uploadSpeed',
  'connections',
  'numSeeders',
  'seeder',
  'infoHash',
  'errorCode',
  'errorMessage',
  'dir',
  'files',
  'bittorrent',
] as const;

export interface Aria2 {
  version(): Promise<string>;
  addUri(uris: readonly string[], options: Record<string, string>): Promise<string>;
  addTorrent(torrent: Buffer, options: Record<string, string>): Promise<string>;
  tellStatus(gid: string, keys?: readonly string[]): Promise<Aria2Status>;
  tellActive(): Promise<Aria2Status[]>;
  tellWaiting(): Promise<Aria2Status[]>;
  tellStopped(): Promise<Aria2Status[]>;
  pause(gid: string): Promise<void>;
  unpause(gid: string): Promise<void>;
  remove(gid: string): Promise<void>;
  removeDownloadResult(gid: string): Promise<void>;
}

export interface Aria2Options {
  url: string;
  /** The secret, or null while there is none (then every call fails as «down»). */
  secret: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createAria2(options: Aria2Options): Aria2 {
  const doFetch = options.fetch ?? fetch;
  let counter = 0;

  async function call<T>(method: string, ...params: unknown[]): Promise<T> {
    const secret = options.secret();
    if (!secret) throw new Aria2Down('У торрент-клиента нет ключа доступа.');
    counter += 1;
    let response: Response;
    try {
      response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `p${counter}`,
          method,
          params: [`token:${secret}`, ...params],
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
      });
    } catch {
      throw new Aria2Down();
    }
    let body: { result?: T; error?: { code?: number; message?: string } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new Aria2Down('Торрент-клиент прислал ответ, который не удалось прочитать.');
    }
    if (body.error) throw new Aria2Error(body.error.message ?? 'ошибка клиента', body.error.code ?? null);
    return body.result as T;
  }

  const keys = (list?: readonly string[]) => [...(list ?? STATUS_KEYS)];
  return {
    version: async () => (await call<{ version: string }>('aria2.getVersion')).version,
    addUri: (uris, opts) => call<string>('aria2.addUri', [...uris], opts),
    addTorrent: (torrent, opts) => call<string>('aria2.addTorrent', torrent.toString('base64'), [], opts),
    tellStatus: (gid, list) => call<Aria2Status>('aria2.tellStatus', gid, keys(list)),
    tellActive: () => call<Aria2Status[]>('aria2.tellActive', keys()),
    tellWaiting: () => call<Aria2Status[]>('aria2.tellWaiting', 0, 200, keys()),
    tellStopped: () => call<Aria2Status[]>('aria2.tellStopped', 0, 200, keys()),
    pause: async (gid) => void (await call('aria2.pause', gid)),
    unpause: async (gid) => void (await call('aria2.unpause', gid)),
    // forceRemove: no waiting for trackers; a seeding task stops at once.
    remove: async (gid) => void (await call('aria2.forceRemove', gid)),
    removeDownloadResult: async (gid) => void (await call('aria2.removeDownloadResult', gid)),
  };
}

/** The secret of the client's RPC: made once, kept in the data folder, read by the portal and the supervisor. */
export function aria2SecretFile(dataDir: string): string {
  return path.join(dataDir, 'aria2-rpc.json');
}

export async function ensureAria2Secret(dataDir: string): Promise<string> {
  const file = aria2SecretFile(dataDir);
  try {
    const data = (await readJsonFile(file)) as { secret?: unknown } | undefined;
    if (typeof data?.secret === 'string' && /^[0-9a-f]{64}$/.test(data.secret)) return data.secret;
  } catch {
    // unreadable: replaced below
  }
  const secret = randomBytes(32).toString('hex');
  await writeJsonAtomic(file, { secret });
  return secret;
}

/** The same for the supervisor, which builds its program list without waiting (a file is all it shares with the portal). */
export function ensureAria2SecretSync(dataDir: string): string {
  const file = aria2SecretFile(dataDir);
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { secret?: unknown };
    if (typeof data.secret === 'string' && /^[0-9a-f]{64}$/.test(data.secret)) return data.secret;
  } catch {
    // missing or unreadable: made below
  }
  const secret = randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ secret }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return secret;
}

/** Sync read for the supervisor and the portal's per-call lookup; null when there is no file yet. */
export async function readAria2Secret(dataDir: string): Promise<string | null> {
  try {
    const data = (await readJsonFile(aria2SecretFile(dataDir))) as { secret?: unknown } | undefined;
    return typeof data?.secret === 'string' && /^[0-9a-f]{64}$/.test(data.secret) ? data.secret : null;
  } catch {
    return null;
  }
}
