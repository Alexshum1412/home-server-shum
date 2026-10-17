/**
 * A forced stop or a power cut can leave half-written temp files in the family folders: hidden
 * (`.upload-…`, `.note-…`, `….tmp` next to a preview), never listed, but copied by every backup and
 * eating disk space. Only files that are clearly temp AND older than a day are removed; nothing else.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const TEMP_NAME = /^(\.upload-.+|\.note-.+|.+\.[0-9a-f]{12}\.tmp|.+\.tmp)$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function removeStaleTempFiles(
  root: string,
  now = Date.now(),
  maxAgeMs = DAY_MS,
): Promise<string[]> {
  const removed: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // The trash is the owner's safety net: it is never touched.
        if (entry.name === '.trash') continue;
        await walk(full);
      } else if (entry.isFile() && TEMP_NAME.test(entry.name)) {
        const stat = await fsp.stat(full).catch(() => null);
        if (stat && now - stat.mtimeMs > maxAgeMs) {
          await fsp.rm(full, { force: true }).catch(() => undefined);
          removed.push(full);
        }
      }
    }
  }
  await walk(root);
  return removed;
}
