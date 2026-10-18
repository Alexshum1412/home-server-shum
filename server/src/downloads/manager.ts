/**
 * Download queue of the portal (P3): direct HTTP(S) links only, no torrents, no shell.
 * Files land in the owner's own folder <files root>\users\<login>\Загрузки; nothing is executed.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DownloadState, DownloadTaskView } from '../../../shared/api.ts';
import { BLOCKED_TYPE_MESSAGE, isBlockedName, sanitizeName, uniqueName } from '../files/names.ts';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import {
  BLOCKED_MESSAGE,
  BlockedAddressError,
  checkDownloadUrl,
  createSafeLookup,
  isPublicAddress,
} from './net-guard.ts';

export const DOWNLOADS_FOLDER = 'Загрузки';
const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 60_000;
const CHECK_TTL_MS = 10 * 60_000;
const SPACE_CHECK_EVERY_BYTES = 16 * 1024 * 1024;
export const MAX_TASKS_PER_USER = 20;

/** What is kept on disk; the view adds what is the same for every link download (kind, folder label). */
export interface StoredTask
  extends Omit<DownloadTaskView, 'kind' | 'torrent' | 'destinationLabel' | 'inLibrary'> {
  /** Final file path once completed (inside the owner's folder). */
  filePath: string | null;
  etag: string | null;
  lastModified: string | null;
}

export class DownloadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ProbeResult {
  checkId: string;
  url: string;
  host: string;
  fileName: string;
  sizeBytes: number | null;
  contentType: string | null;
  resumable: boolean;
}

interface PendingCheck extends ProbeResult {
  owner: string;
  expiresAt: number;
  etag: string | null;
  lastModified: string | null;
}

export interface DownloadManagerOptions {
  dataDir: string;
  /** Root of the family files; downloads go to <root>\users\<login>\Загрузки. */
  filesRoot: string;
  maxFileBytes: number;
  minFreeBytes: number;
  maxActive?: number;
  clock: Clock;
  /** Which IP addresses may be contacted (default: public internet only; tests add loopback). */
  allowAddress?: (address: string) => boolean;
  /** Free bytes on the volume of `dir`. */
  freeBytes?: (dir: string) => Promise<number | null>;
  onEvent?: (event: {
    action: 'download.add' | 'download.done' | 'download.fail' | 'download.cancel';
    actor: string;
    detail: string;
  }) => void;
  log?: (message: string) => void;
}

interface Running {
  controller: AbortController;
  /** Why it was aborted: decides the state after the request ends. */
  reason: 'pause' | 'cancel' | 'shutdown' | null;
  done: Promise<void>;
}

