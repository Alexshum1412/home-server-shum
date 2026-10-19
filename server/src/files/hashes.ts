/**
 * «Это фото у нас уже есть»: an exact-duplicate check for the photo library. The browser computes the
 * SHA-256 of a file on the phone and asks which of the hashes the person's photos already hold; those
 * files are not sent again. Exact means exact: the same bytes, never «looks alike».
 *
 * The index is a small JSON file per space (<photos>\.index\…). New uploads enter it for free (the hash is
 * computed while the bytes arrive, of the file as the phone had it, before any metadata is taken out).
 * Photos that were there before are hashed in the background, one at a time and gently, so a large
 * library never slows the server down; until that is finished the answer says so («not checked yet»)
 * instead of claiming that a file is new.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { StorageSpace } from '../../../shared/api.ts';
import type { HashQueryResponse } from '../../../shared/storage-extras.ts';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';

const LISTING_MAX_AGE_MS = 30_000;
const WALK_MAX_DEPTH = 6;
const WALK_MAX_FILES = 500_000;
const SAVE_EVERY = 200;
export const HASH_RE = /^[0-9a-f]{64}$/;

interface FileRecord {
  size: number;
  mtimeMs: number;
  hash: string;
}

interface Slot {
  key: string;
  dir: string;
  file: string;
  files: Map<string, FileRecord>;
  byHash: Map<string, string>;
  listing: { at: number; entries: Map<string, { size: number; mtimeMs: number }> } | null;
  scanning: Promise<void> | null;
  dirty: boolean;
  saving: Promise<void>;
}

export interface HashIndexOptions {
  photosRoot: string;
  spaceDir: (space: StorageSpace, username: string) => string;
  /** Pause between two files of the background pass (ms). */
  throttleMs?: number;
  now?: () => number;
}

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function createHashIndex(options: HashIndexOptions) {
  const throttle = options.throttleMs ?? 15;
  const now = options.now ?? Date.now;
  const slots = new Map<string, Promise<Slot>>();

  function keyOf(space: StorageSpace, username: string): string {
    // A login is already restricted to safe characters; the prefix keeps «shared» apart from a person called so.
    return space === 'shared' ? 'shared' : `user-${username}`;
  }

  function slotFor(space: StorageSpace, username: string): Promise<Slot> {
    const key = keyOf(space, username);
    let pending = slots.get(key);
    if (!pending) {
      pending = (async () => {
        const slot: Slot = {
          key,
          dir: options.spaceDir(space, username),
          file: path.join(options.photosRoot, '.index', `${key}.json`),
          files: new Map(),
          byHash: new Map(),
          listing: null,
          scanning: null,
          dirty: false,
          saving: Promise.resolve(),
        };
        try {
          const data = (await readJsonFile(slot.file)) as { files?: Record<string, FileRecord> } | undefined;
          for (const [rel, record] of Object.entries(data?.files ?? {})) {
            if (
              record &&
              typeof record.hash === 'string' &&
              HASH_RE.test(record.hash) &&
              Number.isFinite(record.size) &&
              Number.isFinite(record.mtimeMs)
            ) {
              slot.files.set(rel, record);
              slot.byHash.set(record.hash, rel);
            }
          }
        } catch {
          // A damaged index is rebuilt by the background pass; nothing is lost but time.
        }
        return slot;
      })();
      slots.set(key, pending);
    }
    return pending;
  }

  function save(slot: Slot): Promise<void> {
    if (!slot.dirty) return slot.saving;
    slot.dirty = false;
    const files = Object.fromEntries(slot.files);
    slot.saving = slot.saving
      .then(() => writeJsonAtomic(slot.file, { version: 1, files }))
      .catch(() => {
        slot.dirty = true;
      });
    return slot.saving;
  }

  async function walk(slot: Slot): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const found = new Map<string, { size: number; mtimeMs: number }>();
    const stack: Array<{ dir: string; prefix: string; depth: number }> = [
      { dir: slot.dir, prefix: '', depth: 0 },
    ];
    while (stack.length > 0 && found.size < WALK_MAX_FILES) {
      const next = stack.pop();
      if (!next) break;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fsp.readdir(next.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const rel = next.prefix === '' ? entry.name : `${next.prefix}/${entry.name}`;
        const full = path.join(next.dir, entry.name);
        if (entry.isDirectory()) {
          if (next.depth < WALK_MAX_DEPTH) stack.push({ dir: full, prefix: rel, depth: next.depth + 1 });
        } else if (entry.isFile()) {
          const stat = await fsp.stat(full).catch(() => null);
          if (stat) found.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    }
    return found;
  }

  async function listing(slot: Slot, fresh = false) {
    if (!fresh && slot.listing && now() - slot.listing.at < LISTING_MAX_AGE_MS) return slot.listing.entries;
    const entries = await walk(slot);
    slot.listing = { at: now(), entries };
    return entries;
  }

  const upToDate = (slot: Slot, rel: string, seen: { size: number; mtimeMs: number }): boolean => {
    const record = slot.files.get(rel);
    return record !== undefined && record.size === seen.size && Math.abs(record.mtimeMs - seen.mtimeMs) < 2;
  };

  function pendingOf(slot: Slot, entries: Map<string, { size: number; mtimeMs: number }>): string[] {
    const todo: string[] = [];
    for (const [rel, seen] of entries) if (!upToDate(slot, rel, seen)) todo.push(rel);
    return todo;
  }

  /** Hashes what is not hashed yet, one file at a time; the running pass is shared by every caller. */
  function scan(slot: Slot): Promise<void> {
    if (slot.scanning) return slot.scanning;
    slot.scanning = (async () => {
      try {
        const entries = await listing(slot, true);
        // Entries of files that are gone are dropped.
        for (const rel of [...slot.files.keys()]) {
          if (!entries.has(rel)) {
            const record = slot.files.get(rel);
            slot.files.delete(rel);
            if (record && slot.byHash.get(record.hash) === rel) slot.byHash.delete(record.hash);
            slot.dirty = true;
          }
        }
        let sinceSave = 0;
        for (const rel of pendingOf(slot, entries)) {
          const full = path.join(slot.dir, ...rel.split('/'));
          const before = await fsp.stat(full).catch(() => null);
          if (!before?.isFile()) continue;
          let hash: string;
          try {
            hash = await sha256OfFile(full);
          } catch {
            continue; // a file in use or removed meanwhile: the next pass tries again
          }
          const after = await fsp.stat(full).catch(() => null);
          if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) continue; // changed while read
          const old = slot.files.get(rel);
          if (old && slot.byHash.get(old.hash) === rel) slot.byHash.delete(old.hash);
          slot.files.set(rel, { size: after.size, mtimeMs: after.mtimeMs, hash });
          slot.byHash.set(hash, rel);
          slot.dirty = true;
          sinceSave += 1;
          if (sinceSave >= SAVE_EVERY) {
            sinceSave = 0;
            await save(slot);
          }
          if (throttle > 0) await new Promise((resolve) => setTimeout(resolve, throttle));
        }
        await save(slot);
      } finally {
        slot.scanning = null;
      }
    })();
    return slot.scanning;
  }

  return {
    /** Which of `hashes` are already stored in this space. Starts the background pass when older photos are unchecked. */
    async query(
      space: StorageSpace,
      username: string,
      hashes: readonly string[],
    ): Promise<HashQueryResponse> {
      const slot = await slotFor(space, username);
      const entries = await listing(slot);
      const pending = pendingOf(slot, entries);
      if (pending.length > 0 && !slot.scanning) void scan(slot).catch(() => undefined);
      const known: string[] = [];
      for (const hash of new Set(hashes)) {
        if (!HASH_RE.test(hash)) continue;
        const rel = slot.byHash.get(hash);
        if (rel === undefined) continue;
        // The file may have been put in the trash since: an entry for a missing file does not count.
        if (
          !entries.has(rel) ||
          !(await fsp.stat(path.join(slot.dir, ...rel.split('/'))).then(
            () => true,
            () => false,
          ))
        ) {
          slot.byHash.delete(hash);
          slot.files.delete(rel);
          slot.dirty = true;
          continue;
        }
        known.push(hash);
      }
      return { known, complete: pending.length === 0 && !slot.scanning, pending: pending.length };
    },

    /** A file was stored with this hash (of the bytes as the phone sent them). */
    async record(space: StorageSpace, username: string, hash: string, rel: string): Promise<void> {
      if (!HASH_RE.test(hash)) return;
      const slot = await slotFor(space, username);
      const stat = await fsp.stat(path.join(slot.dir, ...rel.split('/'))).catch(() => null);
      if (!stat?.isFile()) return;
      const old = slot.files.get(rel);
      if (old && slot.byHash.get(old.hash) === rel) slot.byHash.delete(old.hash);
      slot.files.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
      slot.byHash.set(hash, rel);
      slot.listing = null;
      slot.dirty = true;
      void save(slot);
    },

    /** Runs the background pass to the end (tests, and a way to prepare an index on demand). */
    async scanNow(space: StorageSpace, username: string): Promise<void> {
      await scan(await slotFor(space, username));
    },

    /** Everything written so far is on disk. */
    async idle(): Promise<void> {
      for (const pending of slots.values()) {
        const slot = await pending;
        await slot.scanning;
        await save(slot);
      }
    },
  };
}

export type HashIndex = ReturnType<typeof createHashIndex>;
