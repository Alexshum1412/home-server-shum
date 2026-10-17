/**
 * Moving files in and out of the family storage without the browser (the second way next to the
 * «Файлы» and «Фото» pages): a folder on this PC — a USB stick, a phone connected by cable, a
 * downloaded archive — is copied in, and a space is copied out to a folder.
 *
 * Imports go through the same storage code as web uploads, so the same rules apply: no programs,
 * photos only if the content is really a picture or a video, names made safe, free space kept.
 * Nothing is ever deleted: the source of an import stays where it was.
 */
import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants, promises as fsp, type Stats } from 'node:fs';
import path from 'node:path';
import type { StorageRoot, StorageSpace } from '../../../shared/api.ts';
import { isBlockedName, sanitizeName } from './names.ts';
import { type Storage, StorageError } from './storage.ts';

export interface ImportOptions {
  storage: Storage;
  username: string;
  root: StorageRoot;
  space: StorageSpace;
  /** Folder on this PC to read from. */
  source: string;
  /** Files: folder inside the space to put the content into ('' = the top). Photos ignore it. */
  to?: string;
  /** Only report what would happen. */
  dryRun?: boolean;
  onItem?: (line: string) => void;
}

export interface ImportReport {
  imported: number;
  bytes: number;
  /** Same name and size already in place — left alone, so a repeated import adds nothing. */
  existing: number;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; reason: string }>;
}

const JUNK = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Same size is not enough: an edited file of the same length must not be mistaken for the copy already there. */
async function sameContent(a: string, b: string): Promise<boolean> {
  return (await sha256(a)) === (await sha256(b));
}

