/**
 * What is inside a .torrent file, read by the portal itself before anything is handed to the
 * torrent client: the name, the files, the size and the trackers. The portal also rewrites the file
 * so that only what it has checked reaches the client (no web seeds, no unsafe trackers).
 *
 * Bencode: integers `i42e`, byte strings `4:spam`, lists `l…e`, dictionaries `d…e`. The info-hash is
 * the SHA-1 of the exact bytes of the `info` dictionary, so those bytes are copied, never re-encoded.
 */
import { createHash } from 'node:crypto';

export class TorrentError extends Error {}

export type Bencoded = Buffer | number | Bencoded[] | { [key: string]: Bencoded };

const MAX_DEPTH = 10;
const MAX_TORRENT_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 20_000;

interface Parsed {
  value: Bencoded;
  end: number;
}

function parseAt(buf: Buffer, at: number, depth: number, spans?: Map<string, [number, number]>): Parsed {
  if (depth > MAX_DEPTH) throw new TorrentError('Файл .torrent слишком сложный.');
  const byte = buf[at];
  if (byte === undefined) throw new TorrentError('Файл .torrent оборван.');
  if (byte === 0x69) {
    // i<digits>e
    const end = buf.indexOf(0x65, at + 1);
    const text = end === -1 ? '' : buf.toString('latin1', at + 1, end);
    if (!/^-?\d{1,16}$/.test(text)) throw new TorrentError('Файл .torrent повреждён (число).');
    return { value: Number(text), end: end + 1 };
  }
  if (byte === 0x6c) {
    const list: Bencoded[] = [];
    let cursor = at + 1;
    while (buf[cursor] !== 0x65) {
      if (cursor >= buf.length) throw new TorrentError('Файл .torrent оборван.');
      const item = parseAt(buf, cursor, depth + 1);
      list.push(item.value);
      cursor = item.end;
      if (list.length > 200_000) throw new TorrentError('В файле .torrent слишком много записей.');
    }
    return { value: list, end: cursor + 1 };
  }
  if (byte === 0x64) {
    const dict: { [key: string]: Bencoded } = Object.create(null) as { [key: string]: Bencoded };
    let cursor = at + 1;
    while (buf[cursor] !== 0x65) {
      if (cursor >= buf.length) throw new TorrentError('Файл .torrent оборван.');
      const key = parseAt(buf, cursor, depth + 1);
      if (!Buffer.isBuffer(key.value)) throw new TorrentError('Файл .torrent повреждён (ключ).');
      const value = parseAt(buf, key.end, depth + 1);
      const name = key.value.toString('latin1');
      dict[name] = value.value;
      if (spans && depth === 0) spans.set(name, [key.end, value.end]);
      cursor = value.end;
    }
    return { value: dict, end: cursor + 1 };
  }
  if (byte >= 0x30 && byte <= 0x39) {
    const colon = buf.indexOf(0x3a, at);
    const text = colon === -1 ? '' : buf.toString('latin1', at, colon);
    if (!/^\d{1,9}$/.test(text)) throw new TorrentError('Файл .torrent повреждён (строка).');
    const length = Number(text);
    const start = colon + 1;
    if (start + length > buf.length) throw new TorrentError('Файл .torrent оборван.');
    return { value: buf.subarray(start, start + length), end: start + length };
  }
  throw new TorrentError('Это не файл .torrent.');
}

export function decode(buf: Buffer): { value: Bencoded; spans: Map<string, [number, number]> } {
  if (buf.length === 0 || buf.length > MAX_TORRENT_BYTES) {
    throw new TorrentError('Файл .torrent пустой или слишком большой (больше 4 МБ).');
  }
  const spans = new Map<string, [number, number]>();
  const parsed = parseAt(buf, 0, 0, spans);
  if (parsed.end !== buf.length) throw new TorrentError('После конца файла .torrent есть лишние данные.');
  return { value: parsed.value, spans };
}

const isDict = (value: Bencoded | undefined): value is { [key: string]: Bencoded } =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);

const text = (value: Bencoded | undefined): string | null =>
  Buffer.isBuffer(value) ? value.toString('utf8') : null;

export interface TorrentFile {
  path: string[];
  length: number;
}

