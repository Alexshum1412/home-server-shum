/**
 * A small reader of .zip files (a .cbz comic is a zip of pictures): the list of entries and one entry's bytes, without
 * unpacking the whole archive. Stored and deflated entries only (what comic archives use); no zip64.
 */
import { open } from 'node:fs/promises';
import { inflateRaw } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** A single picture of a comic is never larger than this. */
export const MAX_ENTRY_BYTES = 60 * 1024 * 1024;

export async function readZipEntries(file: string): Promise<ZipEntry[]> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    if (dirOffset === 0xffffffff || dirSize > 32 * 1024 * 1024) throw new Error('zip is not supported');
    const dir = Buffer.alloc(dirSize);
    await handle.read(dir, 0, dirSize, dirOffset);
    const entries: ZipEntry[] = [];
    let at = 0;
    for (let n = 0; n < count && at + 46 <= dir.length; n += 1) {
      if (dir.readUInt32LE(at) !== 0x02014b50) break;
      const nameLength = dir.readUInt16LE(at + 28);
      const extraLength = dir.readUInt16LE(at + 30);
      const commentLength = dir.readUInt16LE(at + 32);
      entries.push({
        name: dir.toString('utf8', at + 46, at + 46 + nameLength),
        method: dir.readUInt16LE(at + 10),
        compressedSize: dir.readUInt32LE(at + 20),
        size: dir.readUInt32LE(at + 24),
        offset: dir.readUInt32LE(at + 42),
      });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

export async function readZipEntry(file: string, entry: ZipEntry): Promise<Buffer> {
  if (entry.size > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES)
    throw new Error('entry too large');
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.offset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('broken zip entry');
    const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = Buffer.alloc(entry.compressedSize);
    await handle.read(raw, 0, entry.compressedSize, start);
    if (entry.method === 0) return raw;
    if (entry.method !== 8) throw new Error('compression is not supported');
    return await new Promise<Buffer>((resolve, reject) =>
      inflateRaw(raw, (error, out) => (error ? reject(error) : resolve(out))),
    );
  } finally {
    await handle.close();
  }
}
