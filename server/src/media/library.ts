/**
 * The family media library as plain files (films, series, music, audiobooks): a read-only view of
 * MEDIA_DIR for the built-in fallback player, used when Jellyfin is stopped or broken.
 *
 * Nothing here converts, indexes or changes anything. Only audio and video files that a browser can
 * play are listed; every path is checked inside the library, also after following links.
 */
import { createReadStream, promises as fsp, type Stats } from 'node:fs';
import path from 'node:path';
import type { MediaEntry, MediaKind } from '../../../shared/api.ts';

export class MediaError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const VIDEO: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};
const AUDIO: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

export function mediaTypeOf(name: string): { kind: MediaKind; mime: string } | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  const video = VIDEO[ext];
  if (video) return { kind: 'video', mime: video };
  const audio = AUDIO[ext];
  if (audio) return { kind: 'audio', mime: audio };
  return null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused
const BAD_SEGMENT = /[\u0000-\u001f\u007f:<>"|?*]/;
const PATH_MAX = 600;

export interface MediaLibrary {
  readonly root: string;
  /** False with a reason when the folder does not exist or cannot be read. */
  status(): Promise<{ available: boolean; reason: string | null }>;
  list(relative: string): Promise<MediaEntry[]>;
  open(relative: string): Promise<{ file: string; stat: Stats; mime: string; name: string }>;
  stream: typeof createReadStream;
}

export function createMediaLibrary(root: string): MediaLibrary {
  function segments(relative: string): string[] {
    if (relative.length > PATH_MAX) throw new MediaError(400, 'bad_path', 'Слишком длинный путь.');
    const parts = relative.split(/[\\/]+/).filter((part) => part !== '');
    for (const part of parts) {
      if (part === '.' || part === '..' || BAD_SEGMENT.test(part) || /[. ]$/.test(part)) {
        throw new MediaError(400, 'bad_path', 'Недопустимое имя в пути.');
      }
    }
    return parts;
  }

  /** Absolute path inside the library; refuses anything that leaves it, also through links. */
  async function resolve(relative: string): Promise<string> {
    const full = path.join(root, ...segments(relative));
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(root);
    } catch {
      throw new MediaError(404, 'no_library', 'Папка с фильмами и музыкой на сервере не найдена.');
    }
    let real: string;
    try {
      real = await fsp.realpath(full);
    } catch {
      throw new MediaError(404, 'not_found', 'Такого файла или папки нет.');
    }
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new MediaError(403, 'outside', 'Доступ к этому месту запрещён.');
    }
    return real;
  }

  return {
    root,
    async status() {
      try {
        const stat = await fsp.stat(root);
        if (!stat.isDirectory()) return { available: false, reason: 'Папка медиатеки не найдена.' };
        await fsp.readdir(root);
        return { available: true, reason: null };
      } catch {
        return {
          available: false,
          reason: 'Папка с фильмами и музыкой на сервере не найдена или недоступна.',
        };
      }
    },

    async list(relative) {
      const dir = await resolve(relative);
      const stat = await fsp.stat(dir);
      if (!stat.isDirectory()) throw new MediaError(400, 'not_a_folder', 'Это не папка.');
      const entries: MediaEntry[] = [];
      for (const name of await fsp.readdir(dir)) {
        if (name.startsWith('.')) continue;
        try {
          const s = await fsp.lstat(path.join(dir, name));
          if (s.isSymbolicLink()) continue;
          if (s.isDirectory()) {
            entries.push({
              name,
              type: 'dir',
              kind: null,
              sizeBytes: null,
              modifiedAt: s.mtime.toISOString(),
            });
          } else if (s.isFile()) {
            const type = mediaTypeOf(name);
            if (!type) continue; // posters, subtitles, metadata: not shown
            entries.push({
              name,
              type: 'file',
              kind: type.kind,
              sizeBytes: s.size,
              modifiedAt: s.mtime.toISOString(),
            });
          }
        } catch {
          // vanished meanwhile
        }
      }
      return entries.sort((a, b) =>
        a.type !== b.type
          ? a.type === 'dir'
            ? -1
            : 1
          : a.name.localeCompare(b.name, 'ru', { numeric: true }),
      );
    },

    async open(relative) {
      const file = await resolve(relative);
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new MediaError(400, 'not_a_file', 'Это папка, а не файл.');
      const type = mediaTypeOf(file);
      if (!type) throw new MediaError(415, 'not_media', 'Этот тип файла здесь не воспроизводится.');
      return { file, stat, mime: type.mime, name: path.basename(file) };
    },

    stream: createReadStream,
  };
}
