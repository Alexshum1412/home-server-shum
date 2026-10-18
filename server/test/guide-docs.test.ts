import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The family guide is only useful when its pictures are there and are real pictures: every image the
 * guide links must exist, be a PNG of a sensible size, and every picture of the folder must be used.
 */
const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const GUIDE = path.join(DOCS, 'FAMILY_USER_GUIDE.md');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const text = readFileSync(GUIDE, 'utf8');
const images = [...text.matchAll(/!\[([^\]]*)]\(([^)]+)\)/g)].map((match) => ({
  alt: match[1] ?? '',
  file: match[2] ?? '',
}));

describe('FAMILY_USER_GUIDE.md', () => {
  it('shows the screens the owner asked for', () => {
    const names = images.map((image) => path.basename(image.file));
    for (const wanted of [
      '01-home.png',
      '02-cinema.png',
      '07-downloads-queue.png',
      '05-files.png',
      '06-photos.png',
      '08-olivia.png',
      '09-chat.png',
      '09c-call.png',
      '11-account.png',
      '12-remote-access.png',
      '14-monitoring.png',
      '13-admin-users.png',
    ]) {
      expect(names, wanted).toContain(wanted);
    }
  });

  it('links only pictures that exist and are real PNG files', () => {
    expect(images.length).toBeGreaterThan(10);
    for (const image of images) {
      expect(image.alt.trim(), `${image.file} has no description`).not.toBe('');
      const file = path.join(DOCS, image.file);
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 8).equals(PNG), `${image.file} is not a PNG`).toBe(true);
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      expect(width, `${image.file} width`).toBeGreaterThanOrEqual(300);
      expect(height, `${image.file} height`).toBeGreaterThanOrEqual(300);
      expect(statSync(file).size, `${image.file} is too small to be a screen`).toBeGreaterThan(8_000);
    }
  });

  it('has no picture lying unused in the folder', () => {
    const used = new Set(images.map((image) => path.basename(image.file)));
    const folder = path.join(DOCS, 'images', 'family-guide');
    const files = readdirSync(folder).filter((name) => name.endsWith('.png'));
    for (const name of files) expect(used.has(name), `${name} is not in the guide`).toBe(true);
  });

  it('keeps secrets out of the text', () => {
    expect(text).not.toMatch(/password-\d|гость123|token=|apiKey/i);
  });
});
