/**
 * A stand-in for aria2's JSON-RPC, for tests: it keeps tasks in memory, checks the secret, records
 * every call, and lets a test decide how a task progresses. It understands the few methods the
 * portal uses.
 */
import { promises as fsp } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { parseTorrent } from '../../src/downloads/bencode.ts';

export interface FakeTask {
  gid: string;
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed';
  kind: 'metadata' | 'download';
  infoHash: string;
  name: string;
  dir: string;
  files: Array<{ index: string; path: string; length: string; completedLength: string; selected: string }>;
  options: Record<string, string>;
  completed: number;
  total: number;
  uploaded: number;
  downSpeed: number;
  upSpeed: number;
  seeder: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface FakeAria2 {
  url: string;
  tasks: Map<string, FakeTask>;
  calls: Array<{ method: string; params: unknown[] }>;
  /** What the client would find for a magnet link (the portal fetches this as «metadata»). */
  setMetadata(infoHash: string, torrent: Buffer): void;
  progress(infoHash: string, completed: number, speed?: number): void;
  finish(infoHash: string, options?: { seeding?: boolean }): void;
  fail(infoHash: string, code: string, message?: string): void;
  forget(infoHash: string): void;
  close(): Promise<void>;
}

export async function startFakeAria2(options: {
  secret: string;
  port: number;
  /** Every look at the active tasks moves them forward (a quarter, at most 3 MB) (for tests that cannot reach the fake). */
  autoAdvance?: boolean;
  /** Torrents the client «finds» for a magnet link (hash → file), known from the start. */
  metadata?: Array<{ infoHash: string; torrent: Buffer }>;
}): Promise<FakeAria2> {
  const tasks = new Map<string, FakeTask>();
  const calls: FakeAria2['calls'] = [];
  const metadata = new Map<string, Buffer>(
    (options.metadata ?? []).map((entry) => [entry.infoHash, entry.torrent]),
  );
  let nextGid = 1;
  const gid = () => (nextGid++).toString(16).padStart(16, '0');
  const status = (task: FakeTask) => ({
    gid: task.gid,
    status: task.status,
    totalLength: String(task.total),
    completedLength: String(task.completed),
    uploadLength: String(task.uploaded),
    downloadSpeed: String(task.downSpeed),
    uploadSpeed: String(task.upSpeed),
    connections: '5',
    numSeeders: '3',
    seeder: String(task.seeder),
    infoHash: task.infoHash,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    dir: task.dir,
    files: task.files,
    bittorrent: { info: { name: task.name } },
  });

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const send = (body: object) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      let call: { id: string; method: string; params: unknown[] };
      try {
        call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof call;
      } catch {
        return send({ error: { code: 1, message: 'parse' } });
      }
      const [token, ...params] = call.params;
      if (token !== `token:${options.secret}`) {
        return send({ jsonrpc: '2.0', id: call.id, error: { code: 1, message: 'Unauthorized' } });
      }
      calls.push({ method: call.method, params });
      const ok = (result: unknown) => send({ jsonrpc: '2.0', id: call.id, result });
      const find = (id: unknown) => tasks.get(String(id));
      switch (call.method) {
        case 'aria2.getVersion':
          return ok({ version: '1.37.0' });
        case 'aria2.addUri': {
          const [uris, opts] = params as [string[], Record<string, string>];
          const hash = /btih:([0-9a-f]{40})/.exec(uris[0] ?? '')?.[1] ?? '';
          const task: FakeTask = {
            gid: gid(),
            status: 'active',
            kind: 'metadata',
            infoHash: hash,
            name: hash,
            dir: opts.dir ?? '',
            files: [],
            options: opts,
            completed: 0,
            total: 0,
            uploaded: 0,
            downSpeed: 0,
            upSpeed: 0,
            seeder: false,
          };
          tasks.set(task.gid, task);
          const torrent = metadata.get(hash);
          if (torrent) {
            await fsp.mkdir(opts.dir ?? '.', { recursive: true });
            await fsp.writeFile(path.join(opts.dir ?? '.', `${hash}.torrent`), torrent);
            task.status = 'complete';
          }
          return ok(task.gid);
        }
        case 'aria2.addTorrent': {
          const [b64, , opts] = params as [string, unknown[], Record<string, string>];
          const bytes = Buffer.from(b64, 'base64');
          const meta = parseTorrent(bytes);
          const selected = new Set((opts['select-file'] ?? '').split(',').filter(Boolean).map(Number));
          if (
            [...tasks.values()].some(
              (t) => t.infoHash === meta.infoHash && t.status !== 'removed' && t.kind === 'download',
            )
          ) {
            return send({
              jsonrpc: '2.0',
              id: call.id,
              error: { code: 1, message: `GID is already in use for infoHash ${meta.infoHash}` },
            });
          }
          const files = meta.files.map((file, index) => ({
            index: String(index + 1),
            path: path.join(opts.dir ?? '', meta.single ? '' : meta.name, ...file.path),
            length: String(file.length),
            completedLength: '0',
            selected: String(selected.size === 0 || selected.has(index + 1)),
          }));
          const task: FakeTask = {
            gid: gid(),
            status: 'active',
            kind: 'download',
            infoHash: meta.infoHash,
            name: meta.name,
            dir: opts.dir ?? '',
            files,
            options: opts,
            completed: 0,
            total: files.filter((f) => f.selected === 'true').reduce((sum, f) => sum + Number(f.length), 0),
            uploaded: 0,
            downSpeed: 0,
            upSpeed: 0,
            seeder: false,
          };
          tasks.set(task.gid, task);
          return ok(task.gid);
        }
        case 'aria2.tellStatus': {
          const task = find(params[0]);
          if (!task)
            return send({
              jsonrpc: '2.0',
              id: call.id,
              error: { code: 1, message: `GID ${String(params[0])} is not found` },
            });
          return ok(status(task));
        }
        case 'aria2.tellActive':
          if (options.autoAdvance) {
            for (const task of tasks.values()) {
              if (task.kind !== 'download' || task.status !== 'active' || task.seeder) continue;
              task.completed = Math.min(
                task.total,
                task.completed + Math.min(Math.ceil(task.total / 4), 3_000_000),
              );
              task.downSpeed = 3_000_000;
              task.upSpeed = 40_000;
              if (task.completed >= task.total) {
                task.status = 'complete';
                task.downSpeed = 0;
              }
            }
          }
          return ok([...tasks.values()].filter((t) => t.status === 'active').map(status));
        case 'aria2.tellWaiting':
          return ok(
            [...tasks.values()].filter((t) => t.status === 'waiting' || t.status === 'paused').map(status),
          );
        case 'aria2.tellStopped':
          return ok(
            [...tasks.values()]
              .filter((t) => t.status === 'error' || t.status === 'complete' || t.status === 'removed')
              .map(status),
          );
        case 'aria2.pause': {
          const task = find(params[0]);
          if (task) task.status = 'paused';
          return ok(params[0]);
        }
        case 'aria2.unpause': {
          const task = find(params[0]);
          if (task) task.status = 'active';
          return ok(params[0]);
        }
        case 'aria2.forceRemove': {
          const task = find(params[0]);
          if (task) task.status = 'removed';
          return ok(params[0]);
        }
        case 'aria2.removeDownloadResult': {
          tasks.delete(String(params[0]));
          return ok('OK');
        }
        default:
          return send({
            jsonrpc: '2.0',
            id: call.id,
            error: { code: 1, message: `unknown method ${call.method}` },
          });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  const byHash = (infoHash: string) =>
    [...tasks.values()].find((t) => t.infoHash === infoHash && t.kind === 'download');
  return {
    url: `http://127.0.0.1:${options.port}/jsonrpc`,
    tasks,
    calls,
    setMetadata: (infoHash, torrent) => void metadata.set(infoHash, torrent),
    progress(infoHash, completed, speed = 1_000_000) {
      const task = byHash(infoHash);
      if (!task) return;
      task.completed = completed;
      task.downSpeed = speed;
      task.upSpeed = 20_000;
    },
    finish(infoHash, finishOptions = {}) {
      const task = byHash(infoHash);
      if (!task) return;
      task.completed = task.total;
      task.downSpeed = 0;
      if (finishOptions.seeding) {
        task.seeder = true;
        task.status = 'active';
        task.uploaded = Math.round(task.total * 0.4);
      } else task.status = 'complete';
    },
    fail(infoHash, code, message) {
      const task = byHash(infoHash);
      if (!task) return;
      task.status = 'error';
      task.errorCode = code;
      task.errorMessage = message;
      task.downSpeed = 0;
    },
    forget(infoHash) {
      const task = byHash(infoHash);
      if (task) tasks.delete(task.gid);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
