/**
 * The family's own archive of web pages («ArchiveBox» in a small form) and the search over what the family keeps:
 * saved pages, notes, and the names of files. A page is fetched once (only public addresses, the same rule as the
 * download queue), stored as readable text and as the original HTML (to download), and found later by words, also by
 * Olivia. Nothing leaves the PC: the search is a plain word index made when asked.
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../lib/ids.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';
import { fetchPage } from '../olivia/web.ts';

export interface ArchivedPage {
  id: string;
  url: string;
  title: string;
  savedAt: string;
  shared: boolean;
  owner: string;
  chars: number;
}

export interface KnowledgeHit {
  kind: 'page' | 'note';
  title: string;
  snippet: string;
  href: string;
  score: number;
}

interface NotesLike {
  list: (
    space: 'personal' | 'shared',
    username: string,
  ) => Promise<Array<{ name: string; modifiedAt: string }>>;
  read: (space: 'personal' | 'shared', username: string, name: string) => Promise<{ text: string }>;
  save: (
    space: 'personal' | 'shared',
    username: string,
    name: string,
    text: string,
    revision: string | null,
  ) => Promise<unknown>;
}

const MAX_PAGES_PER_PERSON = 2000;

const ENDINGS =
  /(?:ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ом|ем|ам|ям|ов|ев|ей|ой|ий|ый|ая|яя|ое|ее|ые|ие|ую|юю|ть|ы|и|а|я|о|е|у|ю|ь)$/;

/** Words of a question that say nothing about the topic. */
const STOP = new Set(
  'как что где про мне мои моих для или это все при найди найти покажи есть было были нашей наших заметках заметки заметка архиве сохранял сохранял сохранённых сохраненных страницах страницы знаний знания'.split(
    ' ',
  ),
);

const stem = (word: string): string => {
  const base = word.length > 4 ? word.replace(ENDINGS, '') : word;
  return base.length > 6 ? base.slice(0, 6) : base;
};

/** Words of a text without endings: «борщом» and «борща» meet at «борщ». */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3)
    .map(stem);
}

const queryTokens = (query: string): string[] =>
  tokens(
    query
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => !STOP.has(word))
      .join(' '),
  );
function snippetOf(text: string, wanted: Set<string>): string {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  let at = -1;
  for (const word of wanted) {
    at = lower.indexOf(word);
    if (at >= 0) break;
  }
  const from = Math.max(0, at - 80);
  return `${from > 0 ? '…' : ''}${text
    .slice(from, from + 220)
    .replace(/\s+/g, ' ')
    .trim()}…`;
}

