/**
 * File and folder names that are safe on Windows and inside the family storage: no path
 * separators, no reserved device names, no alternate data streams, no trailing dots or spaces.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const NAME_MAX = 150;

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
const FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/**
 * Programs and scripts are never stored through the portal: they could run on the PC (or on a
 * relative's PC after download) with one double click. Media, documents and archives are fine.
 */
const BLOCKED_EXTENSIONS = new Set([
  'exe',
  'msi',
  'msp',
  'msix',
  'appx',
  'appxbundle',
  'bat',
  'cmd',
  'com',
  'scr',
  'pif',
  'cpl',
  'msc',
  'ps1',
  'psm1',
  'psd1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'lnk',
  'url',
  'scf',
  'reg',
  'inf',
  'jar',
  'dll',
  'sys',
  'drv',
  'ocx',
  'application',
  'gadget',
  'settingcontent-ms',
  'library-ms',
]);

/** Normalised safe name, or null when nothing usable is left (e.g. only dots). */
export function sanitizeName(raw: string): string | null {
  let name = raw.normalize('NFC').replace(FORBIDDEN_CHARS, '_').trim();
  // Trailing dots/spaces are silently dropped by Windows and can alias another file.
  name = name.replace(/[. ]+$/g, '');
  if (name === '' || name === '.' || name === '..') return null;
  if (RESERVED.test(name)) name = `_${name}`;
  if (Array.from(name).length > NAME_MAX) {
    const ext = path.extname(name).slice(0, 16);
    const base = Array.from(name.slice(0, name.length - ext.length))
      .slice(0, NAME_MAX - ext.length)
      .join('');
    name = `${base}${ext}`;
  }
  return name;
}

export function extensionOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : '';
}

export function isBlockedName(name: string): boolean {
  // "film.mp4.exe" and "photo.jpg .exe" both end in a program extension.
  return BLOCKED_EXTENSIONS.has(extensionOf(name.trim()));
}

export const BLOCKED_TYPE_MESSAGE =
  'Программы и скрипты (.exe, .msi, .bat, .ps1, .js и т. п.) через портал не сохраняются — это защита компьютера.';

/** "name.ext", "name (2).ext", ... — the first name that does not exist in `dir`. */
export async function uniqueName(
  dir: string,
  name: string,
  reserved: ReadonlySet<string> = new Set(),
): Promise<string> {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = i === 1 ? name : `${base} (${i})${ext}`;
    if (reserved.has(candidate.toLowerCase())) continue;
    try {
      await fsp.lstat(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
  throw new Error('Не удалось подобрать свободное имя файла');
}

/**
 * Resolves `relative` inside `root` and refuses anything that escapes it (`..`, absolute paths,
 * drive letters, alternate data streams). Returns null when the path is not acceptable.
 */
export function resolveInside(root: string, relative: string): string | null {
  const parts = relative.split(/[\\/]+/).filter((p) => p !== '');
  const clean: string[] = [];
  for (const part of parts) {
    const safe = sanitizeName(part);
    if (safe === null || safe !== part) return null;
    clean.push(safe);
  }
  const full = path.resolve(root, ...clean);
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}
