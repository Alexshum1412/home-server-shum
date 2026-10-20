import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSerialQueue, errorCode, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';

/**
 * Decoys («приманки»): a few files in the shared space with tempting names and made-up content. Nobody has a reason to
 * open them, so whoever does is noticed: the administrators are told once per hour per file and the journal keeps it.
 * They hold nothing real. Installing never replaces a file that already has the name; removing takes away only the
 * files that are still exactly as they were made.
 */
const TEMPLATES: Array<{ name: string; text: string }> = [
  {
    name: 'Пароли от всего.txt',
    text: 'Wi-Fi гостевой: guest-2468\nПочта: (пример) user@example.com / пример-пароля\nЭто пример, настоящих паролей здесь нет.\n',
  },
  {
    name: 'Банк и карты.txt',
    text: 'Карта: 0000 0000 0000 0000 (пример)\nСрок: 00/00\nЭто пример, настоящих данных здесь нет.\n',
  },
  {
    name: 'Паспорта и документы.txt',
    text: 'Серия и номер: 00 00 000000 (пример)\nЭто пример, настоящих данных здесь нет.\n',
  },
];

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

interface Entry {
  name: string;
  hash: string;
  touches: number;
  lastTouchedAt: string | null;
}

export function createDecoys(options: { dataDir: string; sharedDir: () => string; clock: Clock }) {
  const file = path.join(options.dataDir, 'decoys.json');
  const queue = createSerialQueue();
  const lastAlert = new Map<string, number>();

  async function load(): Promise<Entry[]> {
    try {
      const data = (await readJsonFile(file)) as { entries?: Entry[] } | undefined;
      return Array.isArray(data?.entries) ? data.entries.filter((e) => typeof e?.name === 'string') : [];
    } catch {
      return [];
    }
  }
  const save = (entries: Entry[]) => writeJsonAtomic(file, { version: 1, entries });

  return {
    list(): Promise<Array<{ path: string; touched: number; lastTouchedAt: string | null }>> {
      return queue.run(async () =>
        (await load()).map((e) => ({ path: e.name, touched: e.touches, lastTouchedAt: e.lastTouchedAt })),
      );
    },
    install(): Promise<number> {
      return queue.run(async () => {
        const entries = await load();
        let made = 0;
        await mkdir(options.sharedDir(), { recursive: true });
        for (const template of TEMPLATES) {
          if (entries.some((e) => e.name === template.name)) continue;
          try {
            await writeFile(path.join(options.sharedDir(), template.name), template.text, { flag: 'wx' });
          } catch (error) {
            if (errorCode(error) === 'EEXIST') continue; // a real file with that name: left alone
            throw error;
          }
          entries.push({ name: template.name, hash: sha(template.text), touches: 0, lastTouchedAt: null });
          made += 1;
        }
        await save(entries);
        return made;
      });
    },
    remove(): Promise<number> {
      return queue.run(async () => {
        const entries = await load();
        const keep: Entry[] = [];
        let removed = 0;
        for (const entry of entries) {
          const target = path.join(options.sharedDir(), entry.name);
          try {
            const text = await readFile(target, 'utf8');
            if (sha(text) !== entry.hash) {
              // somebody wrote into it: it is a real file now
              continue;
            }
            await unlink(target);
            removed += 1;
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') keep.push(entry);
          }
        }
        await save(keep);
        return removed;
      });
    },
    /**
     * A person opened a file of the shared space. Returns the name when it is a decoy and the alert is due
     * (the same file does not alert more than once an hour).
     */
    touched(relativePath: string): Promise<string | null> {
      return queue.run(async () => {
        const entries = await load();
        const entry = entries.find((e) => e.name.toLowerCase() === relativePath.toLowerCase());
        if (!entry) return null;
        const now = options.clock().getTime();
        entry.touches += 1;
        entry.lastTouchedAt = options.clock().toISOString();
        await save(entries);
        const before = lastAlert.get(entry.name) ?? 0;
        if (now - before < 3_600_000) return null;
        lastAlert.set(entry.name, now);
        return entry.name;
      });
    },
  };
}

export type Decoys = ReturnType<typeof createDecoys>;
