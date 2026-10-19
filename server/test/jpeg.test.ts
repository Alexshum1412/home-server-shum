import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  createJpegStripper,
  exifOrientation,
  orientationOnlySegment,
  stripJpegMetadata,
} from '../src/files/jpeg.ts';

const GPS_CANARY = 'GPSCANARY-N55.7558-E37.6173';
const XMP_CANARY = 'XMPCANARY-owner-Ivanov';
const COMMENT_CANARY = 'COMMENTCANARY-camera-123456';
const MAKE_CANARY = 'MAKECANARY-Pixel-SN9981';

const segment = (marker: number, data: Buffer) => {
  const head = Buffer.alloc(4);
  head.writeUInt8(0xff, 0);
  head.writeUInt8(marker, 1);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
};

/** An EXIF segment with the orientation, a make, and a GPS directory that holds a readable canary. */
function exif(orientation: number): Buffer {
  const text = (value: string) => Buffer.from(`${value}\0`, 'latin1');
  const make = text(MAKE_CANARY);
  const gps = text(GPS_CANARY);
  // TIFF (big endian): header, IFD0 with three entries (make, orientation, gps pointer), then the data.
  const tiff = Buffer.alloc(8 + 2 + 3 * 12 + 4 + make.length + 2 + 1 * 12 + 4 + gps.length);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(3, 8);
  const makeAt = 8 + 2 + 3 * 12 + 4;
  const gpsIfdAt = makeAt + make.length;
  const entry = (index: number, tag: number, type: number, count: number, value: number) => {
    const at = 10 + index * 12;
    tiff.writeUInt16BE(tag, at);
    tiff.writeUInt16BE(type, at + 2);
    tiff.writeUInt32BE(count, at + 4);
    if (type === 3) tiff.writeUInt16BE(value, at + 8);
    else tiff.writeUInt32BE(value, at + 8);
  };
  entry(0, 0x010f, 2, make.length, makeAt); // Make
  entry(1, 0x0112, 3, 1, orientation); // Orientation
  entry(2, 0x8825, 4, 1, gpsIfdAt); // GPS IFD pointer
  make.copy(tiff, makeAt);
  tiff.writeUInt16BE(1, gpsIfdAt);
  const gpsEntryAt = gpsIfdAt + 2;
  tiff.writeUInt16BE(0x0001, gpsEntryAt);
  tiff.writeUInt16BE(2, gpsEntryAt + 2);
  tiff.writeUInt32BE(gps.length, gpsEntryAt + 4);
  tiff.writeUInt32BE(gpsEntryAt + 12 + 4, gpsEntryAt + 8);
  gps.copy(tiff, gpsEntryAt + 12 + 4);
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
}

const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
const IMAGE_DATA = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
const ICC = segment(
  0xe2,
  Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), Buffer.from('profile-bytes')]),
);
const MPF = segment(
  0xe2,
  Buffer.concat([Buffer.from('MPF\0', 'latin1'), Buffer.from('second-picture-index')]),
);

