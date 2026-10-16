/**
 * Renders the app icons for «Семейный сервер» from one SVG drawing: a dark house
 * at dusk with one warm, glowing window — the "screen" of the home cinema.
 *
 *   web/public/icons/icon.svg               — rounded square (favicon, header logo, manifest "any")
 *   web/public/icons/favicon-32.png         — 32×32, simplified drawing for tabs and bookmarks
 *   web/public/icons/apple-touch-icon.png   — 180×180, opaque full bleed (iOS rounds the corners itself)
 *   web/public/icons/icon-192.png / -512    — rounded square with transparent corners, manifest "any"
 *   web/public/icons/icon-maskable-512.png  — full-bleed background, drawing inside the 80 % safe zone
 *
 * Uses the locally installed Google Chrome through Playwright (channel 'chrome');
 * nothing is downloaded. Run: node scripts/generate-icons.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const outDir = fileURLToPath(new URL('../web/public/icons/', import.meta.url));

// Palette from web/src/styles/tokens.css (dark theme).
const BG = '#10151b'; // --c-bg
const WALL = '#1f2833'; // --c-surface-2
const OUTLINE = '#3d4a5a'; // --c-border-strong
const GLOW = '#f3bc63'; // --c-accent
const GLOW_HI = '#f7cd86'; // --c-accent-hover
/** The wall right behind the window: --c-surface-2 mixed with 18 % of the accent (lit room). */
const WALL_LIT = '#49463f';

interface Variant {
  /** Corner radius of the background square on the 512 grid (0 = full bleed). */
  radius: number;
  /** Scale of the drawing around the centre (maskable icons need a safe zone). */
  scale: number;
  /** Small sizes (≤ 48 px): thicker outline, bigger window, no soft halo. */
  small: boolean;
}

/** House: roof apex, eaves and a slightly rounded base; the window is the cinema screen. */
function drawIcon({ radius, scale, small }: Variant): string {
  const transform = scale === 1 ? '' : ` transform="translate(256 256) scale(${scale}) translate(-256 -256)"`;
  const house = small
    ? 'M256 72 L448 228 V412 Q448 440 420 440 H92 Q64 440 64 412 V228 Z'
    : 'M256 92 L428 232 V400 Q428 424 404 424 H108 Q84 424 84 400 V232 Z';
  const stroke = small ? 28 : 16;
  const win = small ? { x: 136, y: 248, w: 240, h: 136, r: 18 } : { x: 160, y: 262, w: 192, h: 112, r: 14 };
  const halo = small
    ? ''
    : `<rect width="512" height="512" fill="url(#halo)"/>
    `;
  const blur = small
    ? ''
    : `<rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" rx="${win.r}" fill="${GLOW}" opacity="0.85" filter="url(#blur)"/>
    `;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>Семейный сервер</title>
  <defs>
    <clipPath id="tile"><rect width="512" height="512" rx="${radius}"/></clipPath>
    <radialGradient id="halo" cx="256" cy="318" r="300" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${GLOW}" stop-opacity="0.22"/>
      <stop offset="0.45" stop-color="${GLOW}" stop-opacity="0.06"/>
      <stop offset="1" stop-color="${GLOW}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="room" cx="256" cy="${win.y + win.h / 2}" r="230" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${WALL_LIT}"/>
      <stop offset="1" stop-color="${WALL}"/>
    </radialGradient>
    <linearGradient id="screen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${GLOW_HI}"/>
      <stop offset="1" stop-color="${GLOW}"/>
    </linearGradient>
    <filter id="blur" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>
  </defs>
  <g clip-path="url(#tile)">
    <rect width="512" height="512" fill="${BG}"/>
    ${halo}<g${transform}>
      <path d="${house}" fill="url(#room)" stroke="${OUTLINE}" stroke-width="${stroke}" stroke-linejoin="round"/>
      ${blur}<rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" rx="${win.r}" fill="url(#screen)"/>
    </g>
  </g>
</svg>
`;
}

interface Target {
  file: string;
  size: number;
  svg: string;
  /** Keep transparent corners (rounded icons); false paints the background colour under them. */
  transparent: boolean;
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const rounded = drawIcon({ radius: 112, scale: 1, small: false });
  const roundedSmall = drawIcon({ radius: 112, scale: 1, small: true });
  const fullBleed = drawIcon({ radius: 0, scale: 1, small: false });
  // Safe zone = circle with radius 0.4 × size; the house corners stay inside it at 0.8.
  const maskable = drawIcon({ radius: 0, scale: 0.8, small: false });
  await writeFile(`${outDir}icon.svg`, rounded, 'utf8');
  console.log('icons: icon.svg');

  const targets: Target[] = [
    { file: 'favicon-32.png', size: 32, svg: roundedSmall, transparent: true },
    { file: 'apple-touch-icon.png', size: 180, svg: fullBleed, transparent: false },
    { file: 'icon-192.png', size: 192, svg: rounded, transparent: true },
    { file: 'icon-512.png', size: 512, svg: rounded, transparent: true },
    { file: 'icon-maskable-512.png', size: 512, svg: maskable, transparent: false },
  ];

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const target of targets) {
      await page.setViewportSize({ width: target.size, height: target.size });
      const src = `data:image/svg+xml;base64,${Buffer.from(target.svg).toString('base64')}`;
      const background = target.transparent ? 'transparent' : BG;
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:${background}">` +
          `<img src="${src}" width="${target.size}" height="${target.size}" style="display:block" alt=""></body></html>`,
      );
      await page.waitForFunction(() => {
        const img = document.querySelector('img');
        return img?.complete === true && img.naturalWidth > 0;
      });
      await page.screenshot({
        path: `${outDir}${target.file}`,
        omitBackground: target.transparent,
        clip: { x: 0, y: 0, width: target.size, height: target.size },
      });
      console.log(`icons: ${target.file} (${target.size}×${target.size})`);
    }
  } finally {
    await browser.close();
  }
}

await main();
