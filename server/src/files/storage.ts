/**
 * Family storage (P4): personal and shared spaces for files and photos.
 *
 *   <files root>\users\<login>\...   personal files (incl. «Загрузки» from the download queue)
 *   <files root>\shared\...          family files
 *   <photos root>\users\<login>\...  personal photos and videos (by month)
 *   <photos root>\shared\...         family album
 *   <root>\.trash\...                deleted items (never deleted for good by the portal)
 *   <photos root>\.thumbs\...        thumbnails made by the uploading browser
 *
 * The personal space is always the signed-in user's own: no request can name another user's
 * folder, not even an admin's. Every path is resolved inside its space and checked again after
 * following links (realpath), so «..», drive letters, streams and junctions cannot escape.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp, type Stats } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileEntry, StorageRoot, StorageSpace } from '../../../shared/api.ts';
import { BLOCKED_TYPE_MESSAGE, isBlockedName, sanitizeName, uniqueName } from './names.ts';

export class StorageError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface StorageOptions {
  filesRoot: string;
  photosRoot: string;
  minFreeBytes: number;
  maxUploadBytes: number;
  freeBytes: (dir: string) => Promise<number | null>;
}

export interface Location {
  root: StorageRoot;
  space: StorageSpace;
  /** Relative path inside the space ('' = the space itself), forward slashes. */
  path: string;
}

const PATH_MAX = 400;

/** Media types the photo library accepts, recognised by content, not by name. */
export type MediaKind = 'image' | 'video';

/** Content sniffing of the first bytes: a renamed program or HTML page is not a photo. */
export function sniffMedia(head: Buffer): { kind: MediaKind; mime: string } | null {
  const b = head;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { kind: 'image', mime: 'image/jpeg' };
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { kind: 'image', mime: 'image/png' };
  }
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')))
    return { kind: 'image', mime: 'image/gif' };
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { kind: 'image', mime: 'image/webp' };
  }
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    if (/^(heic|heix|heim|heis|mif1|msf1|hevc|hevx|avif)$/.test(brand)) {
      return { kind: 'image', mime: brand === 'avif' ? 'image/avif' : 'image/heic' };
    }
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime' };
    return { kind: 'video', mime: 'video/mp4' };
  }
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'video', mime: 'video/webm' };
  return null;
}

/** A Windows program (PE) starts with "MZ": refused whatever its name says. */
export function looksLikeProgram(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
}

/** Content type for serving a stored file; only safe types may be shown inline. */
export function contentTypeFor(name: string): { type: string; inline: boolean } {
  const ext = path.extname(name).toLowerCase();
  const inline: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
  };
  const type = inline[ext];
  // Everything else (incl. HTML and SVG, which can run scripts) is a plain download.
  return type ? { type, inline: true } : { type: 'application/octet-stream', inline: false };
}

/**
 * Puts a finished temp file into `dir` under the first free name, never replacing a file: a hard link
 * fails with EEXIST when the name is taken (a rename would silently overwrite it on Windows), and the
 * next free name is tried. Two uploads of the same name at the same moment both survive.
 */
export async function placeFile(temp: string, dir: string, name: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = await uniqueName(dir, name);
    try {
      await fsp.link(temp, path.join(dir, candidate));
      await fsp.rm(temp, { force: true });
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV' || code === 'EINVAL') {
        // A file system without hard links: best effort, checked right before the rename.
        const free = await fsp.lstat(path.join(dir, candidate)).then(
          () => false,
          () => true,
        );
        if (!free) continue;
        await fsp.rename(temp, path.join(dir, candidate));
        return candidate;
      }
      throw error;
    }
  }
  throw new StorageError(409, 'busy', 'Не удалось подобрать свободное имя файла. Попробуйте ещё раз.');
}

/**
 * Feeds the request body into `sink` (guard → file). On any failure the request is unpiped and
 * drained instead of destroyed: destroying it would cut the connection before the client gets
 * the explanation (e.g. 415 «only photos»).
 */
