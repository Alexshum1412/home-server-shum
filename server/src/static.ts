import { promises as fsp } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { REPO_ROOT } from './lib/version.ts';

export const DEFAULT_WEB_ROOT = path.join(REPO_ROOT, 'dist', 'web');

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Shown when dist/web has not been built yet. No inline styles/scripts (CSP: 'self' only). */
const NOT_BUILT_PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Семейный сервер — интерфейс не собран</title>
</head>
<body>
<main>
<h1>Семейный сервер</h1>
<p>Интерфейс ещё не собран. Выполните: npm.cmd run build</p>
<p>Сервер и API работают — после сборки обновите эту страницу.</p>
</main>
</body>
</html>
`;

/** /assets/* are content-hashed by Vite → cache forever; everything else is revalidated. */
export function cacheControlFor(webRoot: string, filePath: string): string {
  const relative = path.relative(webRoot, filePath).split(path.sep).join('/');
  return relative.startsWith('assets/') ? IMMUTABLE : 'no-cache';
}

export async function registerStatic(app: FastifyInstance, webRoot: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: webRoot,
    wildcard: true,
    index: ['index.html'],
    cacheControl: false,
    dotfiles: 'ignore',
    suppressWarning: true,
    setHeaders(reply, filePath) {
      reply.header('Cache-Control', cacheControlFor(webRoot, filePath));
    },
  });
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * GET for a path without a file: return the app shell so deep links (/system, /admin) work.
 * Missing assets (/assets/*, or anything that looks like a file name) stay 404 so a stale
 * bundle reference never receives HTML with an immutable cache header.
 */
export async function sendSpaFallback(
  request: FastifyRequest,
  reply: FastifyReply,
  webRoot: string,
  pathname: string,
): Promise<FastifyReply> {
  const looksLikeFile = /\.[a-z0-9]{1,10}$/i.test(path.posix.basename(pathname));
  if (pathname.startsWith('/assets/') || looksLikeFile) {
    return reply.code(404).type('text/plain; charset=utf-8').send('Файл не найден');
  }
  if (await isFile(path.join(webRoot, 'index.html'))) {
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html', webRoot);
  }
  request.log.warn({ webRoot }, 'Интерфейс не собран: нет index.html');
  return reply
    .code(503)
    .type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(NOT_BUILT_PAGE);
}