export function createArchive(options: {
  dataDir: string;
  clock: Clock;
  notes: NotesLike;
  fetch?: typeof fetch;
}) {
  const root = path.join(options.dataDir, 'archive');
  const queue = createSerialQueue();
  const fetchImpl = options.fetch ?? fetch;
  const safeUser = (username: string) => username.replace(/[^A-Za-z0-9_.-]/g, '_');
  const dirOf = (username: string) => path.join(root, safeUser(username));
  const metaFile = (username: string, id: string) => path.join(dirOf(username), `${id}.json`);

  async function pagesOf(username: string): Promise<Array<ArchivedPage & { text: string }>> {
    const dir = dirOf(username);
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: Array<ArchivedPage & { text: string }> = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const data = (await readJsonFile(path.join(dir, name))) as
          | (ArchivedPage & { text: string })
          | undefined;
        if (data?.id) out.push({ ...data, owner: username });
      } catch {
        // a damaged file does not stop the others
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async function allUsernames(): Promise<string[]> {
    return readdir(root).catch(() => [] as string[]);
  }

  const view = (page: ArchivedPage & { text?: string }): ArchivedPage => ({
    id: page.id,
    url: page.url,
    title: page.title,
    savedAt: page.savedAt,
    shared: page.shared,
    owner: page.owner,
    chars: page.chars,
  });

  return {
    /** Fetches and stores a page; the same address is replaced, not doubled. */
    async save(username: string, url: string, shared = false): Promise<ArchivedPage | null> {
      const page = await fetchPage(url, fetchImpl, 300_000);
      if (!page) return null;
      return queue.run(async () => {
        const existing = (await pagesOf(username)).find((item) => item.url === url);
        const mine = await pagesOf(username);
        if (!existing && mine.length >= MAX_PAGES_PER_PERSON) return null;
        const id = existing?.id ?? newId();
        const record = {
          id,
          url,
          title: page.title || url,
          savedAt: options.clock().toISOString(),
          shared,
          owner: username,
          chars: page.text.length,
          text: page.text,
        };
        await mkdir(dirOf(username), { recursive: true });
        await writeJsonAtomic(metaFile(username, id), record);
        await writeFile(path.join(dirOf(username), `${id}.html`), page.html.slice(0, 3_000_000), 'utf8');
        return view(record);
      });
    },

    list: (username: string): Promise<ArchivedPage[]> =>
      queue.run(async () => (await pagesOf(username)).map(view)),

    /** One page as text, for the owner or, when shared, for everyone. */
    async get(username: string, id: string): Promise<(ArchivedPage & { text: string }) | null> {
      for (const owner of await allUsernames()) {
        const found = (await pagesOf(owner)).find((item) => item.id === id);
        if (found && (found.owner === safeUser(username) || found.owner === username || found.shared))
          return found;
      }
      return null;
    },

    async originalPath(username: string, id: string): Promise<string | null> {
      const found = await this.get(username, id);
      if (!found) return null;
      const file = path.join(dirOf(found.owner), `${id}.html`);
      return (await stat(file).catch(() => null)) ? file : null;
    },

    remove(username: string, id: string): Promise<boolean> {
      return queue.run(async () => {
        const found = (await pagesOf(username)).find((item) => item.id === id);
        if (!found) return false;
        await rm(metaFile(username, id), { force: true });
        await rm(path.join(dirOf(username), `${id}.html`), { force: true });
        return true;
      });
    },

    /** Notes (own and shared) and pages (own and shared) that match the words, best first. */
    async search(username: string, query: string, limit = 6): Promise<KnowledgeHit[]> {
      const wanted = new Set(queryTokens(query));
      if (wanted.size === 0) return [];
      const docs: Array<{ kind: 'page' | 'note'; title: string; text: string; href: string }> = [];
      for (const owner of await allUsernames()) {
        for (const page of await pagesOf(owner)) {
          if (owner === safeUser(username) || owner === username || page.shared)
            docs.push({ kind: 'page', title: page.title, text: page.text, href: `/archive?open=${page.id}` });
        }
      }
      for (const space of ['personal', 'shared'] as const) {
        const list = await options.notes.list(space, username).catch(() => []);
        for (const note of list.slice(0, 400)) {
          try {
            const body = await options.notes.read(space, username, note.name);
            docs.push({
              kind: 'note',
              title: note.name,
              text: body.text,
              href: `/notes?space=${space}&name=${encodeURIComponent(note.name)}`,
            });
          } catch {
            // a note that cannot be read is skipped
          }
        }
      }
      const hits: KnowledgeHit[] = [];
      for (const doc of docs) {
        const inTitle = tokens(doc.title);
        const inText = tokens(doc.text);
        const bag = new Map<string, number>();
        for (const word of inText) bag.set(word, (bag.get(word) ?? 0) + 1);
        let matched = 0;
        let score = 0;
        for (const word of wanted) {
          const t = inTitle.filter((x) => x === word).length;
          const c = bag.get(word) ?? 0;
          if (t > 0 || c > 0) matched += 1;
          score += t * 6 + Math.min(c, 10);
        }
        if (matched === 0 || matched < Math.ceil(wanted.size / 2)) continue;
        hits.push({
          kind: doc.kind,
          title: doc.title,
          snippet: snippetOf(doc.text, wanted),
          href: doc.href,
          score: score * (matched / wanted.size),
        });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },

    /** A quick note from the phone: the first words are the title. */
    async addNote(username: string, text: string): Promise<string> {
      const clean = text.trim().slice(0, 20_000);
      const stamp = options.clock().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
      const head =
        clean
          .split(/\n/)[0]
          ?.replace(/[\\/:*?"<>|]/g, '')
          .trim()
          .slice(0, 40) ?? '';
      const name = `${head || 'Заметка'} (${stamp})`;
      await options.notes.save('personal', username, name, clean, null);
      return name;
    },
  };
}

export type Archive = ReturnType<typeof createArchive>;
