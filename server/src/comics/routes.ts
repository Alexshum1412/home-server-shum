/**
 * «Комиксы и манга»: a reader of the family's own comics inside the portal (so it works from a phone on any network the
 * portal works on). .cbz/.zip archives of pictures are read page by page; .pdf files open in the browser's own viewer.
 * Files are put into one folder on this PC; nothing is uploaded or converted.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';
import { readZipEntries, readZipEntry, type ZipEntry } from './zip.ts';

export interface ComicBook {
  id: string;
  title: string;
  kind: 'cbz' | 'pdf';
  folder: string;
  sizeBytes: number;
}

const BOOK_EXT = new Set(['.cbz', '.zip', '.pdf']);
const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

export const comicsDir = (env: NodeJS.ProcessEnv): string =>
  env.COMICS_DIR?.trim() ||
  `${/^[A-Za-z]:$/.test(env.LIBRARY_DRIVE ?? '') ? env.LIBRARY_DRIVE : 'D:'}\\FamilyData\\Комиксы и манга`;

const encodeId = (relative: string) => Buffer.from(relative, 'utf8').toString('base64url');

/** A book id is the path inside the folder; it never leaves the folder and never names anything but a book. */
export function resolveBook(dir: string, id: string): { file: string; relative: string } | null {
  let relative: string;
  try {
    relative = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (relative === '' || relative.includes('\0')) return null;
  const root = path.resolve(dir);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) return null;
  if (!BOOK_EXT.has(path.extname(file).toLowerCase())) return null;
  return { file, relative };
}

export async function listComics(dir: string): Promise<ComicBook[]> {
  const books: ComicBook[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    const items = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        if (depth < 3) await walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(item.name).toLowerCase();
      if (!item.isFile() || !BOOK_EXT.has(ext)) continue;
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      const relative = path.relative(dir, full);
      books.push({
        id: encodeId(relative),
        title: path.basename(item.name, ext),
        kind: ext === '.pdf' ? 'pdf' : 'cbz',
        folder: path.dirname(relative) === '.' ? '' : path.dirname(relative),
        sizeBytes: info.size,
      });
    }
  }
  await walk(path.resolve(dir), 0);
  return books.sort((a, b) =>
    `${a.folder}/${a.title}`.localeCompare(`${b.folder}/${b.title}`, 'ru', { numeric: true }),
  );
}

export function registerComicsRoutes(app: FastifyInstance, deps: { guards: Guards; dir: string }): void {
  const { guards } = deps;
  const pagesCache = new Map<string, { mtime: number; pages: ZipEntry[] }>();

  async function pagesOf(file: string): Promise<ZipEntry[]> {
    const info = await stat(file);
    const cached = pagesCache.get(file);
    if (cached && cached.mtime === info.mtimeMs) return cached.pages;
    const pages = (await readZipEntries(file))
      .filter(
        (entry) =>
          IMAGE_TYPES[path.extname(entry.name).toLowerCase()] && !/(^|\/)(__MACOSX|\.)/.test(entry.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    pagesCache.set(file, { mtime: info.mtimeMs, pages });
    return pages;
  }

  app.get('/api/comics', { preHandler: guards.requireUser }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ folder: deps.dir, books: await listComics(deps.dir) }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/comics/:id/pages',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const book = resolveBook(deps.dir, request.params.id);
      if (!book || path.extname(book.file).toLowerCase() === '.pdf') {
        return sendError(reply, 404, 'not_found', 'Книга не найдена.');
      }
      try {
        const pages = await pagesOf(book.file);
        return reply.header('cache-control', 'no-store').send({ pages: pages.length });
      } catch {
        return sendError(
          reply,
          422,
          'unreadable',
          'Этот файл не открывается: он повреждён или не является архивом.',
        );
      }
    },
  );

  app.get<{ Params: { id: string; n: string } }>(
    '/api/comics/:id/page/:n',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const book = resolveBook(deps.dir, request.params.id);
      const n = Number(request.params.n);
      if (!book || !Number.isInteger(n) || n < 0)
        return sendError(reply, 404, 'not_found', 'Страница не найдена.');
      try {
        const entry = (await pagesOf(book.file))[n];
        if (!entry) return sendError(reply, 404, 'not_found', 'Страница не найдена.');
        const bytes = await readZipEntry(book.file, entry);
        return reply
          .header('cache-control', 'private, max-age=3600')
          .type(IMAGE_TYPES[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream')
          .send(bytes);
      } catch {
        return sendError(reply, 422, 'unreadable', 'Страница не читается.');
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/comics/:id/file',
    { preHandler: guards.requireUser },
    async (request, reply) => {
      const book = resolveBook(deps.dir, request.params.id);
      if (!book || path.extname(book.file).toLowerCase() !== '.pdf') {
        return sendError(reply, 404, 'not_found', 'Файл не найден.');
      }
      const info = await stat(book.file).catch(() => null);
      if (!info) return sendError(reply, 404, 'not_found', 'Файл не найден.');
      return reply
        .header('cache-control', 'private, max-age=600')
        .header('content-length', info.size)
        .type('application/pdf')
        .send(createReadStream(book.file));
    },
  );
}
