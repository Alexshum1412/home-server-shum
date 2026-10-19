/**
 * The queue behind «Добавить фото и видео» and «Загрузить файлы»: many files one after another, each with its own
 * progress, a retry that does not redo the good ones, a stop button, and — for big files — an upload that goes on
 * from where it broke instead of starting over.
 *
 * What it does for one file:
 *   - photos: counts the file's SHA-256 and asks the server which of the files it already holds; those are skipped
 *     («уже есть»), unless the person says «всё равно загрузить»;
 *   - small files go in one request; big ones in pieces through an upload session, and after a broken connection it
 *     asks the server where its copy ends and sends on from there (several tries, with growing pauses);
 *   - the session id is remembered in the browser, so choosing the same file again after the page was closed
 *     continues the old upload (for as long as the server keeps it: a day);
 *   - errors are told in plain words; those that will not go away by themselves (no room, not a photo) are not retried.
 * Everything that touches the network goes through `UploadApi`, so the logic is tested without a network.
 */
import type { StorageRoot, StorageSpace, UploadResponse } from '../../../shared/api.ts';
import type { HashQueryResponse, UploadSessionState } from '../../../shared/storage-extras.ts';
import { ApiFailure, NO_CONNECTION } from '../api.ts';
import { sha256OfBlob } from './sha256.ts';

export type ItemStatus = 'waiting' | 'checking' | 'uploading' | 'done' | 'skipped' | 'failed' | 'stopped';

export interface UploadItem {
  id: number;
  file: File;
  name: string;
  size: number;
  /** Folder in the space the file goes to (a month, an album, the open folder). */
  folder: string;
  status: ItemStatus;
  /** Bytes of this file the server has confirmed. */
  sentBytes: number;
  /** In plain words: why it was skipped or failed. */
  note: string;
  hash: string | null;
  saved: UploadResponse | null;
  /** Upload although the server already has the file. */
  forced: boolean;
}

export interface UploadSnapshot {
  items: UploadItem[];
  running: boolean;
  /** While the SHA-256 of the files is counted: how many are done. */
  checking: { done: number; total: number } | null;
  /** The server has not checked all its older photos yet: «не найдено» is then not a promise. */
  partialCheck: boolean;
  doneCount: number;
  skippedCount: number;
  failedCount: number;
  leftCount: number;
  bytesTotal: number;
  bytesSent: number;
}

/** A piece that begins at the wrong byte: the server says where its copy ends. */
export class OffsetError extends Error {
  readonly receivedBytes: number;
  constructor(receivedBytes: number) {
    super('offset');
    this.receivedBytes = receivedBytes;
  }
}

export interface UploadApi {
  hashes(space: StorageSpace, hashes: string[]): Promise<HashQueryResponse>;
  putSingle(
    root: StorageRoot,
    params: {
      space: StorageSpace;
      path: string;
      name: string;
      size: number;
      strip: boolean;
      sha256: string | null;
    },
    body: Blob,
    onProgress: (loaded: number) => void,
    signal: AbortSignal,
  ): Promise<UploadResponse>;
  startSession(
    root: StorageRoot,
    body: { space: StorageSpace; path: string; name: string; size: number; strip: boolean; sha256?: string },
  ): Promise<UploadSessionState>;
  /** null when the server does not know the session (any more). */
  sessionStatus(root: StorageRoot, id: string): Promise<UploadSessionState | null>;
  /** Returns the length of the server's copy after the piece; throws OffsetError when the offset was wrong. */
  putPiece(
    root: StorageRoot,
    id: string,
    offset: number,
    body: Blob,
    onProgress: (loaded: number) => void,
    signal: AbortSignal,
  ): Promise<number>;
  finish(root: StorageRoot, id: string): Promise<UploadResponse>;
  cancelSession(root: StorageRoot, id: string): Promise<void>;
  mkdir(root: StorageRoot, space: StorageSpace, path: string): Promise<void>;
}

export interface SessionMemory {
  get(key: string): string | null;
  set(key: string, id: string): void;
  remove(key: string): void;
}