function jpeg(orientation = 6): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'latin1')),
    exif(orientation),
    segment(
      0xe1,
      Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${XMP_CANARY}</x:xmpmeta>`, 'latin1'),
    ),
    ICC,
    MPF,
    segment(0xfe, Buffer.from(COMMENT_CANARY, 'latin1')),
    segment(0xdb, Buffer.alloc(65, 7)),
    segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    segment(0xc4, Buffer.alloc(20, 1)),
    SCAN,
    IMAGE_DATA,
    Buffer.from([0xff, 0xd9]),
  ]);
}

const canaries = [GPS_CANARY, XMP_CANARY, COMMENT_CANARY, MAKE_CANARY];

async function viaStream(input: Buffer, piece: number) {
  const stripper = createJpegStripper();
  const out: Buffer[] = [];
  stripper.on('data', (chunk: Buffer) => out.push(chunk));
  const chunks: Buffer[] = [];
  for (let at = 0; at < input.length; at += piece) chunks.push(input.subarray(at, at + piece));
  await pipeline(Readable.from(chunks), stripper);
  return { bytes: Buffer.concat(out), changed: stripper.changed };
}

describe('taking private data out of a JPEG', () => {
  it('the canary position, camera, XMP and comment are gone, the image data is copied byte for byte', () => {
    const original = jpeg();
    for (const canary of canaries) expect(original.includes(canary), canary).toBe(true);
    const { bytes, changed, removed } = stripJpegMetadata(original);
    expect(changed).toBe(true);
    for (const canary of canaries) expect(bytes.includes(canary), canary).toBe(false);
    expect(bytes.length).toBe(original.length - removed);
    // The picture: everything from the scan on is identical, the file still starts and ends as a JPEG.
    expect(
      bytes
        .subarray(bytes.length - (SCAN.length + IMAGE_DATA.length + 2))
        .equals(original.subarray(original.length - (SCAN.length + IMAGE_DATA.length + 2))),
    ).toBe(true);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it('keeps the colour profile and the orientation, and drops the multi-picture index', () => {
    const { bytes } = stripJpegMetadata(jpeg(6));
    expect(bytes.includes(Buffer.from('ICC_PROFILE\0'))).toBe(true);
    expect(bytes.includes(Buffer.from('profile-bytes'))).toBe(true);
    expect(bytes.includes(Buffer.from('MPF\0'))).toBe(false);
    expect(bytes.includes(Buffer.from('second-picture-index'))).toBe(false);
    const at = bytes.indexOf(Buffer.from('Exif\0\0'));
    expect(at).toBeGreaterThan(0);
    const length = bytes.readUInt16BE(at - 2) - 2;
    expect(exifOrientation(bytes.subarray(at, at + length))).toBe(6);
    // Only the orientation is in that segment: nothing else of the EXIF survived.
    expect(length).toBe(orientationOnlySegment(6).length - 4);
  });

  it('writes no EXIF at all when the picture is not rotated', () => {
    const { bytes } = stripJpegMetadata(jpeg(1));
    expect(bytes.includes(Buffer.from('Exif\0\0'))).toBe(false);
    for (const canary of canaries) expect(bytes.includes(canary)).toBe(false);
  });

  it('reads the orientation in both byte orders and refuses nonsense', () => {
    const little = Buffer.concat([Buffer.from('Exif\0\0'), orientationOnlySegment(8).subarray(10)]);
    expect(exifOrientation(little)).toBe(8);
    expect(exifOrientation(Buffer.from('not exif at all, just text'))).toBeNull();
    expect(exifOrientation(Buffer.alloc(3))).toBeNull();
  });

  it('leaves other files and already clean JPEGs as they are', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100, 5)]);
    expect(stripJpegMetadata(png)).toMatchObject({ changed: false, removed: 0 });
    expect(stripJpegMetadata(png).bytes).toBe(png);
    const clean = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xdb, Buffer.alloc(65, 7)),
      SCAN,
      IMAGE_DATA,
      Buffer.from([0xff, 0xd9]),
    ]);
    const again = stripJpegMetadata(clean);
    expect(again.changed).toBe(false);
    expect(again.bytes.equals(clean)).toBe(true);
    // A damaged header (a segment longer than the file) is passed on, not thrown at.
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xf0]), Buffer.alloc(10)]);
    expect(stripJpegMetadata(broken).changed).toBe(false);
  });

  it('gives the same result as a stream, however the bytes arrive', async () => {
    const original = jpeg(3);
    const whole = stripJpegMetadata(original).bytes;
    for (const piece of [1, 2, 3, 7, 64, 1000, original.length]) {
      const streamed = await viaStream(original, piece);
      expect(streamed.bytes.equals(whole), `pieces of ${piece}`).toBe(true);
      expect(streamed.changed).toBe(true);
    }
  });

  it('passes a non-JPEG stream through untouched, also when it is tiny', async () => {
    const text = Buffer.from('just a text file, not a picture');
    for (const piece of [1, 5, text.length]) {
      const streamed = await viaStream(text, piece);
      expect(streamed.bytes.equals(text)).toBe(true);
      expect(streamed.changed).toBe(false);
    }
    expect((await viaStream(Buffer.alloc(0), 10)).bytes.length).toBe(0);
    const stub = Buffer.from([0xff, 0xd8, 0xff]);
    expect((await viaStream(stub, 1)).bytes.equals(stub)).toBe(true);
  });
});
