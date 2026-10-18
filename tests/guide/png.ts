import { deflateSync } from 'node:zlib';

/*
 * Little pictures for the screenshots of the family guide: a sky, a sun and a hill, drawn pixel by pixel
 * and written as a PNG. They are invented sample photos, not anybody's pictures.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export interface Scene {
  sky: [number, number, number];
  ground: [number, number, number];
  sun: [number, number, number];
  /** 0..1 position of the sun across the picture. */
  sunX: number;
  sunY: number;
}

export function makePng(width: number, height: number, scene: Scene): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const hill = height * (0.62 + 0.08 * Math.sin((x / width) * Math.PI * 2 + scene.sunX * 6));
      const dx = x / width - scene.sunX;
      const dy = (y / height - scene.sunY) * (height / width);
      const inSun = dx * dx + dy * dy < 0.0049;
      let rgb: [number, number, number];
      if (inSun) rgb = scene.sun;
      else if (y > hill) {
        const shade = 1 - ((y - hill) / height) * 0.5;
        rgb = scene.ground.map((value) => Math.round(value * shade)) as [number, number, number];
      } else {
        const t = y / hill;
        rgb = scene.sky.map((value) => Math.round(value * (1 - 0.35 * t) + 255 * 0.35 * t)) as [
          number,
          number,
          number,
        ];
      }
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const SCENES: Scene[] = [
  { sky: [96, 165, 250], ground: [74, 157, 105], sun: [255, 214, 102], sunX: 0.72, sunY: 0.2 },
  { sky: [251, 176, 130], ground: [96, 118, 82], sun: [255, 240, 200], sunX: 0.3, sunY: 0.45 },
  { sky: [129, 140, 248], ground: [58, 110, 140], sun: [250, 230, 160], sunX: 0.55, sunY: 0.15 },
  { sky: [125, 211, 252], ground: [189, 170, 110], sun: [255, 224, 130], sunX: 0.85, sunY: 0.3 },
  { sky: [186, 156, 214], ground: [70, 120, 96], sun: [255, 205, 140], sunX: 0.15, sunY: 0.35 },
  { sky: [110, 180, 160], ground: [120, 140, 90], sun: [255, 235, 170], sunX: 0.5, sunY: 0.25 },
];
