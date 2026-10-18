/**
 * A tiny archive of one folder, written as a stream (so it can be encrypted on the fly) and read back with
 * every path checked: files only, relative posix paths without «..», drive letters or characters Windows
 * forbids, no duplicates. Layout: for each file [path length (2) | path | size (8) | bytes], then a zero length.
 */
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { ByteReader, CryptError } from './crypt.ts';
import { listTree } from './files.ts';
import { isSafeSnapshotPath, MANIFEST_FILE } from './snapshot.ts';

const MAX_PATH_BYTES = 1024;

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}

/** Packs a snapshot folder. Links and unusual objects make it refuse: a snapshot has none. */
export async function* packTree(dir: string): AsyncGenerator<Buffer> {
  const listing = await listTree(dir);
  if (listing.links.length > 0 || listing.others.length > 0) {
    throw new CryptError('В копии есть ссылки или посторонние объекты: упаковать её нельзя');
  }
  for (const rel of listing.files) {
    // The manifest is a file like any other here (the restore checks it), but it is validated on the way back.
    const absolute = path.join(dir, ...rel.split('/'));
    const stats = await fsp.stat(absolute);
    const name = Buffer.from(rel, 'utf8');
    if (name.length === 0 || name.length > MAX_PATH_BYTES)
      throw new CryptError(`Слишком длинный путь в копии: ${rel}`);
    yield Buffer.concat([u16(name.length), name, u64(stats.size)]);
    let sent = 0;
    for await (const piece of createReadStream(absolute)) {
      sent += (piece as Buffer).length;
      yield piece as Buffer;
    }
    if (sent !== stats.size) throw new CryptError(`Файл изменился во время упаковки: ${rel}`);
  }
  yield u16(0);
}

export interface UnpackResult {
  files: number;
  bytes: number;
}

/** Names Windows treats as devices («CON», «NUL», «COM1.txt») and names it silently shortens («a.», «a »). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function safeEntryPath(rel: string): boolean {
  // The manifest is allowed here (it is part of every snapshot), but only at the top level.
  if (rel === MANIFEST_FILE) return true;
  if (!isSafeSnapshotPath(rel)) return false;
  // Writing «con.txt» on Windows would open a device instead of making a file.
  return rel.split('/').every((segment) => !WINDOWS_DEVICE.test(segment) && !/[. ]$/.test(segment));
}

/**
 * Reads the archive. With `dest` the files are written there (the folder must be new or empty); without it
 * they are only read and counted, which is how a copy is verified without leaving anything on disk.
 */
export async function unpackTree(source: AsyncIterable<Buffer>, dest: string | null): Promise<UnpackResult> {
  const reader = new ByteReader(source);
  if (dest !== null) await fsp.mkdir(dest, { recursive: true });
  const seen = new Set<string>();
  const result: UnpackResult = { files: 0, bytes: 0 };
  for (;;) {
    const lead = await reader.read(2);
    if (lead === null) throw new CryptError('Архив обрывается: нет признака конца');
    const nameLength = lead.readUInt16BE(0);
    if (nameLength === 0) break;
    if (nameLength > MAX_PATH_BYTES) throw new CryptError('Архив повреждён: слишком длинное имя файла');
    const name = await reader.read(nameLength);
    const sizeBytes = await reader.read(8);
    if (name === null || sizeBytes === null) throw new CryptError('Архив обрывается посреди записи');
    const rel = name.toString('utf8');
    const size = Number(sizeBytes.readBigUInt64BE(0));
    if (!Number.isSafeInteger(size)) throw new CryptError('Архив повреждён: нелепый размер файла');
    if (!safeEntryPath(rel)) throw new CryptError(`Небезопасный путь в архиве: ${rel.slice(0, 80)}`);
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new CryptError(`Повторяющийся файл в архиве: ${rel.slice(0, 80)}`);
    seen.add(key);

    if (dest === null) {
      for await (const piece of reader.take(size)) result.bytes += piece.length;
    } else {
      const target = path.join(dest, ...rel.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const handle = await fsp.open(target, 'wx');
      try {
        for await (const piece of reader.take(size)) {
          let offset = 0;
          while (offset < piece.length) {
            const { bytesWritten } = await handle.write(piece, offset, piece.length - offset);
            offset += bytesWritten;
          }
          result.bytes += piece.length;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    result.files += 1;
  }
  return result;
}
