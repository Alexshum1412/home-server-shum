/**
 * Plex next to Jellyfin: the state of the Plex Media Server on this PC and its libraries, for the page «Plex» of the
 * portal. The server's own sign-in token is read from the Windows registry of this PC, used only for requests to Plex on
 * this same PC and never sent to a browser.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { Guards } from '../auth/guards.ts';

export const PLEX_PORT = 32400;

export interface PlexLibrary {
  title: string;
  type: string;
  count: number | null;
}

export interface PlexState {
  running: boolean;
  claimed: boolean | null;
  version: string | null;
  libraries: PlexLibrary[];
  /** Why the libraries are not shown (no sign-in on this PC, Plex stopped). */
  note: string | null;
  lanUrl: string | null;
}

function readToken(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Plex, Inc.\\Plex Media Server', '/v', 'PlexOnlineToken'],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        const match = /PlexOnlineToken\s+REG_SZ\s+(\S+)/.exec(stdout);
        resolve(error || !match ? null : (match[1] ?? null));
      },
    );
  });
}

export function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (
        item.family === 'IPv4' &&
        !item.internal &&
        /^(192\.168\.|10\.(?!255\.)|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)
      )
        return item.address;
    }
  }
  return null;
}

export function createPlex(options: { fetch?: typeof fetch } = {}) {
  const doFetch = options.fetch ?? fetch;
  let cache: { at: number; state: PlexState } | null = null;

  async function load(): Promise<PlexState> {
    const lan = lanAddress();
    const base: PlexState = {
      running: false,
      claimed: null,
      version: null,
      libraries: [],
      note: null,
      lanUrl: lan ? `http://${lan}:${PLEX_PORT}/web` : null,
    };
    try {
      const identity = await doFetch(`http://127.0.0.1:${PLEX_PORT}/identity`, {
        signal: AbortSignal.timeout(4000),
        headers: { accept: 'application/json' },
      });
      if (!identity.ok) return { ...base, note: 'Plex не отвечает.' };
      const body = (await identity.json()) as { MediaContainer?: { claimed?: boolean; version?: string } };
      base.running = true;
      base.claimed = body.MediaContainer?.claimed ?? null;
      base.version = body.MediaContainer?.version?.split('-')[0] ?? null;
    } catch {
      return {
        ...base,
        note: 'Plex не отвечает: программа Plex Media Server не запущена на этом компьютере.',
      };
    }
    const token = await readToken();
    if (!token)
      return { ...base, note: 'Список библиотек недоступен: на этом компьютере Plex не вошёл в аккаунт.' };
    try {
      const headers = { accept: 'application/json', 'X-Plex-Token': token };
      const sections = (await (
        await doFetch(`http://127.0.0.1:${PLEX_PORT}/library/sections`, {
          headers,
          signal: AbortSignal.timeout(6000),
        })
      ).json()) as { MediaContainer?: { Directory?: Array<{ key: string; title: string; type: string }> } };
      for (const section of sections.MediaContainer?.Directory ?? []) {
        let count: number | null = null;
        try {
          const all = (await (
            await doFetch(
              `http://127.0.0.1:${PLEX_PORT}/library/sections/${encodeURIComponent(section.key)}/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0`,
              {
                headers,
                signal: AbortSignal.timeout(6000),
              },
            )
          ).json()) as { MediaContainer?: { totalSize?: number } };
          count = all.MediaContainer?.totalSize ?? null;
        } catch {
          count = null;
        }
        base.libraries.push({ title: section.title, type: section.type, count });
      }
    } catch {
      base.note = 'Список библиотек Plex прочитать не удалось.';
    }
    return base;
  }

  return {
    async state(): Promise<PlexState> {
      if (cache && Date.now() - cache.at < 30_000) return cache.state;
      const state = await load();
      cache = { at: Date.now(), state };
      return state;
    },
  };
}

export type Plex = ReturnType<typeof createPlex>;

export function registerPlexRoutes(app: FastifyInstance, deps: { guards: Guards; plex: Plex }): void {
  app.get('/api/plex', { preHandler: deps.guards.requireUser }, async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(await deps.plex.state()),
  );
}
