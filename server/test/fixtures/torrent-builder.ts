/** Builds invented .torrent files for tests (nothing real is described or downloaded). */
import { createHash } from 'node:crypto';

type Value = Buffer | string | number | Value[] | { [key: string]: Value };

export function enc(value: Value): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (typeof value === 'string')
    return Buffer.concat([Buffer.from(`${Buffer.byteLength(value)}:`), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(enc), Buffer.from('e')]);
  const keys = Object.keys(value).sort();
  return Buffer.concat([
    Buffer.from('d'),
    ...keys.flatMap((key) => [enc(key), enc(value[key] as Value)]),
    Buffer.from('e'),
  ]);
}

export interface TorrentSpec {
  name: string;
  /** Omitted: a single-file torrent of `length` bytes. */
  files?: Array<{ path: string[]; length: number }>;
  length?: number;
  announce?: string;
  announceList?: string[][];
  urlList?: string[];
  httpSeeds?: string[];
  comment?: string;
  extraInfo?: { [key: string]: Value };
}

export function makeTorrent(spec: TorrentSpec): { bytes: Buffer; infoHash: string } {
  const info: { [key: string]: Value } = {
    name: spec.name,
    'piece length': 262_144,
    pieces: Buffer.alloc(20, 7),
    ...spec.extraInfo,
  };
  if (spec.files) info.files = spec.files.map((file) => ({ length: file.length, path: file.path }));
  else info.length = spec.length ?? 1000;
  const top: { [key: string]: Value } = { info };
  if (spec.announce) top.announce = spec.announce;
  if (spec.announceList) top['announce-list'] = spec.announceList;
  if (spec.urlList) top['url-list'] = spec.urlList;
  if (spec.httpSeeds) top.httpseeds = spec.httpSeeds;
  if (spec.comment) top.comment = spec.comment;
  top['created by'] = 'tests';
  return { bytes: enc(top), infoHash: createHash('sha1').update(enc(info)).digest('hex') };
}