/** "2026-10" from the file's own date, like the browser does for photos. */
export function monthOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}`;
}

function describe(error: unknown): string {
  if (error instanceof StorageError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'нет доступа к файлу';
  if (code === 'EBUSY') return 'файл занят другой программой';
  return error instanceof Error ? error.message : String(error);
}

async function isDirectory(target: string): Promise<boolean> {
  return fsp.stat(target).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** Copies the content of a folder into the storage. Never throws for a single bad file. */
export async function importFolder(options: ImportOptions): Promise<ImportReport> {
  const { storage, username, root, space } = options;
  const report: ImportReport = { imported: 0, bytes: 0, existing: 0, skipped: [], failed: [] };
  const source = path.resolve(options.source);
  if (!(await isDirectory(source))) throw new Error(`Папка «${options.source}» не найдена.`);
  const spaceDir = storage.spaceDir(root, space, username);
  const note = options.onItem ?? (() => undefined);

  /** Makes sure a folder exists inside the space and returns its (safe) path. */
  async function ensureFolder(parent: string, rawName: string): Promise<string | null> {
    const name = sanitizeName(rawName);
    if (!name || name.startsWith('.')) return null;
    const rel = parent === '' ? name : `${parent}/${name}`;
    if (options.dryRun) return rel;
    try {
      await storage.mkdir({ root, space, path: parent }, username, name);
    } catch (error) {
      const exists = error instanceof StorageError && error.code === 'exists';
      if (!exists || !(await isDirectory(path.join(spaceDir, ...rel.split('/'))))) throw error;
    }
    return rel;
  }

  async function ensurePath(rel: string): Promise<string | null> {
    let current = '';
    for (const part of rel.split('/').filter((p) => p !== '')) {
      const next = await ensureFolder(current, part);
      if (next === null) return null;
      current = next;
    }
    return current;
  }

  async function importFile(file: string, stat: Stats, destFolder: string): Promise<void> {
    const raw = path.basename(file);
    const name = sanitizeName(raw);
    if (!name || name.startsWith('.')) {
      report.skipped.push({ name: raw, reason: 'недопустимое имя' });
      return;
    }
    if (isBlockedName(name)) {
      report.skipped.push({ name: raw, reason: 'программы и скрипты не сохраняются' });
      return;
    }
    const folder = await ensurePath(destFolder);
    if (folder === null) {
      report.skipped.push({ name: raw, reason: 'недопустимое имя папки' });
      return;
    }
    const target = path.join(spaceDir, ...folder.split('/').filter((p) => p !== ''), name);
    const present = await fsp.stat(target).catch(() => null);
    if (present?.isFile() && present.size === stat.size && (await sameContent(file, target))) {
      report.existing += 1;
      return;
    }
    if (options.dryRun) {
      report.imported += 1;
      report.bytes += stat.size;
      note(`будет добавлен: ${folder ? `${folder}/` : ''}${name}`);
      return;
    }
    try {
      const saved = await storage.upload(
        { root, space, path: folder },
        username,
        name,
        stat.size,
        createReadStream(file),
      );
      report.imported += 1;
      report.bytes += saved.sizeBytes;
      note(`добавлен: ${folder ? `${folder}/` : ''}${saved.name}`);
    } catch (error) {
      const refused =
        error instanceof StorageError && (error.code === 'blocked_type' || error.code === 'not_media');
      (refused ? report.skipped : report.failed).push({ name: raw, reason: describe(error) });
    }
  }

  async function walk(dir: string, rel: string): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch (error) {
      report.failed.push({ name: rel || '.', reason: describe(error) });
      return;
    }
    for (const name of names.sort((a, b) => a.localeCompare(b, 'ru'))) {
      if (name.startsWith('.') || JUNK.has(name.toLowerCase())) continue;
      const full = path.join(dir, name);
      const stat = await fsp.lstat(full).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(full, rel === '' ? name : `${rel}/${name}`);
      } else if (stat.isFile()) {
        // Photos are filed by month (flat); files keep the structure of the source folder.
        const destFolder =
          root === 'photos' ? monthOf(stat.mtime) : [options.to ?? '', rel].filter((p) => p !== '').join('/');
        await importFile(full, stat, destFolder);
      }
    }
  }

  await walk(source, '');
  return report;
}

export interface ExportOptions {
  storage: Storage;
  username: string;
  root: StorageRoot;
  space: StorageSpace;
  /** Folder inside the space to copy ('' = everything). */
  from?: string;
  /** New or empty folder to copy into. */
  destination: string;
  onItem?: (line: string) => void;
}

export interface ExportReport {
  files: number;
  bytes: number;
  failed: Array<{ name: string; reason: string }>;
}

/** Copies a space (or a folder of it) out to an empty folder; the trash and hidden items stay behind. */
export async function exportSpace(options: ExportOptions): Promise<ExportReport> {
  const { storage, username, root, space } = options;
  const spaceDir = storage.spaceDir(root, space, username);
  const parts = (options.from ?? '').split(/[\\/]+/).filter((p) => p !== '');
  for (const part of parts) {
    if (part === '.' || part === '..' || sanitizeName(part) !== part) {
      throw new Error('Недопустимый путь папки: --from.');
    }
  }
  const sourceDir = path.join(spaceDir, ...parts);
  if (!(await isDirectory(sourceDir))) throw new Error('Такой папки в хранилище нет.');
  const realSource = await fsp.realpath(sourceDir);
  const realSpace = await fsp.realpath(spaceDir);
  const rel = path.relative(realSpace, realSource);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Эта папка находится вне хранилища.');

  const destination = path.resolve(options.destination);
  const existing = await fsp.readdir(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null && existing.length > 0) {
    throw new Error(`Папка «${options.destination}» не пустая. Укажите новую или пустую папку.`);
  }
  const insideSource = path.relative(realSource, path.resolve(destination));
  if (insideSource === '' || (!insideSource.startsWith('..') && !path.isAbsolute(insideSource))) {
    throw new Error('Папка назначения не может быть внутри копируемой папки.');
  }
  await fsp.mkdir(destination, { recursive: true });

  const report: ExportReport = { files: 0, bytes: 0, failed: [] };
  const note = options.onItem ?? (() => undefined);

  async function walk(from: string, to: string, shown: string): Promise<void> {
    await fsp.mkdir(to, { recursive: true });
    for (const name of (await fsp.readdir(from)).sort((a, b) => a.localeCompare(b, 'ru'))) {
      if (name.startsWith('.')) continue;
      const source = path.join(from, name);
      const target = path.join(to, name);
      const label = shown === '' ? name : `${shown}/${name}`;
      const stat = await fsp.lstat(source).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(source, target, label);
      } else if (stat.isFile()) {
        try {
          await fsp.copyFile(source, target, fsConstants.COPYFILE_EXCL);
          report.files += 1;
          report.bytes += stat.size;
          note(`скопирован: ${label}`);
        } catch (error) {
          report.failed.push({ name: label, reason: describe(error) });
        }
      }
    }
  }

  await walk(sourceDir, destination, '');
  return report;
}
