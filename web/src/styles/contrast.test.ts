import { describe, expect, it } from 'vitest';

/**
 * Reads a stylesheet as text. Vitest blanks CSS imports (even `?raw`), so the file is read
 * from disk; `node:fs` is loaded dynamically to keep Node types out of the browser tsconfig.
 */
async function readCss(name: string): Promise<string> {
  const fsModule = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync(path: URL, encoding: 'utf8'): string;
  };
  return fs.readFileSync(new URL(name, import.meta.url), 'utf8');
}

type Theme = Record<string, string>;

/** Hex colour tokens (`--c-x: #rrggbb`) of a CSS block. */
function tokens(block: string): Theme {
  const result: Theme = {};
  for (const match of block.matchAll(/(--c-[\w-]+):\s*(#[0-9a-f]{6})\b/gi)) {
    const [, name, value] = match;
    if (name && value) result[name] = value;
  }
  return result;
}

/** The text of the `{ … }` block that follows `selector` (no nested blocks in tokens.css). */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `block «${selector}» in tokens.css`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

/**
 * Light is the default `:root` block, dark is `:root[data-theme="dark"]` and «as the device» repeats
 * the dark values under a media query. Each is read on its own (no fallback), so a token missing
 * from one theme fails the test.
 */
async function themes(): Promise<Record<'light' | 'dark' | 'system', Theme>> {
  const css = await readCss('./tokens.css');
  const mediaStart = css.indexOf('@media (prefers-color-scheme: dark)');
  expect(mediaStart).toBeGreaterThan(0);
  return {
    light: tokens(block(css, ':root')),
    dark: tokens(block(css, ':root[data-theme="dark"]')),
    system: tokens(block(css.slice(mediaStart), ':root[data-theme="system"]')),
  };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

const SURFACES = ['--c-bg', '--c-surface', '--c-surface-2'] as const;
const TEXT = ['--c-text', '--c-text-muted', '--c-text-subtle'] as const;
const STATUS = ['--c-ok', '--c-warn', '--c-bad', '--c-info', '--c-neutral'] as const;

describe('palette (owner: light theme, #f7f9fc, main button #216aca)', () => {
  it('uses the colours the owner chose in the light theme', async () => {
    const { light } = await themes();
    expect(light['--c-bg']).toBe('#f7f9fc');
    expect(light['--c-accent']).toBe('#216aca');
    expect(light['--c-accent-soft']).toBe('#4da3ff');
    expect(light['--c-on-accent']).toBe('#ffffff');
  });

  it('«as the device» is the dark theme under a media query, value for value', async () => {
    const { dark, system } = await themes();
    expect(system).toEqual(dark);
  });

  it.each(['light', 'dark'] as const)(
    '%s: every text colour is readable (≥ 4.5:1) on every surface',
    async (name) => {
      const theme = (await themes())[name];
      for (const text of [...TEXT, ...STATUS, '--c-accent']) {
        for (const surface of SURFACES) {
          const ratio = contrast(theme[text] ?? '#000000', theme[surface] ?? '#000000');
          expect(ratio, `${name}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

  it.each(['light', 'dark'] as const)(
    '%s: text on the main button stays readable, also on hover',
    async (name) => {
      const theme = (await themes())[name];
      for (const button of ['--c-accent', '--c-accent-hover']) {
        expect(
          contrast(theme['--c-on-accent'] ?? '#000000', theme[button] ?? '#000000'),
          `${name}: ${button}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(['light', 'dark'] as const)('%s: the focus ring is visible (≥ 3:1)', async (name) => {
    const theme = (await themes())[name];
    for (const surface of SURFACES) {
      expect(
        contrast(theme['--c-focus'] ?? '#000000', theme[surface] ?? '#000000'),
        `${name}: focus on ${surface}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('form field outline (WCAG 1.4.11, ≥ 3:1)', () => {
  it('the input border token is distinguishable from the field and the form in every theme', async () => {
    const all = await themes();
    for (const [name, theme] of Object.entries(all)) {
      const border = theme['--c-input-border'];
      expect(border, `${name}: --c-input-border`).toBeDefined();
      for (const background of ['--c-bg', '--c-surface']) {
        const ratio = contrast(border ?? '#000000', theme[background] ?? '#000000');
        expect(ratio, `${name}: --c-input-border on ${background}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('text fields use that token for their border', async () => {
    const css = await readCss('./components.css');
    const rule = /\.field__input\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/border:\s*1px solid var\(--c-input-border\)/);
  });
});
