/**
 * Search of family files and photos by NAME (never by content), for «Оливия». It looks only where
 * the person may look: their own folder and the shared one, never another person's. Links and
 * junctions are not followed; the work is bounded so that a huge disk cannot hold the server.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { StorageSpace } from '../../../shared/api.ts';

export interface FoundFile {
  /** «files», «photos» or «media» (the media library, for the fallback search). */
  root: string;
  space: StorageSpace;
  /** Folder that contains it, relative to the space ('' = the top), forward slashes. */
  folder: string;
  name: string;
  isFolder: boolean;
  sizeBytes: number | null;
}

export interface SearchLimits {
  maxResults: number;
  maxVisited: number;
  maxDepth: number;
}

export const DEFAULT_LIMITS: SearchLimits = { maxResults: 20, maxVisited: 30_000, maxDepth: 7 };

/** «ё» and «е» are the same letter for a person who types a name. */
export const normalise = (text: string): string => text.normalize('NFC').toLowerCase().replace(/ё/g, 'е');

/**
 * The beginning of a Russian word, so that «дачи», «дача» and «на даче» find each other: the last
 * letters (the ending) are dropped from longer words. Short words stay as they are.
 */
export function stemOf(word: string): string {
  if (word.length >= 6) return word.slice(0, -2);
  if (word.length >= 4) return word.slice(0, -1);
  return word;
}

/** The stems of the words of a query (at most six). */
export function words(query: string): string[] {
  return normalise(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2)
    .map(stemOf)
    .slice(0, 6);
}

export async function searchNames(
  places: ReadonlyArray<{ root: string; space: StorageSpace; dir: string }>,
  query: string,
  limits: SearchLimits = DEFAULT_LIMITS,
): Promise<FoundFile[]> {
  const needed = words(query);
  if (needed.length === 0) return [];
  const found: FoundFile[] = [];
  let visited = 0;

  async function walk(place: (typeof places)[number], relative: string, depth: number): Promise<void> {
    if (found.length >= limits.maxResults || visited >= limits.maxVisited) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(path.join(place.dir, ...relative.split('/').filter(Boolean)), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limits.maxResults || visited >= limits.maxVisited) return;
      // Hidden items are the portal's own (trash, thumbnails, unfinished uploads) — not for a search.
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      visited += 1;
      const isFolder = entry.isDirectory();
      if (!isFolder && !entry.isFile()) continue;
      const lower = normalise(entry.name);
      if (needed.every((word) => lower.includes(word))) {
        let size: number | null = null;
        if (!isFolder)
          size =
            (
              await fsp
                .stat(path.join(place.dir, ...relative.split('/').filter(Boolean), entry.name))
                .catch(() => null)
            )?.size ?? null;
        found.push({
          root: place.root,
          space: place.space,
          folder: relative,
          name: entry.name,
          isFolder,
          sizeBytes: size,
        });
      }
      if (isFolder && depth < limits.maxDepth) {
        await walk(place, relative === '' ? entry.name : `${relative}/${entry.name}`, depth + 1);
      }
    }
  }

  for (const place of places) await walk(place, '', 0);
  return found;
}