async function writeFromRequest(
  body: NodeJS.ReadableStream,
  guard: Transform,
  file: NodeJS.WritableStream,
): Promise<void> {
  const done = pipeline(guard, file);
  const onError = (error: Error) => guard.destroy(error);
  const onAborted = () =>
    guard.destroy(Object.assign(new Error('Передача прервалась'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
  body.on('error', onError);
  body.on('aborted', onAborted);
  body.pipe(guard);
  try {
    await done;
  } catch (error) {
    body.unpipe(guard);
    body.resume();
    throw error;
  } finally {
    body.off('error', onError);
    body.off('aborted', onAborted);
  }
}

export function createStorage(options: StorageOptions) {
  /** Bytes promised to uploads that are still running: parallel uploads must not all pass the same free-space check. */
  let reservedBytes = 0;
  function rootDir(root: StorageRoot): string {
    return root === 'photos' ? options.photosRoot : options.filesRoot;
  }

  function spaceDir(root: StorageRoot, space: StorageSpace, username: string): string {
    return space === 'shared'
      ? path.join(rootDir(root), 'shared')
      : path.join(rootDir(root), 'users', username);
  }

  function trashDir(root: StorageRoot, space: StorageSpace, username: string): string {
    return space === 'shared'
      ? path.join(rootDir(root), '.trash', 'shared')
      : path.join(rootDir(root), '.trash', 'users', username);
  }

  function splitPath(rel: string): string[] {
    if (rel.length > PATH_MAX) throw new StorageError(400, 'bad_path', 'Слишком длинный путь.');
    const parts = rel.split(/[\\/]+/).filter((p) => p !== '');
    for (const part of parts) {
      if (sanitizeName(part) !== part) throw new StorageError(400, 'bad_path', 'Недопустимое имя в пути.');
    }
    return parts;
  }

  /** Absolute path of a location; refuses anything outside the space, also through links. */
  async function resolve(loc: Location, username: string, mustExist = true): Promise<string> {
    const base = spaceDir(loc.root, loc.space, username);
    await fsp.mkdir(base, { recursive: true });
    const full = path.join(base, ...splitPath(loc.path));
    const realBase = await fsp.realpath(base);
    let probe = full;
    // The deepest existing ancestor must stay inside the space after following links.
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        const rel = path.relative(realBase, real);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new StorageError(403, 'outside', 'Доступ к этому месту запрещён.');
        }
        break;
      } catch (error) {
        if (error instanceof StorageError) throw error;
        if (mustExist && probe === full)
          throw new StorageError(404, 'not_found', 'Такого файла или папки нет.');
        const parent = path.dirname(probe);
        if (parent === probe) throw new StorageError(404, 'not_found', 'Такого файла или папки нет.');
        probe = parent;
      }
    }
    return full;
  }

  function entryOf(name: string, stat: Stats, hasThumb: boolean): FileEntry {
    const dir = stat.isDirectory();
    return {
      name,
      type: dir ? 'dir' : 'file',
      sizeBytes: dir ? null : stat.size,
      modifiedAt: stat.mtime.toISOString(),
      mime: dir ? null : (contentTypeFor(name).type.split(';')[0] ?? null),
      hasThumb,
    };
  }

  async function ensureSpace(dir: string, needBytes: number): Promise<void> {
    const free = await options.freeBytes(dir);
    if (free !== null && free - reservedBytes - needBytes < options.minFreeBytes) {
      throw new StorageError(507, 'no_space', 'На диске сервера мало места. Сообщите администратору.');
    }
  }

  return {
    rootDir,
    spaceDir,

    async list(loc: Location, username: string): Promise<FileEntry[]> {
      const dir = await resolve(loc, username);
      const stat = await fsp.stat(dir);
      if (!stat.isDirectory()) throw new StorageError(400, 'not_a_folder', 'Это не папка.');
      const names = await fsp.readdir(dir);
      const entries: FileEntry[] = [];
      for (const name of names) {
        if (name.startsWith('.')) continue; // partial downloads, uploads in progress
        try {
          const s = await fsp.lstat(path.join(dir, name));
          if (s.isSymbolicLink()) continue;
          let thumb = false;
          if (loc.root === 'photos' && s.isFile()) {
            thumb = await fsp
              .access(this.thumbPath(loc, username, name))
              .then(() => true)
              .catch(() => false);
          }
          entries.push(entryOf(name, s, thumb));
        } catch {
          // vanished meanwhile
        }
      }
      return entries.sort((a, b) =>
        a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'ru'),
      );
    },

    thumbPath(loc: Location, username: string, fileName: string): string {
      const owner = loc.space === 'shared' ? 'shared' : path.join('users', username);
      return path.join(options.photosRoot, '.thumbs', owner, ...splitPath(loc.path), `${fileName}.jpg`);
    },

    async openFile(loc: Location, username: string) {
      const file = await resolve(loc, username);
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new StorageError(400, 'not_a_file', 'Это папка, а не файл.');
      return { file, stat, name: path.basename(file) };
    },

    async openThumb(loc: Location, username: string) {
      const parts = splitPath(loc.path);
      const name = parts.pop();
      if (!name) throw new StorageError(404, 'not_found', 'Нет миниатюры.');
      await resolve(loc, username); // the photo itself must exist in the user's space
      const thumb = this.thumbPath({ ...loc, path: parts.join('/') }, username, name);
      const stat = await fsp.stat(thumb).catch(() => null);
      if (!stat?.isFile()) throw new StorageError(404, 'not_found', 'Нет миниатюры.');
      return { file: thumb, stat };
    },

    async mkdir(loc: Location, username: string, rawName: string): Promise<string> {
      const name = sanitizeName(rawName);
      if (!name || name.startsWith('.')) throw new StorageError(400, 'bad_name', 'Недопустимое имя папки.');
      const parent = await resolve(loc, username);
      const target = path.join(parent, name);
      try {
        await fsp.mkdir(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new StorageError(409, 'exists', 'Папка или файл с таким именем уже есть.');
        }
        throw error;
      }
      return name;
    },

    async rename(loc: Location, username: string, rawName: string): Promise<string> {
      if (loc.path === '') throw new StorageError(400, 'bad_path', 'Эту папку переименовать нельзя.');
      const name = sanitizeName(rawName);
      if (!name || name.startsWith('.')) throw new StorageError(400, 'bad_name', 'Недопустимое имя.');
      const source = await resolve(loc, username);
      const stat = await fsp.stat(source);
      if (stat.isFile() && isBlockedName(name))
        throw new StorageError(422, 'blocked_type', BLOCKED_TYPE_MESSAGE);
      const target = path.join(path.dirname(source), name);
      if (target.toLowerCase() !== source.toLowerCase()) {
        if (
          await fsp.lstat(target).then(
            () => true,
            () => false,
          )
        ) {
          throw new StorageError(409, 'exists', 'Папка или файл с таким именем уже есть.');
        }
      }
      await fsp.rename(source, target);
      if (loc.root === 'photos') {
        const parent = loc.path.split('/').slice(0, -1).join('/');
        if (stat.isFile()) {
          const oldThumb = this.thumbPath({ ...loc, path: parent }, username, path.basename(source));
          await fsp
            .rename(oldThumb, this.thumbPath({ ...loc, path: parent }, username, name))
            .catch(() => undefined);
        } else {
          // The previews of a renamed month/folder move with it.
          await fsp
            .rename(
              this.thumbFolder(loc, username),
              this.thumbFolder({ ...loc, path: parent ? `${parent}/${name}` : name }, username),
            )
            .catch(() => undefined);
        }
      }
      return name;
    },

    /** Moves an item to the space's trash (the portal never deletes for good). */
    async trash(loc: Location, username: string): Promise<string> {
      if (loc.path === '') throw new StorageError(400, 'bad_path', 'Эту папку удалить нельзя.');
      const source = await resolve(loc, username);
      const bin = trashDir(loc.root, loc.space, username);
      await fsp.mkdir(bin, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const name = await uniqueName(bin, `${stamp} ${path.basename(source)}`);
      const stat = await fsp.stat(source);
      await fsp.rename(source, path.join(bin, name));
      if (loc.root === 'photos') {
        // A preview is a cache of that very picture: it must not outlive it (a later file of the same
        // name would show the old picture).
        if (stat.isFile()) {
          const parent = loc.path.split('/').slice(0, -1).join('/');
          await fsp.rm(this.thumbPath({ ...loc, path: parent }, username, path.basename(source)), {
            force: true,
          });
        } else {
          await fsp.rm(this.thumbFolder(loc, username), { recursive: true, force: true });
        }
      }
      return name;
    },

    /** Folder of the previews that belong to the folder `loc` of the photo library. */
    thumbFolder(loc: Location, username: string): string {
      const owner = loc.space === 'shared' ? 'shared' : path.join('users', username);
      return path.join(options.photosRoot, '.thumbs', owner, ...splitPath(loc.path));
    },

    /**
     * An account was removed: its personal folders are moved (never deleted) to
     * <root>\.trash\removed-users\<login>-<stamp>, so a person who gets the same login later does not
     * inherit someone else's files, and an administrator can still give them back from the server.
     */
    async archiveUser(username: string): Promise<string[]> {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const moved: string[] = [];
      for (const root of ['files', 'photos'] as const) {
        const home = path.join(rootDir(root), 'users', username);
        const exists = await fsp.lstat(home).then(
          () => true,
          () => false,
        );
        if (!exists) continue;
        const bin = path.join(rootDir(root), '.trash', 'removed-users');
        await fsp.mkdir(bin, { recursive: true });
        const name = await uniqueName(bin, `${username}-${stamp}`);
        await fsp.rename(home, path.join(bin, name));
        moved.push(path.join(bin, name));
        if (root === 'photos') {
          await fsp.rm(path.join(options.photosRoot, '.thumbs', 'users', username), {
            recursive: true,
            force: true,
          });
        }
      }
      return moved;
    },

    /**
     * Streams an upload into the folder `loc` as `rawName`: written to a hidden temp file, size and
     * content checked on the way, renamed into place only when complete.
     */
    async upload(
      loc: Location,
      username: string,
      rawName: string,
      declaredBytes: number,
      body: NodeJS.ReadableStream,
    ): Promise<{ name: string; sizeBytes: number; media: MediaKind | null }> {
      const name = sanitizeName(rawName);
      if (!name || name.startsWith('.')) throw new StorageError(400, 'bad_name', 'Недопустимое имя файла.');
      if (isBlockedName(name)) throw new StorageError(422, 'blocked_type', BLOCKED_TYPE_MESSAGE);
      if (!Number.isFinite(declaredBytes) || declaredBytes < 0) {
        throw new StorageError(411, 'length_required', 'Неизвестен размер файла.');
      }
      if (declaredBytes > options.maxUploadBytes) {
        throw new StorageError(
          413,
          'too_large',
          `Файл слишком большой: не больше ${Math.round(options.maxUploadBytes / 1024 ** 3)} ГБ.`,
        );
      }
      const dir = await resolve(loc, username);
      await ensureSpace(dir, declaredBytes);
      reservedBytes += declaredBytes;
      const temp = path.join(dir, `.upload-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`);
      let received = 0;
      let head = Buffer.alloc(0);
      let checked = false;
      let media: MediaKind | null = null;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, callback) {
          received += chunk.length;
          if (received > declaredBytes || received > options.maxUploadBytes) {
            callback(new StorageError(413, 'too_large', 'Файл больше заявленного размера.'));
            return;
          }
          if (!checked) {
            head = Buffer.concat([head, chunk]).subarray(0, 32);
            if (head.length >= 16 || received >= declaredBytes) {
              checked = true;
              if (looksLikeProgram(head)) {
                callback(new StorageError(422, 'blocked_type', BLOCKED_TYPE_MESSAGE));
                return;
              }
              const sniffed = sniffMedia(head);
              if (loc.root === 'photos' && !sniffed) {
                callback(
                  new StorageError(415, 'not_media', 'В «Фото» можно добавлять только фотографии и видео.'),
                );
                return;
              }
              media = sniffed?.kind ?? null;
            }
          }
          callback(null, chunk);
        },
      });
      try {
        await writeFromRequest(body, guard, createWriteStream(temp, { flags: 'wx' }));
        if (received !== declaredBytes) {
          throw new StorageError(400, 'incomplete', 'Файл передан не полностью. Попробуйте ещё раз.');
        }
        if (loc.root === 'photos' && received === 0) {
          throw new StorageError(415, 'not_media', 'В «Фото» можно добавлять только фотографии и видео.');
        }
        const finalName = await placeFile(temp, dir, name);
        return { name: finalName, sizeBytes: received, media };
      } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => undefined);
        if (error instanceof StorageError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOSPC') throw new StorageError(507, 'no_space', 'На диске сервера закончилось место.');
        if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
          throw new StorageError(400, 'incomplete', 'Передача файла прервалась. Попробуйте ещё раз.');
        }
        throw error;
      } finally {
        reservedBytes -= declaredBytes;
      }
    },

    /** Saves a browser-made JPEG thumbnail next to a photo that exists. */
    async saveThumb(
      loc: Location,
      username: string,
      fileName: string,
      body: NodeJS.ReadableStream,
      bytes: number,
    ) {
      if (loc.root !== 'photos') throw new StorageError(400, 'bad_request', 'Миниатюры только для фото.');
      // The size must be declared (a chunked body without a length would sidestep the cap).
      if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new StorageError(411, 'length_required', 'Неизвестен размер миниатюры.');
      }
      if (bytes > 512 * 1024) throw new StorageError(413, 'too_large', 'Миниатюра слишком большая.');
      const photoPath = loc.path === '' ? fileName : `${loc.path}/${fileName}`;
      await resolve({ ...loc, path: photoPath }, username);
      const target = this.thumbPath(loc, username, fileName);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await ensureSpace(options.photosRoot, bytes);
      let head = Buffer.alloc(0);
      let received = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, callback) {
          received += chunk.length;
          if (received > bytes)
            return callback(new StorageError(413, 'too_large', 'Миниатюра слишком большая.'));
          if (head.length < 3) head = Buffer.concat([head, chunk]).subarray(0, 3);
          if (head.length >= 3 && sniffMedia(head)?.mime !== 'image/jpeg') {
            return callback(new StorageError(415, 'not_media', 'Миниатюра должна быть JPEG.'));
          }
          callback(null, chunk);
        },
      });
      // A unique temp name: two devices backfilling the same preview must not write into one file.
      const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFromRequest(body, guard, createWriteStream(temp, { flags: 'wx' }));
        if (received !== bytes) throw new StorageError(400, 'incomplete', 'Миниатюра передана не полностью.');
        await fsp.rename(temp, target); // the same picture from either device: replacing is fine
      } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    stream: createReadStream,
  };
}

export type Storage = ReturnType<typeof createStorage>;