export async function statfsFree(dir: string): Promise<number | null> {
  try {
    const stats = await fsp.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function contentDispositionName(header: string | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star?.[2]) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  return (plain?.[2] ?? plain?.[1] ?? '').trim() || null;
}

function nameFromUrl(url: URL): string | null {
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function parseTotal(res: IncomingMessage): number | null {
  const range = res.headers['content-range'];
  const fromRange = typeof range === 'string' ? /\/(\d+)\s*$/.exec(range)?.[1] : undefined;
  const raw = fromRange ?? (res.statusCode === 200 ? res.headers['content-length'] : undefined);
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function describeNetworkError(error: unknown): string {
  if (error instanceof BlockedAddressError) return BLOCKED_MESSAGE;
  const code = (error as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Сайт не найден: проверьте адрес или подключение к интернету.';
    case 'ECONNREFUSED':
      return 'Сайт отказал в соединении.';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return 'Сайт не ответил вовремя.';
    case 'ECONNRESET':
      return 'Соединение оборвалось.';
    case 'ENOSPC':
      return 'На диске закончилось место.';
    case 'EACCES':
    case 'EPERM':
      return 'Нет доступа к папке загрузок на сервере.';
    case 'ENOTDIR':
    case 'ENOENT':
    case 'EIO':
      return 'Папка загрузок на сервере недоступна (диск отключён или повреждён).';
    default:
      return (error as Error)?.message?.slice(0, 200) || 'Неизвестная ошибка сети';
  }
}

export function createDownloadManager(options: DownloadManagerOptions) {
  const file = path.join(options.dataDir, 'downloads.json');
  const allowAddress = options.allowAddress ?? isPublicAddress;
  const lookup = createSafeLookup(allowAddress);
  const checkUrl = (raw: string) => checkDownloadUrl(raw, allowAddress);
  const freeBytes = options.freeBytes ?? statfsFree;
  const maxActive = options.maxActive ?? 2;
  const log = options.log ?? (() => undefined);
  let tasks: StoredTask[] = [];
  const running = new Map<string, Running>();
  const checks = new Map<string, PendingCheck>();
  let saveTimer: NodeJS.Timeout | null = null;
  let saving: Promise<void> = Promise.resolve();
  let stopped = false;

  const now = () => options.clock().getTime();
  const userDir = (owner: string) => path.join(options.filesRoot, 'users', owner, DOWNLOADS_FOLDER);

  function save(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const snapshot = tasks.map((t) => ({ ...t }));
    saving = saving.then(() =>
      writeJsonAtomic(file, { version: 1, tasks: snapshot }).catch((error: unknown) =>
        log(`Не удалось сохранить downloads.json: ${(error as Error).message}`),
      ),
    );
    return saving;
  }

  function saveSoon(): void {
    saveTimer ??= setTimeout(() => void save(), 2000);
    saveTimer.unref?.();
  }

  function update(task: StoredTask, patch: Partial<StoredTask>): void {
    Object.assign(task, patch, { updatedAt: isoNow(options.clock) });
  }

  /** One HTTP(S) GET/HEAD with the safe lookup, following up to 5 checked redirects. */
  async function request(
    start: URL,
    method: 'GET' | 'HEAD',
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ res: IncomingMessage; url: URL }> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const mod = url.protocol === 'https:' ? https : http;
        const req = mod.request(
          url,
          {
            method,
            headers: { 'user-agent': 'FamilyServer-Downloads/1.0', accept: '*/*', ...headers },
            lookup,
            signal,
            timeout: CONNECT_TIMEOUT_MS,
          },
          resolve,
        );
        req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        req.end();
      });
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        res.resume();
        const next = checkUrl(new URL(location, url).href);
        if ('code' in next) throw new DownloadError(403, next.code, next.message);
        url = next.url;
        continue;
      }
      return { res, url };
    }
    throw new DownloadError(502, 'too_many_redirects', 'Слишком много перенаправлений.');
  }

  async function probe(owner: string, rawUrl: string): Promise<ProbeResult> {
    const checked = checkUrl(rawUrl);
    if ('code' in checked)
      throw new DownloadError(checked.code === 'bad_url' ? 400 : 403, checked.code, checked.message);
    let res: IncomingMessage;
    let finalUrl: URL;
    try {
      ({ res, url: finalUrl } = await request(
        checked.url,
        'GET',
        { range: 'bytes=0-0' },
        AbortSignal.timeout(30_000),
      ));
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      throw new DownloadError(
        error instanceof BlockedAddressError ? 403 : 502,
        error instanceof BlockedAddressError ? 'private_address' : 'remote_error',
        describeNetworkError(error),
      );
    }
    res.destroy();
    const status = res.statusCode ?? 0;
    if (status !== 200 && status !== 206) {
      throw new DownloadError(502, 'remote_error', `Сайт ответил ошибкой HTTP ${status}: файл недоступен.`);
    }
    const contentType =
      typeof res.headers['content-type'] === 'string'
        ? (res.headers['content-type'].split(';')[0]?.trim() ?? null)
        : null;
    if (contentType === 'text/html') {
      throw new DownloadError(
        422,
        'not_a_file',
        'По ссылке открывается веб-страница, а не файл. Нужна прямая ссылка на файл.',
      );
    }
    const name =
      sanitizeName(
        contentDispositionName(res.headers['content-disposition'] as string | undefined) ??
          nameFromUrl(finalUrl) ??
          '',
      ) ?? 'download';
    if (isBlockedName(name)) throw new DownloadError(422, 'blocked_type', BLOCKED_TYPE_MESSAGE);
    const sizeBytes = parseTotal(res);
    if (sizeBytes !== null && sizeBytes > options.maxFileBytes) {
      throw new DownloadError(
        413,
        'too_large',
        `Файл слишком большой: ограничение ${Math.round(options.maxFileBytes / 1024 ** 3)} ГБ.`,
      );
    }
    const result: PendingCheck = {
      checkId: randomUUID(),
      url: finalUrl.href,
      host: finalUrl.hostname,
      fileName: name,
      sizeBytes,
      contentType,
      resumable: status === 206,
      owner,
      expiresAt: now() + CHECK_TTL_MS,
      etag: typeof res.headers.etag === 'string' ? res.headers.etag : null,
      lastModified: typeof res.headers['last-modified'] === 'string' ? res.headers['last-modified'] : null,
    };
    for (const [id, c] of checks) if (c.expiresAt < now()) checks.delete(id);
    checks.set(result.checkId, result);
    const { owner: _o, expiresAt: _e, etag: _t, lastModified: _l, ...view } = result;
    return view;
  }

  function visible(task: StoredTask): DownloadTaskView {
    const { filePath: _f, etag: _e, lastModified: _l, ...view } = task;
    return {
      ...view,
      kind: 'link',
      torrent: null,
      destinationLabel: 'Файлы → Личное → Загрузки',
      inLibrary: false,
    };
  }

  async function add(owner: string, checkId: string): Promise<DownloadTaskView> {
    const check = checks.get(checkId);
    if (!check || check.owner !== owner || check.expiresAt < now()) {
      throw new DownloadError(
        400,
        'check_expired',
        'Сначала проверьте ссылку ещё раз — прошлая проверка устарела.',
      );
    }
    checks.delete(checkId);
    const mine = tasks.filter(
      (t) => t.owner === owner && !['completed', 'canceled', 'failed'].includes(t.state),
    );
    if (mine.some((t) => t.url === check.url)) {
      throw new DownloadError(409, 'duplicate', 'Этот файл уже скачивается или стоит в очереди.');
    }
    if (mine.length >= MAX_TASKS_PER_USER) {
      throw new DownloadError(
        429,
        'too_many_tasks',
        `Не больше ${MAX_TASKS_PER_USER} загрузок в очереди одновременно.`,
      );
    }
    const dir = userDir(owner);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (error) {
      log(`Папка загрузок недоступна (${dir}): ${(error as Error).message}`);
      throw new DownloadError(
        507,
        'storage_error',
        'Папка загрузок на сервере недоступна (диск отключён или повреждён). Сообщите администратору.',
      );
    }
    const free = await freeBytes(dir);
    if (free !== null && free - (check.sizeBytes ?? 0) < options.minFreeBytes) {
      throw new DownloadError(
        507,
        'no_space',
        'На диске сервера мало места — загрузка не начата. Сообщите администратору.',
      );
    }
    const at = isoNow(options.clock);
    const task: StoredTask = {
      id: randomUUID(),
      owner,
      url: check.url,
      host: check.host,
      fileName: check.fileName,
      sizeBytes: check.sizeBytes,
      receivedBytes: 0,
      state: 'queued',
      error: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      speedBps: null,
      filePath: null,
      etag: check.etag,
      lastModified: check.lastModified,
    };
    tasks.push(task);
    await save();
    options.onEvent?.({ action: 'download.add', actor: owner, detail: `${task.host}: ${task.fileName}` });
    schedule();
    return visible(task);
  }

  function partPath(task: StoredTask): string {
    return path.join(userDir(task.owner), `.${task.id}.part`);
  }

  function schedule(): void {
    if (stopped) return;
    for (const task of tasks) {
      if (running.size >= maxActive) return;
      if (task.state === 'queued' && !running.has(task.id)) start(task);
    }
  }

  function start(task: StoredTask): void {
    const controller = new AbortController();
    const entry: Running = { controller, reason: null, done: Promise.resolve() };
    running.set(task.id, entry);
    update(task, { state: 'downloading', error: null });
    entry.done = run(task, entry)
      .catch((error: unknown) => {
        if (entry.reason === 'pause') update(task, { state: 'paused', speedBps: null });
        else if (entry.reason === 'cancel') update(task, { state: 'canceled', speedBps: null });
        else if (entry.reason === 'shutdown') update(task, { state: 'queued', speedBps: null });
        else {
          const message = error instanceof DownloadError ? error.message : describeNetworkError(error);
          update(task, { state: 'failed', error: message, speedBps: null });
          options.onEvent?.({
            action: 'download.fail',
            actor: task.owner,
            detail: `${task.fileName}: ${message}`,
          });
        }
      })
      .finally(async () => {
        running.delete(task.id);
        if (task.state === 'canceled') await fsp.rm(partPath(task), { force: true }).catch(() => undefined);
        await save();
        schedule();
      });
  }

  async function run(task: StoredTask, entry: Running): Promise<void> {
    const dir = userDir(task.owner);
    await fsp.mkdir(dir, { recursive: true });
    const part = partPath(task);
    let have = 0;
    try {
      have = (await fsp.stat(part)).size;
    } catch {
      have = 0;
    }
    const headers: Record<string, string> = {};
    if (have > 0) {
      headers.range = `bytes=${have}-`;
      // The server must send the rest of the SAME file, otherwise it answers 200 with all of it.
      if (task.etag && !task.etag.startsWith('W/')) headers['if-range'] = task.etag;
      else if (task.lastModified) headers['if-range'] = task.lastModified;
    }
    const checked = checkUrl(task.url);
    if ('code' in checked) throw new DownloadError(403, checked.code, checked.message);
    const { res } = await request(checked.url, 'GET', headers, entry.controller.signal);
    const status = res.statusCode ?? 0;
    if (status === 416 && task.sizeBytes !== null && have >= task.sizeBytes) {
      res.resume();
    } else if (status === 200 || status === 206) {
      const append = status === 206 && have > 0;
      if (!append) have = 0;
      const total = parseTotal(res);
      if (total !== null) {
        if (total > options.maxFileBytes) {
          res.destroy();
          throw new DownloadError(
            413,
            'too_large',
            `Файл больше ограничения ${Math.round(options.maxFileBytes / 1024 ** 3)} ГБ.`,
          );
        }
        task.sizeBytes = total;
      }
      update(task, { receivedBytes: have });
      res.setTimeout(IDLE_TIMEOUT_MS, () =>
        res.destroy(Object.assign(new Error('idle'), { code: 'ESOCKETTIMEDOUT' })),
      );
      let windowStart = now();
      let windowBytes = 0;
      let sinceSpaceCheck = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, callback) {
          have += chunk.length;
          windowBytes += chunk.length;
          sinceSpaceCheck += chunk.length;
          if (have > options.maxFileBytes) {
            callback(
              new DownloadError(
                413,
                'too_large',
                `Файл больше ограничения ${Math.round(options.maxFileBytes / 1024 ** 3)} ГБ.`,
              ),
            );
            return;
          }
          const t = now();
          if (t - windowStart >= 1000) {
            task.speedBps = Math.round((windowBytes * 1000) / (t - windowStart));
            windowStart = t;
            windowBytes = 0;
          }
          task.receivedBytes = have;
          saveSoon();
          if (sinceSpaceCheck >= SPACE_CHECK_EVERY_BYTES) {
            sinceSpaceCheck = 0;
            freeBytes(dir).then(
              (free) =>
                callback(
                  free !== null && free < options.minFreeBytes
                    ? new DownloadError(
                        507,
                        'no_space',
                        'На диске сервера осталось мало места — загрузка остановлена.',
                      )
                    : null,
                  chunk,
                ),
              () => callback(null, chunk),
            );
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(res, counter, createWriteStream(part, { flags: append ? 'a' : 'w' }), {
        signal: entry.controller.signal,
      });
      if (task.sizeBytes !== null && have < task.sizeBytes) {
        throw Object.assign(new Error('incomplete'), { code: 'ECONNRESET' });
      }
    } else {
      res.resume();
      throw new DownloadError(502, 'remote_error', `Сайт ответил ошибкой HTTP ${status}.`);
    }
    // Completed: give it its final, unique name in the owner's folder.
    const name = await uniqueName(dir, task.fileName);
    const target = path.join(dir, name);
    await fsp.rename(part, target);
    // Mark of the Web: Windows treats the file as downloaded from the internet if someone opens it.
    await fsp
      .writeFile(`${target}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${task.url}\r\n`)
      .catch(() => undefined);
    update(task, {
      state: 'completed',
      fileName: name,
      filePath: target,
      receivedBytes: have,
      sizeBytes: task.sizeBytes ?? have,
      completedAt: isoNow(options.clock),
      speedBps: null,
    });
    options.onEvent?.({ action: 'download.done', actor: task.owner, detail: `${task.host}: ${name}` });
  }

  function find(id: string, actor: { username: string; isAdmin: boolean }): StoredTask {
    const task = tasks.find((t) => t.id === id);
    if (!task || (task.owner !== actor.username && !actor.isAdmin)) {
      throw new DownloadError(404, 'not_found', 'Такой загрузки нет.');
    }
    return task;
  }

  return {
    file,
    userDir,
    async load(): Promise<void> {
      const data = (await readJsonFile(file).catch(() => undefined)) as { tasks?: StoredTask[] } | undefined;
      tasks = Array.isArray(data?.tasks) ? data.tasks : [];
      // Interrupted by a restart: continue where it stopped.
      for (const task of tasks) if (task.state === 'downloading') task.state = 'queued';
      schedule();
    },
    probe,
    add,
    list(owner: string | null): DownloadTaskView[] {
      return tasks
        .filter((t) => owner === null || t.owner === owner)
        .map(visible)
        .reverse();
    },
    async pause(id: string, actor: { username: string; isAdmin: boolean }): Promise<DownloadTaskView> {
      const task = find(id, actor);
      const r = running.get(task.id);
      if (r) {
        r.reason = 'pause';
        r.controller.abort();
        await r.done;
      } else if (task.state === 'queued') {
        update(task, { state: 'paused' });
        await save();
      }
      return visible(task);
    },
    async resume(id: string, actor: { username: string; isAdmin: boolean }): Promise<DownloadTaskView> {
      const task = find(id, actor);
      if (task.state === 'paused' || task.state === 'failed') {
        update(task, { state: 'queued', error: null });
        await save();
        schedule();
      }
      return visible(task);
    },
    async cancel(id: string, actor: { username: string; isAdmin: boolean }): Promise<DownloadTaskView> {
      const task = find(id, actor);
      if (task.state === 'completed' || task.state === 'canceled') return visible(task);
      const r = running.get(task.id);
      if (r) {
        r.reason = 'cancel';
        r.controller.abort();
        await r.done;
      } else {
        update(task, { state: 'canceled', speedBps: null });
        await fsp.rm(partPath(task), { force: true }).catch(() => undefined);
        await save();
      }
      options.onEvent?.({ action: 'download.cancel', actor: actor.username, detail: task.fileName });
      return visible(task);
    },
    /** Forgets a finished task (the downloaded file stays). */
    async remove(id: string, actor: { username: string; isAdmin: boolean }): Promise<void> {
      const task = find(id, actor);
      if (!['completed', 'canceled', 'failed'].includes(task.state)) {
        throw new DownloadError(409, 'still_active', 'Сначала остановите загрузку.');
      }
      tasks = tasks.filter((t) => t !== task);
      if (task.state === 'failed') await fsp.rm(partPath(task), { force: true }).catch(() => undefined);
      await save();
    },
    /** Server shutdown: stop transfers, keep them queued for the next start. */
    async stop(): Promise<void> {
      stopped = true;
      const all = [...running.values()];
      for (const r of all) {
        r.reason = 'shutdown';
        r.controller.abort();
      }
      await Promise.all(all.map((r) => r.done));
      await save();
    },
    /** For tests: waits until no download is transferring. */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running.values()].map((r) => r.done));
    },
    stateOf(id: string): DownloadState | undefined {
      return tasks.find((t) => t.id === id)?.state;
    },
  };
}

export type DownloadManager = ReturnType<typeof createDownloadManager>;