export interface UploaderOptions {
  root: StorageRoot;
  space: StorageSpace;
  api: UploadApi;
  memory: SessionMemory;
  /** JPEG: take the place of shooting out (default true). */
  strip: () => boolean;
  /** Photos: skip what the server already holds. */
  checkDuplicates: () => boolean;
  onChange: (snapshot: UploadSnapshot) => void;
  /** After a file was saved (previews of photos). A failure here never fails the upload. */
  afterSaved?: (item: UploadItem, saved: UploadResponse) => Promise<void>;
  /** Pauses between tries; tests make them zero. */
  sleep?: (ms: number) => Promise<void>;
  /** Files up to this size go in one request. */
  singleMaxBytes?: number;
}

export const SINGLE_MAX_BYTES = 8 * 1024 * 1024;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000];
const SINGLE_RETRIES = [1000, 3000, 8000];
const HASH_BATCH = 100;

/** Trouble that goes away by itself: no connection, a slow server, the proxy answering while the portal restarts. */
export function isTemporary(error: unknown): boolean {
  if (error instanceof OffsetError) return true;
  if (!(error instanceof ApiFailure)) return false;
  if (error.kind === 'network' || error.kind === 'timeout') return true;
  return (
    error.status === 502 ||
    error.status === 503 ||
    error.status === 504 ||
    error.code === 'incomplete' ||
    error.code === 'busy'
  );
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function problemText(error: unknown): string {
  if (error instanceof ApiFailure) return error.unreachable ? NO_CONNECTION : error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Не удалось отправить файл.';
}

export function sessionKey(
  root: StorageRoot,
  space: StorageSpace,
  item: Pick<UploadItem, 'folder' | 'name' | 'size' | 'file'>,
): string {
  return [root, space, item.folder, item.name, item.size, item.file.lastModified].join('|');
}

export function createUploader(options: UploaderOptions) {
  const { api, memory, root, space } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const singleMax = options.singleMaxBytes ?? SINGLE_MAX_BYTES;
  let items: UploadItem[] = [];
  let nextId = 1;
  let running = false;
  let checking: { done: number; total: number } | null = null;
  let partialCheck = false;
  let controller: AbortController | null = null;
  let stopRequested = false;

  function snapshot(): UploadSnapshot {
    const count = (...states: ItemStatus[]) => items.filter((item) => states.includes(item.status)).length;
    const counted = items.filter((item) => item.status !== 'skipped');
    return {
      items: items.map((item) => ({ ...item })),
      running,
      checking,
      partialCheck,
      doneCount: count('done'),
      skippedCount: count('skipped'),
      failedCount: count('failed'),
      leftCount: count('waiting', 'checking', 'uploading', 'stopped'),
      bytesTotal: counted.reduce((sum, item) => sum + item.size, 0),
      bytesSent: counted.reduce(
        (sum, item) => sum + (item.status === 'done' ? item.size : item.sentBytes),
        0,
      ),
    };
  }
  const emit = () => options.onChange(snapshot());

  async function retrying<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (isAbort(error) || signal.aborted) throw error;
        const pause = SINGLE_RETRIES[attempt];
        if (!isTemporary(error) || pause === undefined) throw error;
        await sleep(pause);
        if (signal.aborted) throw new DOMException('Остановлено', 'AbortError');
      }
    }
  }

  async function check(signal: AbortSignal): Promise<void> {
    const todo = items.filter((item) => item.status === 'waiting' && item.hash === null && !item.forced);
    if (todo.length === 0) return;
    checking = { done: 0, total: todo.length };
    for (const item of todo) {
      if (signal.aborted) return;
      item.status = 'checking';
      emit();
      try {
        item.hash = await sha256OfBlob(item.file, undefined, signal);
      } catch (error) {
        if (isAbort(error)) {
          item.status = 'waiting';
          return;
        }
        item.hash = null; // not counted: the file is simply uploaded
      }
      item.status = 'waiting';
      checking = { done: checking.done + 1, total: checking.total };
      emit();
    }
    checking = null;
    const hashed = todo.filter((item) => item.hash !== null);
    for (let at = 0; at < hashed.length; at += HASH_BATCH) {
      if (signal.aborted) return;
      const batch = hashed.slice(at, at + HASH_BATCH);
      let answer: HashQueryResponse;
      try {
        answer = await retrying(
          () =>
            api.hashes(
              space,
              batch.map((item) => item.hash as string),
            ),
          signal,
        );
      } catch (error) {
        if (isAbort(error)) return;
        break; // the check is a convenience: without it every file is uploaded
      }
      if (!answer.complete) partialCheck = true;
      const known = new Set(answer.known);
      for (const item of batch) {
        if (item.hash && known.has(item.hash)) {
          item.status = 'skipped';
          item.note = 'Уже есть на сервере — пропущено.';
        }
      }
    }
    emit();
  }

  async function uploadResumable(item: UploadItem, signal: AbortSignal): Promise<UploadResponse> {
    const key = sessionKey(root, space, item);
    const stored = memory.get(key);
    let session: UploadSessionState | null = null;
    if (stored) session = await retrying(() => api.sessionStatus(root, stored), signal);
    if (!session) {
      session = await retrying(
        () =>
          api.startSession(root, {
            space,
            path: item.folder,
            name: item.name,
            size: item.size,
            strip: options.strip(),
            ...(item.hash ? { sha256: item.hash } : {}),
          }),
        signal,
      );
      memory.set(key, session.id);
    }
    const id = session.id;
    let offset = session.receivedBytes;
    item.sentBytes = offset;
    emit();
    let failures = 0;
    while (offset < item.size) {
      const end = Math.min(item.size, offset + session.chunkBytes);
      try {
        const from = offset;
        offset = await api.putPiece(
          root,
          id,
          offset,
          item.file.slice(from, end),
          (loaded) => {
            item.sentBytes = from + loaded;
            emit();
          },
          signal,
        );
        item.sentBytes = offset;
        emit();
        failures = 0;
      } catch (error) {
        if (isAbort(error) || signal.aborted) throw error;
        if (error instanceof OffsetError) {
          offset = error.receivedBytes; // the server knows best where its copy ends
          item.sentBytes = offset;
          continue;
        }
        if (!isTemporary(error)) throw error;
        failures += 1;
        const pause = BACKOFF_MS[failures - 1];
        if (pause === undefined) throw error;
        item.note = 'Связь пропала, пробую ещё раз…';
        emit();
        await sleep(pause);
        if (signal.aborted) throw new DOMException('Остановлено', 'AbortError');
        const state = await api.sessionStatus(root, id).catch(() => undefined);
        if (state === null) {
          memory.remove(key);
          throw new ApiFailure(
            'http',
            'Передача устарела на сервере. Нажмите «Повторить»: файл пойдёт заново.',
            404,
            'not_found',
          );
        }
        if (state) offset = state.receivedBytes;
      }
    }
    item.note = '';
    let saved: UploadResponse;
    try {
      saved = await retrying(() => api.finish(root, id), signal);
    } catch (error) {
      // The server's answer may have been lost after it placed the file: «такой передачи нет» then means «already done».
      if (error instanceof ApiFailure && error.status === 404) {
        memory.remove(key);
        return { name: item.name, sizeBytes: item.size, media: null };
      }
      if (
        error instanceof ApiFailure &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.code !== 'offset_mismatch'
      ) {
        // The server refused the finished file (a program, not a photo, a damaged copy): the session is spent.
        memory.remove(key);
      }
      throw error;
    }
    memory.remove(key);
    return saved;
  }

  async function uploadOne(item: UploadItem, signal: AbortSignal): Promise<void> {
    item.status = 'uploading';
    item.sentBytes = 0;
    item.note = '';
    emit();
    try {
      await retrying(() => api.mkdir(root, space, item.folder), signal);
      let saved: UploadResponse;
      if (item.size <= singleMax) {
        saved = await retrying(
          () =>
            api.putSingle(
              root,
              {
                space,
                path: item.folder,
                name: item.name,
                size: item.size,
                strip: options.strip(),
                sha256: item.hash,
              },
              item.file,
              (loaded) => {
                item.sentBytes = loaded;
                emit();
              },
              signal,
            ),
          signal,
        );
      } else {
        saved = await uploadResumable(item, signal);
      }
      item.saved = saved;
      item.sentBytes = item.size;
      item.status = 'done';
      item.note = saved.stripped ? 'Место съёмки и сведения о камере убраны.' : '';
      emit();
      await options.afterSaved?.(item, saved).catch(() => undefined);
    } catch (error) {
      if (isAbort(error) || signal.aborted) {
        item.status = 'stopped';
        item.note = 'Остановлено.';
      } else {
        item.status = 'failed';
        item.note = problemText(error);
      }
    }
    emit();
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    stopRequested = false;
    controller = new AbortController();
    const signal = controller.signal;
    emit();
    try {
      if (options.checkDuplicates()) await check(signal);
      for (const item of items) {
        if (signal.aborted) break;
        if (item.status !== 'waiting' && item.status !== 'stopped') continue;
        await uploadOne(item, signal);
      }
    } finally {
      for (const item of items) if (item.status === 'checking') item.status = 'waiting';
      running = false;
      checking = null;
      controller = null;
      emit();
    }
  }

  return {
    snapshot,

    /** Puts files in the queue (not started). */
    add(files: readonly File[], folderOf: (file: File) => string): void {
      for (const file of files) {
        items.push({
          id: nextId++,
          file,
          name: file.name,
          size: file.size,
          folder: folderOf(file),
          status: 'waiting',
          sentBytes: 0,
          note: '',
          hash: null,
          saved: null,
          forced: false,
        });
      }
      emit();
    },

    start: run,

    /** Stops after the piece in flight; what was sent stays on the server for a day and is taken up again. */
    stop(): void {
      stopRequested = true;
      controller?.abort();
    },

    /** The failed and stopped ones go again; the finished ones are not touched. */
    retry(): Promise<void> {
      for (const item of items) {
        if (item.status === 'failed' || item.status === 'stopped') {
          item.status = 'waiting';
          item.note = '';
        }
      }
      emit();
      return run();
    },

    /** «Всё равно загрузить» for the files that were skipped as already there. */
    uploadSkipped(): Promise<void> {
      for (const item of items) {
        if (item.status === 'skipped') {
          item.status = 'waiting';
          item.forced = true;
          item.note = '';
        }
      }
      emit();
      return run();
    },

    /** Forgets the finished ones (a new batch). */
    clearFinished(): void {
      if (running) return;
      items = items.filter((item) => item.status === 'failed' || item.status === 'stopped');
      partialCheck = false;
      emit();
    },

    /** Drops a session the server holds for an item that will not be sent any more. */
    async discard(item: UploadItem): Promise<void> {
      const key = sessionKey(root, space, item);
      const id = memory.get(key);
      if (!id) return;
      memory.remove(key);
      await api.cancelSession(root, id).catch(() => undefined);
    },

    get stopped(): boolean {
      return stopRequested;
    },
  };
}

export type Uploader = ReturnType<typeof createUploader>;

/** The sessions of this browser, kept in localStorage (a day at most; a private window may have none). */
export function browserSessionMemory(storageKey = 'fs-upload-sessions'): SessionMemory {
  const DAY = 24 * 60 * 60 * 1000;
  const read = (): Record<string, { id: string; at: number }> => {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<
        string,
        { id: string; at: number }
      >;
      const now = Date.now();
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value?.id === 'string' && now - value.at < DAY),
      );
    } catch {
      return {};
    }
  };
  const write = (value: Record<string, { id: string; at: number }>) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // no storage: the upload simply starts over after a reload
    }
  };
  return {
    get: (key) => read()[key]?.id ?? null,
    set: (key, id) => write({ ...read(), [key]: { id, at: Date.now() } }),
    remove: (key) => {
      const all = read();
      delete all[key];
      write(all);
    },
  };
}
