/**
 * Text from a photo or a scan (Tesseract on this PC). The program is started with fixed arguments: the only things that
 * come from outside are the bytes of the picture (written to a temporary file with a name made here) and nothing else.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface OcrPaths {
  exe: string;
  tessdata: string;
}

export function ocrPaths(env: NodeJS.ProcessEnv): OcrPaths {
  const drive = /^[A-Za-z]:$/.test(env.SystemDrive ?? '') ? (env.SystemDrive as string) : 'C:';
  return {
    exe: env.OCR_EXE?.trim() || 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    tessdata: env.OCR_TESSDATA?.trim() || `${drive}\\FamilyServer\\data\\tessdata`,
  };
}

export const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff?|gif)$/i;

export function createOcr(paths: OcrPaths) {
  const available = () => existsSync(paths.exe) && existsSync(paths.tessdata);
  return {
    available,
    /** Recognised text of a picture (Russian, English, German, Belarusian, Polish), or null when nothing was read. */
    async read(bytes: Buffer, ext: string): Promise<string | null> {
      if (!available() || bytes.length === 0 || bytes.length > 25 * 1024 * 1024) return null;
      const safeExt = IMAGE_EXT.test(`x${ext}`) ? ext.toLowerCase() : '.png';
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ocr-'));
      try {
        const file = path.join(dir, `scan${safeExt}`);
        await writeFile(file, bytes);
        const out = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            paths.exe,
            [file, 'stdout', '--tessdata-dir', paths.tessdata, '-l', 'rus+eng+deu+bel+pol', '--psm', '3'],
            { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          );
          child.on('error', reject);
        });
        const text = out
          .replace(/\r/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        return text.length >= 3 ? text.slice(0, 50_000) : null;
      } catch {
        return null;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export type Ocr = ReturnType<typeof createOcr>;