export interface TorrentMeta {
  /** 40 hex characters. */
  infoHash: string;
  name: string;
  files: TorrentFile[];
  /** One file saved as <folder>\<name>; otherwise a folder <name> holds all files. */
  single: boolean;
  totalBytes: number;
  /** Every tracker named in the file (http, https, udp), unchecked. */
  trackers: string[];
  /** The file is hybrid or v2 only: this client cannot download it. */
  v2Only: boolean;
  /** The bytes of the file as they came. */
  raw: Buffer;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A name inside a torrent that is safe as a part of a Windows path; the reason otherwise. */
export function problemWithComponent(name: string): string | null {
  if (name === '' || name === '.' || name === '..') return 'недопустимое имя';
  if (name.length > 240) return 'слишком длинное имя';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f<>:"/\\|?*]/.test(name))
    return 'в имени есть запрещённые знаки (: \\ / ? * " < > |)';
  if (/[. ]$/.test(name)) return 'имя заканчивается точкой или пробелом';
  if (WINDOWS_RESERVED.test(name)) return 'имя занято Windows';
  return null;
}

export function parseTorrent(raw: Buffer): TorrentMeta {
  const { value, spans } = decode(raw);
  if (!isDict(value)) throw new TorrentError('Это не файл .torrent.');
  const info = value.info;
  const span = spans.get('info');
  if (!isDict(info) || !span) throw new TorrentError('В файле .torrent нет описания раздачи.');
  const infoHash = createHash('sha1').update(raw.subarray(span[0], span[1])).digest('hex');
  const name = text(info['name.utf-8']) ?? text(info.name);
  if (!name) throw new TorrentError('У раздачи нет названия.');
  const nameProblem = problemWithComponent(name);
  if (nameProblem)
    throw new TorrentError(`Название раздачи «${name.slice(0, 60)}» не подходит: ${nameProblem}.`);

  const files: TorrentFile[] = [];
  const single = !Array.isArray(info.files);
  if (Array.isArray(info.files)) {
    if (info.files.length > MAX_FILES) throw new TorrentError('В раздаче слишком много файлов.');
    for (const entry of info.files) {
      if (!isDict(entry) || typeof entry.length !== 'number' || entry.length < 0) {
        throw new TorrentError('Описание файлов в раздаче повреждено.');
      }
      const parts = entry['path.utf-8'] ?? entry.path;
      if (!Array.isArray(parts) || parts.length === 0 || parts.length > 32) {
        throw new TorrentError('Описание файлов в раздаче повреждено.');
      }
      const path = parts.map((part) => text(part) ?? '');
      for (const part of path) {
        const problem = problemWithComponent(part);
        if (problem) {
          throw new TorrentError(
            `В раздаче есть файл с недопустимым путём «${path.join('/').slice(0, 80)}»: ${problem}.`,
          );
        }
      }
      files.push({ path, length: entry.length });
    }
  } else if (typeof info.length === 'number' && info.length >= 0) {
    files.push({ path: [name], length: info.length });
  } else {
    throw new TorrentError('В раздаче нет файлов.');
  }
  if (files.length === 0) throw new TorrentError('В раздаче нет файлов.');
  const totalBytes = files.reduce((sum, file) => sum + file.length, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new TorrentError('Размер раздачи не читается.');

  const trackers: string[] = [];
  const announce = text(value.announce);
  if (announce) trackers.push(announce);
  if (Array.isArray(value['announce-list'])) {
    for (const tier of value['announce-list']) {
      if (!Array.isArray(tier)) continue;
      for (const item of tier) {
        const url = text(item);
        if (url) trackers.push(url);
      }
    }
  }
  return {
    infoHash,
    name,
    files,
    single,
    totalBytes,
    trackers: [...new Set(trackers)].slice(0, 60),
    // A v2-only file has `file tree` and no `pieces`; hybrids have both and work.
    v2Only: info['meta version'] === 2 && !Buffer.isBuffer(info.pieces),
    raw,
  };
}

const bytes = (value: string) => Buffer.from(value, 'utf8');
const str = (value: Buffer) => Buffer.concat([bytes(`${value.length}:`), value]);

/**
 * The file the client gets: the checked info dictionary (byte for byte), the trackers the portal
 * accepted, and nothing else — no web seeds (`url-list`, `httpseeds`) that would make the client
 * fetch from addresses of the portal's choosing, no comments or other keys.
 */
export function rebuildTorrent(raw: Buffer, trackers: readonly string[]): Buffer {
  const { spans } = decode(raw);
  const span = spans.get('info');
  if (!span) throw new TorrentError('В файле .torrent нет описания раздачи.');
  // Keys of a bencoded dictionary must be sorted: announce < announce-list < info.
  const parts: Buffer[] = [bytes('d')];
  if (trackers[0]) parts.push(str(bytes('announce')), str(bytes(trackers[0])));
  if (trackers.length > 0) {
    parts.push(str(bytes('announce-list')), bytes('l'));
    for (const tracker of trackers) parts.push(bytes('l'), str(bytes(tracker)), bytes('e'));
    parts.push(bytes('e'));
  }
  parts.push(str(bytes('info')), raw.subarray(span[0], span[1]), bytes('e'));
  return Buffer.concat(parts);
}
