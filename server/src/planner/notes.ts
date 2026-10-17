/**
 * Family notes are plain text files in the folder «Заметки» of «Личное» (only the author) or
 * «Общее» (the family). Being ordinary files they appear in «Файлы», are in every backup, and can
 * be opened in Notepad on the server — a note is never locked inside the portal.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { NoteResponse, NoteSummary, SaveNoteResponse, StorageSpace } from '../../../shared/api.ts';
import { sanitizeName } from '../files/names.ts';
import { type Storage, StorageError } from '../files/storage.ts';
import { createKeyedLock } from '../lib/keyed-lock.ts';

export const NOTES_FOLDER = 'Заметки';
export const NOTE_EXT = '.txt';
export const NOTE_MAX_BYTES = 200 * 1024;
export const NOTE_TITLE_MAX = 100;
const PREVIEW_BYTES = 400;

export class NoteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Version of a note: time, size AND a hash of the text. Windows stamps files with a coarse clock (up to
 * ~15 ms), so two different texts of the same length written within one tick would otherwise look alike.
 */
const revisionOf = (stat: { mtimeMs: number; size: number }, content: Buffer) =>
  `${Math.trunc(stat.mtimeMs)}-${stat.size}-${createHash('sha1').update(content).digest('hex').slice(0, 16)}`;

/** A title that is also a safe file name; anything else is explained, not silently changed. */
export function checkTitle(raw: string): string {
  const title = raw.trim();
  if (title === '' || Array.from(title).length > NOTE_TITLE_MAX) {
    throw new NoteError(400, 'bad_name', `Название заметки — от 1 до ${NOTE_TITLE_MAX} символов.`);
  }
  if (title.startsWith('.') || sanitizeName(title) !== title) {
    throw new NoteError(
      400,
      'bad_name',
      'В названии нельзя использовать символы \\ / : * ? " < > | и начинать его с точки.',
    );
  }
  return title;
}

function previewOf(buffer: Buffer): string {
  return buffer.toString('utf8').replace(/^﻿/, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function createNotes(storage: Storage) {
  /** Saves and deletes of one note go one after another: the revision check and the write are one step. */
  const lock = createKeyedLock();
  const location = (space: StorageSpace, name?: string) => ({
    root: 'files' as const,
    space,
    path: name === undefined ? NOTES_FOLDER : `${NOTES_FOLDER}/${name}${NOTE_EXT}`,
  });
  const dirOf = (space: StorageSpace, username: string) =>
    path.join(storage.spaceDir('files', space, username), NOTES_FOLDER);

  async function ensureFolder(space: StorageSpace, username: string): Promise<void> {
    try {
      await storage.mkdir({ root: 'files', space, path: '' }, username, NOTES_FOLDER);
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'exists') throw error;
    }
  }

  return {
    async list(space: StorageSpace, username: string): Promise<NoteSummary[]> {
      const dir = dirOf(space, username);
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const out: NoteSummary[] = [];
      for (const fileName of names) {
        if (fileName.startsWith('.') || path.extname(fileName).toLowerCase() !== NOTE_EXT) continue;
        const full = path.join(dir, fileName);
        const stat = await fsp.lstat(full).catch(() => null);
        if (!stat?.isFile()) continue;
        const handle = await fsp.open(full, 'r').catch(() => null);
        let preview = '';
        if (handle) {
          const buffer = Buffer.alloc(Math.min(PREVIEW_BYTES, stat.size));
          await handle.read(buffer, 0, buffer.length, 0).catch(() => undefined);
          await handle.close();
          preview = previewOf(buffer);
        }
        out.push({
          name: fileName.slice(0, -NOTE_EXT.length),
          modifiedAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
          preview,
        });
      }
      return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    },

    async read(space: StorageSpace, username: string, rawName: string): Promise<NoteResponse> {
      const name = checkTitle(rawName);
      const { file, stat } = await storage.openFile(location(space, name), username);
      if (stat.size > NOTE_MAX_BYTES * 2) {
        throw new NoteError(
          413,
          'too_large',
          'Эта заметка слишком большая для просмотра в портале. Откройте её в «Файлах».',
        );
      }
      const content = await fsp.readFile(file);
      const text = content.toString('utf8').replace(/^﻿/, '');
      return { space, name, text, revision: revisionOf(stat, content), modifiedAt: stat.mtime.toISOString() };
    },

    /** Creates a note (`revision` null) or replaces the text of an existing one if nobody changed it meanwhile. */
    async save(
      space: StorageSpace,
      username: string,
      rawName: string,
      text: string,
      revision: string | null,
    ): Promise<SaveNoteResponse> {
      const name = checkTitle(rawName);
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.length > NOTE_MAX_BYTES) {
        throw new NoteError(
          413,
          'too_large',
          `Заметка слишком длинная: не больше ${NOTE_MAX_BYTES / 1024} КБ текста.`,
        );
      }
      if (text.includes('\u0000'))
        throw new NoteError(400, 'bad_text', 'В тексте есть недопустимые символы.');
      return lock(`${space}/${username}/${name.toLowerCase()}`, async () => {
        const target = path.join(dirOf(space, username), `${name}${NOTE_EXT}`);

        if (revision === null) {
          const present = await fsp.lstat(target).catch(() => null);
          if (present) {
            throw new NoteError(
              409,
              'exists',
              'Заметка с таким названием уже есть. Выберите другое название.',
            );
          }
          await ensureFolder(space, username);
          // The upload never replaces a file: if the name was taken meanwhile it gets a free one.
          const saved = await storage.upload(
            location(space),
            username,
            `${name}${NOTE_EXT}`,
            bytes.length,
            Readable.from([bytes]),
          );
          const stat = await fsp.stat(path.join(dirOf(space, username), saved.name));
          return {
            name: saved.name.slice(0, -NOTE_EXT.length),
            revision: revisionOf(stat, bytes),
            modifiedAt: stat.mtime.toISOString(),
          };
        }

        const { file, stat } = await storage.openFile(location(space, name), username);
        if (revisionOf(stat, await fsp.readFile(file)) !== revision) {
          throw new NoteError(
            409,
            'conflict',
            'Эту заметку только что изменил кто-то другой. Скопируйте свой текст, закройте и откройте заметку заново.',
          );
        }
        const temp = path.join(path.dirname(file), `.note-${randomBytes(8).toString('hex')}`);
        try {
          await fsp.writeFile(temp, bytes, { flag: 'wx' });
          await fsp.rename(temp, file); // replacing is intended: the version was checked just above
        } catch (error) {
          await fsp.rm(temp, { force: true }).catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
            throw new NoteError(507, 'no_space', 'На диске сервера закончилось место.');
          }
          throw error;
        }
        const after = await fsp.stat(file);
        return { name, revision: revisionOf(after, bytes), modifiedAt: after.mtime.toISOString() };
      });
    },

    /** To the space's trash; the portal never deletes for good. */
    async remove(space: StorageSpace, username: string, rawName: string): Promise<void> {
      const name = checkTitle(rawName);
      await lock(`${space}/${username}/${name.toLowerCase()}`, async () => {
        await storage.trash(location(space, name), username);
      });
    },
  };
}

export type Notes = ReturnType<typeof createNotes>;
