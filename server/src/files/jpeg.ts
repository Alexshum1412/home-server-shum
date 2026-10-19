/**
 * Takes the camera's private information out of a JPEG: where the picture was taken (GPS), the make and
 * the serial number of the camera, the time to the second, the editor's notes, thumbnails inside the
 * file. The picture itself is not touched: the compressed data after the headers is copied byte for
 * byte, so nothing is decoded and nothing is lost. What stays: the colour profile (without it colours
 * change) and the orientation (without it a portrait photo lies on its side).
 *
 * A JPEG starts with a series of segments («FF xx», a length, data) and goes on with the image data
 * after the segment SOS. Only the segments before SOS are looked at, and they are small, so the strip
 * works on a stream: it holds back the first few kilobytes, rewrites them, and lets the rest through.
 */
import { Transform, type TransformCallback } from 'node:stream';

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
/** Headers larger than this are not rewritten (a damaged file or an odd one): the file is stored as it is. */
export const HEADER_MAX = 4 * 1024 * 1024;

export interface StripResult {
  /** The bytes to store. */
  bytes: Buffer;
  /** False when the file was not changed (not a JPEG, no private segments, or headers that could not be read). */
  changed: boolean;
  /** How many bytes were removed. */
  removed: number;
}

/** The orientation (1–8) from the first EXIF segment, or null. Reads both byte orders. */
export function exifOrientation(segment: Buffer): number | null {
  // «Exif\0\0» then a TIFF header: byte order, 42, offset of the first directory.
  if (segment.length < 8 + 8 || segment.toString('latin1', 0, 4) !== 'Exif') return null;
  const tiff = segment.subarray(6);
  const little = tiff.toString('latin1', 0, 2) === 'II';
  if (!little && tiff.toString('latin1', 0, 2) !== 'MM') return null;
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (tiff.length < 8 || u16(2) !== 42) return null;
  const first = u32(4);
  if (first + 2 > tiff.length) return null;
  const count = u16(first);
  for (let index = 0; index < count; index += 1) {
    const at = first + 2 + index * 12;
    if (at + 12 > tiff.length) return null;
    if (u16(at) === 0x0112) {
      const value = u16(at + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** An EXIF segment that carries nothing but the orientation. */
export function orientationOnlySegment(orientation: number): Buffer {
  const body = Buffer.alloc(6 + 8 + 2 + 12 + 4);
  body.write('Exif\0\0', 0, 'latin1');
  body.write('II', 6, 'latin1');
  body.writeUInt16LE(42, 8);
  body.writeUInt32LE(8, 10);
  body.writeUInt16LE(1, 14); // one entry
  body.writeUInt16LE(0x0112, 16); // Orientation
  body.writeUInt16LE(3, 18); // type SHORT
  body.writeUInt32LE(1, 20); // count
  body.writeUInt16LE(orientation, 24);
  body.writeUInt32LE(0, 28); // no further directory
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt8(0xff, 0);
  out.writeUInt8(0xe1, 1);
  out.writeUInt16BE(body.length + 2, 2);
  body.copy(out, 4);
  return out;
}

type Verdict = { keep: true } | { keep: false; orientation?: number };

/** What to do with a segment before SOS. */
function judge(marker: number, data: Buffer): Verdict {
  if (marker === 0xe0) return { keep: true }; // JFIF: sizes and units, nothing private
  if (marker === 0xe2) {
    // Colour profile stays; the multi-picture index of some phones (and other APP2 data) goes.
    return data.toString('latin1', 0, 12) === 'ICC_PROFILE\0' ? { keep: true } : { keep: false };
  }
  if (marker === 0xee) return { keep: true }; // Adobe: the colour transform of CMYK/YCCK files
  if (marker === 0xe1) {
    const orientation = exifOrientation(data);
    return orientation !== null && orientation !== 1 ? { keep: false, orientation } : { keep: false };
  }
  if ((marker >= 0xe3 && marker <= 0xef) || marker === 0xfe) return { keep: false }; // other application data, comments
  return { keep: true };
}

/**
 * Rewrites the header part of a JPEG held in `head` (everything up to and including the SOS segment's
 * header). Returns null when the bytes cannot be read as JPEG headers.
 */
function rewriteHeader(head: Buffer, sosAt: number): { out: Buffer; removed: number } | null {
  if (head[0] !== 0xff || head[1] !== SOI) return null;
  const parts: Buffer[] = [head.subarray(0, 2)];
  let position = 2;
  let orientation: number | null = null;
  let removed = 0;
  let exifPlace = -1;
  while (position < sosAt) {
    if (head[position] !== 0xff) return null;
    let marker = head[position + 1] ?? 0;
    // Fill bytes: several FF in a row.
    while (marker === 0xff && position + 2 < head.length) {
      position += 1;
      marker = head[position + 1] ?? 0;
    }
    if (marker === SOS) break;
    // Standalone markers have no length (RSTn, TEM); none is expected before SOS, but do not choke on one.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(head.subarray(position, position + 2));
      position += 2;
      continue;
    }
    if (position + 4 > head.length) return null;
    const length = head.readUInt16BE(position + 2);
    if (length < 2 || position + 2 + length > head.length) return null;
    const segment = head.subarray(position, position + 2 + length);
    const verdict = judge(marker, segment.subarray(4));
    if (verdict.keep) {
      parts.push(segment);
    } else {
      removed += segment.length;
      if (verdict.orientation !== undefined && orientation === null) {
        orientation = verdict.orientation;
        // The orientation goes where the first EXIF segment was.
        exifPlace = parts.length;
        parts.push(Buffer.alloc(0));
      }
    }
    position += 2 + length;
  }
  if (orientation !== null && exifPlace >= 0) {
    const small = orientationOnlySegment(orientation);
    parts[exifPlace] = small;
    removed -= small.length;
  }
  parts.push(head.subarray(sosAt));
  return { out: Buffer.concat(parts), removed };
}

/** The offset of the SOS marker in `head`, walking the segments; -1 when it is not (yet) there. */
function findSos(head: Buffer): number {
  // The first two bytes decide whether this is a JPEG at all; until they are here nothing can be said.
  if (head.length >= 1 && head[0] !== 0xff) return -2;
  if (head.length >= 2 && head[1] !== SOI) return -2;
  if (head.length < 4) return -1;
  let position = 2;
  while (position + 4 <= head.length) {
    if (head[position] !== 0xff) return -2;
    let marker = head[position + 1] ?? 0;
    while (marker === 0xff && position + 2 < head.length) {
      position += 1;
      marker = head[position + 1] ?? 0;
    }
    if (marker === SOS) return position;
    if (marker === EOI) return -2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      position += 2;
      continue;
    }
    const length = head.readUInt16BE(position + 2);
    if (length < 2) return -2;
    position += 2 + length;
  }
  return -1;
}

/** Whole-buffer version (tests and small files). */
export function stripJpegMetadata(input: Buffer): StripResult {
  const sosAt = findSos(input);
  if (sosAt < 0) return { bytes: input, changed: false, removed: 0 };
  const rewritten = rewriteHeader(input.subarray(0, sosAt + 2), sosAt);
  if (!rewritten) return { bytes: input, changed: false, removed: 0 };
  const bytes = Buffer.concat([rewritten.out, input.subarray(sosAt + 2)]);
  const same = bytes.equals(input);
  return { bytes: same ? input : bytes, changed: !same, removed: same ? 0 : input.length - bytes.length };
}

export interface StripStream extends Transform {
  /** After the stream ended: was anything removed? */
  readonly changed: boolean;
}

/**
 * A stream version: bytes are held until the start of the image data (or HEADER_MAX), then the rewritten
 * header goes out and the rest follows untouched. Output size differs from input size: callers must
 * count the bytes they write, not the bytes they received.
 */
export function createJpegStripper(): StripStream {
  let pending: Buffer[] = [];
  let held = 0;
  let decided = false;
  let changed = false;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      if (decided) {
        callback(null, chunk);
        return;
      }
      pending.push(chunk);
      held += chunk.length;
      const joined = Buffer.concat(pending);
      const sosAt = findSos(joined);
      if (sosAt === -2 || (sosAt === -1 && held > HEADER_MAX)) {
        // Not a JPEG, or headers too large to trust: stored as received.
        decided = true;
        pending = [];
        callback(null, joined);
        return;
      }
      if (sosAt === -1) {
        pending = [joined];
        callback();
        return;
      }
      // The SOS segment has its own header (a length and the scan parameters): wait until it has arrived.
      if (joined.length < sosAt + 4 || joined.length < sosAt + 2 + joined.readUInt16BE(sosAt + 2)) {
        pending = [joined];
        callback();
        return;
      }
      decided = true;
      pending = [];
      const rewritten = rewriteHeader(joined.subarray(0, sosAt + 2), sosAt);
      if (!rewritten) {
        callback(null, joined);
        return;
      }
      const out = Buffer.concat([rewritten.out, joined.subarray(sosAt + 2)]);
      changed = !out.equals(joined);
      callback(null, out);
    },
    flush(callback: TransformCallback) {
      // A file that ended before any image data (a damaged one) is passed on as it came.
      if (!decided && pending.length > 0) callback(null, Buffer.concat(pending));
      else callback();
    },
  }) as StripStream;
  Object.defineProperty(stream, 'changed', { get: () => changed });
  return stream;
}
