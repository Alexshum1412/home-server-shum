/**
 * An HTML page into a picture (PNG) and a document (PDF) with the headless Chrome that is installed on this PC. The page is
 * made here from numbers of the portal (nothing comes from outside), written to a temporary file, opened with a private
 * temporary profile and deleted afterwards.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface RendererPaths {
  chrome: string;
}

export function rendererPaths(env: NodeJS.ProcessEnv): RendererPaths {
  const candidates = [
    env.REPORT_CHROME?.trim() ?? '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return { chrome: candidates.find((item) => item !== '' && existsSync(item)) ?? '' };
}

function run(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(exe, args, { timeout: 60_000, windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
    child.on('error', reject);
  });
}

export function createRenderer(paths: RendererPaths) {
  const available = () => paths.chrome !== '';
  async function shot(htmlFile: string, profile: string, width: number, height: number, out: string) {
    await run(paths.chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--disable-extensions',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--virtual-time-budget=3000',
      `--screenshot=${out}`,
      pathToFileURL(htmlFile).toString(),
    ]);
  }
  async function pdf(htmlFile: string, profile: string, out: string) {
    await run(paths.chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=3000',
      '--no-pdf-header-footer',
      `--print-to-pdf=${out}`,
      pathToFileURL(htmlFile).toString(),
    ]);
  }
  return {
    available,
    /** The page as a picture and as a one-page document of the same size. Null when Chrome is not there or fails. */
    async render(html: string, width: number, height: number): Promise<{ png: Buffer; pdf: Buffer } | null> {
      if (!available()) return null;
      const dir = await mkdtemp(path.join(os.tmpdir(), 'report-'));
      try {
        const file = path.join(dir, 'report.html');
        await writeFile(file, html, 'utf8');
        const png = path.join(dir, 'report.png');
        const doc = path.join(dir, 'report.pdf');
        await shot(file, path.join(dir, 'p1'), width, height, png);
        await pdf(file, path.join(dir, 'p2'), doc);
        return { png: await readFile(png), pdf: await readFile(doc) };
      } catch {
        return null;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export type Renderer = ReturnType<typeof createRenderer>;
