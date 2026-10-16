/**
 * Renders the app icons for «Семейный сервер» from one SVG drawing:
 *   web/public/icons/icon.svg               — rounded icon (favicon, manifest "any")
 *   web/public/icons/apple-touch-icon.png   — 180×180, full bleed (iOS masks it itself)
 *   web/public/icons/icon-192.png / -512    — full bleed, manifest "any"
 *   web/public/icons/icon-maskable-512.png  — drawing inside the 80 % safe zone, manifest "maskable"
 *
 * Uses the locally installed Google Chrome through Playwright (channel 'chrome');
 * nothing is downloaded. Run: node scripts/generate-icons.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const outDir = fileURLToPath(new URL('../web/public/icons/', import.meta.url));

// Palette from web/src/styles/tokens.css (dark theme).
const BG = '#10151b';
const HOUSE = '#1f2833';
const OUTLINE = '#3d4a5a';
const GLOW = '#f3bc63';

interface Variant {
  /** Corner radius of the background square (0 = full bleed). */
  radius: number;
  /** Scale of the drawing around the centre (maskable icons need a safe zone). */
  scale: number;
}

/** A house silhouette with one warm, glowing window — the "screen" of the home cinema. */
function drawIcon({ radius, scale }: Variant): string {
  const transform = scale === 1 ? '' : ` transform="translate(256 256) scale(${scale}) translate(-256 -256)"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="light" cx="50%" cy="58%" r="50%">
      <stop offset="0" stop-color="${GLOW}" stop-opacity="0.42"/>
      <stop offset="0.55" stop-color="${GLOW}" stop-opacity="0.1"/>
      <stop offset="1" stop-color="${GLOW}" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="${radius}" fill="${BG}"/>
  <g${transform}>
    <circle cx="256" cy="300" r="236" fill="url(#light)"/>
    <path d="M256 104 L410 230 V388 Q410 412 386 412 H126 Q102 412 102 388 V230 Z"
      fill="${HOUSE}" stroke="${OUTLINE}" stroke-width="14" stroke-linejoin="round"/>
    <rect x="166" y="248" width="180" height="112" rx="16" fill="${GLOW}" opacity="0.75" filter="url(#blur)"/>
    <rect x="166" y="248" width="180" height="112" rx="16" fill="${GLOW}"/>
  </g>
</svg>
`;
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const rounded = drawIcon({ radius: 112, scale: 1 });
  const fullBleed = drawIcon({ radius: 0, scale: 1 });
  const maskable = drawIcon({ radius: 0, scale: 0.78 });
  await writeFile(`${outDir}icon.svg`, rounded, 'utf8');

  const targets: Array<{ file: string; size: number; svg: string }> = [
    { file: 'apple-touch-icon.png', size: 180, svg: fullBleed },
    { file: 'icon-192.png', size: 192, svg: fullBleed },
    { file: 'icon-512.png', size: 512, svg: fullBleed },
    { file: 'icon-maskable-512.png', size: 512, svg: maskable },
  ];

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const target of targets) {
      await page.setViewportSize({ width: target.size, height: target.size });
      const src = `data:image/svg+xml;base64,${Buffer.from(target.svg).toString('base64')}`;
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:${BG}">` +
          `<img src="${src}" width="${target.size}" height="${target.size}" style="display:block" alt=""></body></html>`,
      );
      await page.waitForFunction(() => {
        const img = document.querySelector('img');
        return img?.complete === true && img.naturalWidth > 0;
      });
      await page.screenshot({
        path: `${outDir}${target.file}`,
        omitBackground: false,
        clip: { x: 0, y: 0, width: target.size, height: target.size },
      });
      console.log(`icons: ${target.file} (${target.size}×${target.size})`);
    }
  } finally {
    await browser.close();
  }
}

await main();
