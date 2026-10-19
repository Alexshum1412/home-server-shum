/**
 * Uploads that survive a broken connection. A phone on a mobile network loses the signal in the middle of
 * a 2 GB video; with one big request everything is lost, with this one only the piece in flight.
 *
 *   start     the server makes a place for the file (a hidden «.uploads» folder of the space) and says «send me bytes from 0»;
 *   append    the phone sends the next piece with the byte it begins at; the server takes it only if that is
 *             exactly where its copy ends (a repeated or skipped piece is refused and the true position is told);
 *   status    after a break the phone asks where the server's copy ends and goes on from there;
 *   finish    the size (and the hash, when the phone gave one) is checked, the file is placed under a free
 *             name — never over another file — and the temporary parts are removed.
 *
 * Nothing here is a second set of rules: the name, the type, the size, the free space, the quota and the
 * «photos are only pictures» check are the same as for a single-request upload.
 */
import { createHash, type Hash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import type { StorageRoot, StorageSpace } from '../../../shared/api.ts';
import type { UploadSessionRequest, UploadSessionState } from '../../../shared/storage-extras.ts';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { createJpegStripper } from './jpeg.ts';
import { BLOCKED_TYPE_MESSAGE, isBlockedName, sanitizeName } from './names.ts';
import {
  checkHead,
  type Location,
  type MediaKind,
  placeFile,
  type Storage,
  StorageError,
  sniffMedia,
  writeFromRequest,
} from './storage.ts';

export const CHUNK_MAX = 16 * 1024 * 1024;
export const CHUNK_ADVISED = 4 * 1024 * 1024;
export const SESSIONS_PER_PERSON = 30;
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const UPLOADS_FOLDER = '.uploads';
const ID_RE = /^[0-9a-f]{24}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export class OffsetMismatch extends StorageError {
  readonly receivedBytes: number;
  constructor(receivedBytes: number) {
    super(
      409,
      'offset_mismatch',
      'Этот кусок файла начинается не там, где закончилась копия на сервере. Продолжайте с указанного места.',
    );
    this.receivedBytes = receivedBytes;
  }
}

interface Meta {
  id: string;
  owner: string;
  root: StorageRoot;
  space: StorageSpace;
  path: string;
  name: string;
  size: number;
  strip: boolean;
  sha256: string | null;
  createdAt: string;
}

export interface FinishedUpload {
  name: string;
  sizeBytes: number;
  media: MediaKind | null;
  sha256: string;
  stripped: boolean;
}

export interface SessionDeps {
  storage: Storage;
  maxUploadBytes: number;
  now?: () => Date;
  quota?: {
    check(username: string, extraBytes: number): Promise<void>;
    added(username: string, bytes: number): void;
  };
  hashes?: { record(space: StorageSpace, username: string, hash: string, rel: string): Promise<void> };
}

export function createUploadSessions(deps: SessionDeps) {
  const { storage } = deps;
  const now = deps.now ?? (() => new Date());
  /** Running hashes of the bytes received so far; a session that was resumed after a restart has none and is hashed by reading. */
  const hashers = new Map<string, { hash: Hash; bytes: number }>();
  const busy = new Set<string>();

  function folderOf(root: StorageRoot, space: StorageSpace, username: string): string {
    return path.join(storage.spaceDir(root, space, username), UPLOADS_FOLDER);
  }

  const metaFile = (folder: string, id: string) => path.join(folder, `${id}.json`);
  const partFile = (folder: string, id: string) => path.join(folder, `${id}.part`);

  async function load(
    username: string,
    root: StorageRoot,
    id: string,
  ): Promise<{ meta: Meta; folder: string; dir: string; part: string }> {
    if (!ID_RE.test(id)) throw new StorageError(404, 'not_found', 'Такой передачи нет.');
    // The personal space of this person first, then the shared one: the id says nothing about the space.
    for (const space of ['personal', 'shared'] as const) {
      const folder = folderOf(root, space, username);
      try {
        const meta = (await readJsonFile(metaFile(folder, id))) as Meta | undefined;
        if (meta && meta.id === id && meta.owner === username && meta.root === root) {
          return { meta, folder, dir: path.dirname(folder), part: partFile(folder, id) };
        }
      } catch {
        // unreadable: as if it were not there
      }
    }
    throw new StorageError(404, 'not_found', 'Такой передачи нет или она устарела. Начните отправку заново.');
  }

  async function received(part: string): Promise<number> {
    return (await fsp.stat(part).catch(() => null))?.size ?? 0;
  }

  async function removeSession(folder: string, id: string): Promise<void> {
    hashers.delete(id);
    busy.delete(id);
    await fsp.rm(partFile(folder, id), { force: true }).catch(() => undefined);
    await fsp.rm(metaFile(folder, id), { force: true }).catch(() => undefined);
  }

  async function countOwn(folder: string, username: string): Promise<number> {
    let names: string[];
    try {
      names = await fsp.readdir(folder);
    } catch {
      return 0;
    }
    let count = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const meta = (await readJsonFile(path.join(folder, name)).catch(() => undefined)) as Meta | undefined;
      if (meta?.owner === username) count += 1;
    }
    return count;
  }

  return {
    async start(
      username: string,
      root: StorageRoot,
      request: UploadSessionRequest,
    ): Promise<UploadSessionState> {
      const name = sanitizeName(request.name);
      if (!name || name.startsWith('.')) throw new StorageError(400, 'bad_name', 'Недопустимое имя файла.');
      if (isBlockedName(name)) throw new StorageError(422, 'blocked_type', BLOCKED_TYPE_MESSAGE);
      if (!Number.isSafeInteger(request.size) || request.size < 0) {
        throw new StorageError(411, 'length_required', 'Неизвестен размер файла.');
      }
      if (request.size > deps.maxUploadBytes) {
        throw new StorageError(
          413,
          'too_large',
          `Файл слишком большой: не больше ${Math.round(deps.maxUploadBytes / 1024 ** 3)} ГБ.`,
        );
      }
      if (request.sha256 !== undefined && !HASH_RE.test(request.sha256)) {
        throw new StorageError(400, 'bad_request', 'Контрольная сумма указана неверно.');
      }
      const loc: Location = { root, space: request.space, path: request.path };
      const dir = await storage.internals.resolve(loc, username);
      await storage.internals.ensureSpace(dir, request.size);
      if (request.space === 'personal') await deps.quota?.check(username, request.size);
      const folder = folderOf(root, request.space, username);
      await fsp.mkdir(folder, { recursive: true });
      if ((await countOwn(folder, username)) >= SESSIONS_PER_PERSON) {
        throw new StorageError(
          429,
          'too_many',
          'Слишком много незаконченных передач. Дождитесь их окончания или повторите позже.',
        );
      }
      const id = randomBytes(12).toString('hex');
      const meta: Meta = {
        id,
        owner: username,
        root,
        space: request.space,
        path: loc.path.replace(/\\/g, '/'),
        name,
        size: request.size,
        strip: request.strip !== false,
        sha256: request.sha256 ?? null,
        createdAt: now().toISOString(),
      };
      await fsp.writeFile(partFile(folder, id), '', { flag: 'wx' });
      await writeJsonAtomic(metaFile(folder, id), meta);
      hashers.set(id, { hash: createHash('sha256'), bytes: 0 });
      return { id, name, size: request.size, receivedBytes: 0, chunkBytes: CHUNK_ADVISED };
    },

    async status(username: string, root: StorageRoot, id: string): Promise<UploadSessionState> {
      const { meta, part } = await load(username, root, id);
      return {
        id,
        name: meta.name,
        size: meta.size,
        receivedBytes: await received(part),
        chunkBytes: CHUNK_ADVISED,
      };
    },

    /** Takes one piece that begins at `offset`. Answers the new length of the server's copy. */
    async append(
      username: string,
      root: StorageRoot,
      id: string,
      offset: number,
      length: number,
      body: NodeJS.ReadableStream,
    ): Promise<number> {
      const { meta, dir, part } = await load(username, root, id);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new StorageError(400, 'bad_request', 'Не указано, с какого байта начинается кусок.');
      }
      if (!Number.isSafeInteger(length) || length <= 0) {
        throw new StorageError(411, 'length_required', 'Неизвестен размер куска.');
      }
      if (length > CHUNK_MAX) throw new StorageError(413, 'too_large', 'Кусок слишком большой.');
      if (busy.has(id)) throw new StorageError(409, 'busy', 'Предыдущий кусок ещё принимается.');
      busy.add(id);
      try {
        const have = await received(part);
        if (offset !== have) throw new OffsetMismatch(have);
        if (offset + length > meta.size) {
          throw new StorageError(413, 'too_large', 'Кусок выходит за заявленный размер файла.');
        }
        await storage.internals.ensureSpace(dir, length);
        const running = hashers.get(id);
        const hashing = running && running.bytes === offset ? running : null;
        if (!hashing) hashers.delete(id); // a gap in what was hashed: finish() reads the file instead
        let taken = 0;
        const guard = new Transform({
          transform(chunk: Buffer, _enc, callback) {
            taken += chunk.length;
            if (taken > length) {
              callback(new StorageError(413, 'too_large', 'Кусок больше заявленного размера.'));
              return;
            }
            if (hashing) {
              hashing.hash.update(chunk);
              hashing.bytes += chunk.length;
            }
            callback(null, chunk);
          },
        });
        try {
          await writeFromRequest(body, guard, createWriteStream(part, { flags: 'a' }));
        } catch (error) {
          // What did arrive stays (the copy is a prefix of the file); the position is asked for again.
          hashers.delete(id);
          const code = (error as NodeJS.ErrnoException).code;
          if (error instanceof StorageError) throw error;
          if (code === 'ENOSPC')
            throw new StorageError(507, 'no_space', 'На диске сервера закончилось место.');
          if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
            throw new StorageError(
              400,
              'incomplete',
              'Передача куска прервалась. Продолжайте с сохранённого места.',
            );
          }
          throw error;
        }
        if (taken !== length) {
          hashers.delete(id);
          throw new StorageError(
            400,
            'incomplete',
            'Кусок передан не полностью. Продолжайте с сохранённого места.',
          );
        }
        return await received(part);
      } finally {
        busy.delete(id);
      }
    },

    async finish(username: string, root: StorageRoot, id: string): Promise<FinishedUpload> {
      const { meta, folder, dir, part } = await load(username, root, id);
      if (busy.has(id)) throw new StorageError(409, 'busy', 'Последний кусок ещё принимается.');
      busy.add(id);
      try {
        const have = await received(part);
        if (have !== meta.size) {
          throw new OffsetMismatch(have);
        }
        const fd = await fsp.open(part, 'r');
        const head = Buffer.alloc(Math.min(32, meta.size));
        try {
          await fd.read(head, 0, head.length, 0);
        } finally {
          await fd.close();
        }
        if (meta.root === 'photos' && meta.size === 0) {
          throw new StorageError(415, 'not_media', 'В «Фото» можно добавлять только фотографии и видео.');
        }
        const media = checkHead(meta.root, head);
        // The hash of the bytes as they arrived: from the running state, or by reading the file once.
        const running = hashers.get(id);
        let sha256: string;
        if (running && running.bytes === meta.size) {
          sha256 = running.hash.digest('hex');
        } else {
          const again = createHash('sha256');
          for await (const piece of createReadStream(part)) again.update(piece as Buffer);
          sha256 = again.digest('hex');
        }
        if (meta.sha256 && meta.sha256 !== sha256) {
          await removeSession(folder, id);
          throw new StorageError(422, 'hash_mismatch', 'Файл дошёл с искажением. Передайте его ещё раз.');
        }
        let written = meta.size;
        let stripped = false;
        let finalName: string;
        if (meta.strip && sniffMedia(head)?.mime === 'image/jpeg') {
          // A JPEG is rewritten without the place of shooting; the rest of the types are moved as they are.
          const temp = path.join(
            dir,
            `.upload-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`,
          );
          const stripper = createJpegStripper();
          let count = 0;
          const counter = new Transform({
            transform(chunk: Buffer, _enc, callback) {
              count += chunk.length;
              callback(null, chunk);
            },
          });
          try {
            await storage.internals.ensureSpace(dir, meta.size);
            const source = createReadStream(part);
            await writeFromRequest(source, passThrough(), createWriteStream(temp, { flags: 'wx' }), [
              stripper,
              counter,
            ]);
            written = count;
            stripped = stripper.changed;
            finalName = await placeFile(temp, dir, meta.name);
          } catch (error) {
            await fsp.rm(temp, { force: true }).catch(() => undefined);
            throw error;
          }
          await fsp.rm(part, { force: true }).catch(() => undefined);
        } else {
          finalName = await placeFile(part, dir, meta.name);
        }
        await fsp.rm(metaFile(folder, id), { force: true }).catch(() => undefined);
        hashers.delete(id);
        if (meta.space === 'personal') deps.quota?.added(username, written);
        if (meta.root === 'photos') {
          const rel = meta.path === '' ? finalName : `${meta.path}/${finalName}`;
          await deps.hashes?.record(meta.space, username, sha256, rel).catch(() => undefined);
        }
        return { name: finalName, sizeBytes: written, media, sha256, stripped };
      } finally {
        busy.delete(id);
      }
    },

    async cancel(username: string, root: StorageRoot, id: string): Promise<void> {
      const { folder } = await load(username, root, id);
      await removeSession(folder, id);
    },

    /** Unfinished sessions older than a day are removed (files and photos, personal and shared). */
    async sweep(usernames: readonly string[]): Promise<number> {
      let removed = 0;
      const cutoff = now().getTime() - SESSION_MAX_AGE_MS;
      const folders: string[] = [];
      for (const root of ['files', 'photos'] as const) {
        folders.push(folderOf(root, 'shared', ''));
        for (const username of usernames) folders.push(folderOf(root, 'personal', username));
      }
      for (const folder of folders) {
        let names: string[];
        try {
          names = await fsp.readdir(folder);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const meta = (await readJsonFile(path.join(folder, name)).catch(() => undefined)) as
            | Meta
            | undefined;
          if (!meta || Date.parse(meta.createdAt) < cutoff) {
            await removeSession(folder, name.replace(/\.json$/, ''));
            removed += 1;
          }
        }
      }
      return removed;
    },
  };
}

function passThrough(): Transform {
  return new Transform({
    transform(chunk, _enc, callback) {
      callback(null, chunk);
    },
  });
}

export type UploadSessions = ReturnType<typeof createUploadSessions>;
