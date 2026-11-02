/**
 * The offline library: Wikipedia and other reference books downloaded to this PC (ZIM files) and shown by Kiwix, so that a
 * family can «google» them with no internet at all (a war, a disaster, a broken cable). Kiwix itself listens only on this
 * PC; the portal passes its pages to signed-in people (so the same sign-in, the same Tailscale, the same limits).
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Guards } from '../auth/guards.ts';
import { sendError } from '../lib/http.ts';

export const KIWIX_PORT = 8089;
export const KIWIX_ROOT = '/offline';

export interface LibraryBook {
  /** The name Kiwix knows the book by (the file name without the date). */
  name: string;
  file: string;
  title: string;
  sizeBytes: number;
  /** Still being downloaded (an .aria2 file lies next to it). */
  downloading: boolean;
}

const TITLES: Array<[RegExp, string]> = [
  [/^wikipedia_ru_all_maxi/, 'Википедия на русском (с картинками)'],
  [/^wikipedia_ru_all_nopic/, 'Википедия на русском (без картинок)'],
  [/^wikipedia_ru_all_mini/, 'Википедия на русском (краткая)'],
  [/^wikipedia_be/, 'Википедия на белорусском'],
  [/^wikipedia_en/, 'Википедия на английском'],
  [/^wiktionary_ru/, 'Викисловарь (русский)'],
  [/^wikivoyage_ru/, 'Викигид: путешествия'],
  [/^wikibooks_ru/, 'Викиучебник'],
  [/^wikipedia_ru_medicine/, 'Медицина (Википедия)'],
];

export const libraryDir = (env: NodeJS.ProcessEnv): string =>
  env.LIBRARY_DIR?.trim() ||
  `${/^[A-Za-z]:$/.test(env.LIBRARY_DRIVE ?? '') ? env.LIBRARY_DRIVE : 'D:'}\\FamilyData\\Офлайн-библиотека`;

export async function listBooks(dir: string): Promise<LibraryBook[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const books: LibraryBook[] = [];
  for (const file of names.filter((item) => item.toLowerCase().endsWith('.zim'))) {
    const info = await stat(path.join(dir, file)).catch(() => null);
    if (!info) continue;
    const name = file.replace(/\.zim$/i, '').replace(/_\d{4}-\d{2}$/, '');
    books.push({
      name,
      file,
      title: TITLES.find(([re]) => re.test(name))?.[1] ?? name,
      sizeBytes: info.size,
      downloading: names.includes(`${file}.aria2`),
    });
  }
  return books.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}

export function registerLibraryRoutes(
  app: FastifyInstance,
  deps: { guards: Guards; dir: string; serving: () => boolean; fetch?: typeof fetch },
): void {
  const { guards } = deps;
  const doFetch = deps.fetch ?? fetch;

  app.get('/api/library', { preHandler: guards.requireUser }, async (_request, reply) => {
    const books = await listBooks(deps.dir);
    return reply.header('cache-control', 'no-store').send({
      books,
      serving: deps.serving(),
      folder: deps.dir,
      root: KIWIX_ROOT,
    });
  });

  // Kiwix's own pages (search, articles, pictures) for signed-in people; nothing else of this PC is reachable through it.
  const pass = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!deps.serving()) {
      return sendError(
        reply,
        503,
        'unavailable',
        'Офлайн-библиотека сейчас не запущена: на странице «Сервер» запустите «Офлайн-библиотека (Kiwix)».',
      );
    }
    const target = `http://127.0.0.1:${KIWIX_PORT}${request.raw.url ?? KIWIX_ROOT}`;
    const headers: Record<string, string> = {};
    for (const name of ['range', 'if-none-match', 'accept', 'accept-language']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const aborter = new AbortController();
    reply.raw.on('close', () => aborter.abort());
    try {
      const upstream = await doFetch(target, { headers, redirect: 'manual', signal: aborter.signal });
      reply.code(upstream.status);
      for (const name of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'location',
        'cache-control',
      ]) {
        const value = upstream.headers.get(name);
        if (value) reply.header(name, value);
      }
      // Pages of the book may use scripts and styles of their own, but only from this address.
      reply.header(
        'Content-Security-Policy',
        "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'self'",
      );
      reply.header('X-Frame-Options', 'SAMEORIGIN');
      if (!upstream.body) return reply.send();
      return reply.send(Readable.fromWeb(upstream.body as never));
    } catch {
      if (aborter.signal.aborted) return reply;
      return sendError(reply, 502, 'bad_gateway', 'Офлайн-библиотека не ответила.');
    }
  };
  app.get(KIWIX_ROOT, { preHandler: guards.requireUser }, async (_request, reply) =>
    reply.redirect(`${KIWIX_ROOT}/`),
  );
  app.get(`${KIWIX_ROOT}/*`, { preHandler: guards.requireUser }, pass);
}
