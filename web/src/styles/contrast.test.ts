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

/**
 * Dark is the default `:root` block; light is the first prefers-color-scheme: light block.
 * Each theme is read on its own (no fallback), so a token missing from one theme fails the test.
 */
function themes(css: string): { dark: Theme; light: Theme } {
  const lightStart = css.indexOf('@media (prefers-color-scheme: light)');
  expect(lightStart).toBeGreaterThan(0);
  const dark = tokens(css.slice(0, lightStart));
  const light = tokens(css.slice(lightStart, css.indexOf('@media', lightStart + 1)));
  return { dark, light };
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

describe('form field outline (WCAG 1.4.11, ≥ 3:1)', () => {
  it('the input border token is distinguishable from the field and the form in both themes', async () => {
    const all = themes(await readCss('./tokens.css'));
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
