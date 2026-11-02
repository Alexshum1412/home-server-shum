/**
 * The family archive («досье»): every few days Olivia asks a person one question about their life or about the big things;
 * the answer (words, a voice recording, photos) is kept on the server, and copied to other disks. Nothing is analysed or sent
 * anywhere: the words stay in the family. The person sees their own answers; the administrator of the family sees all of them
 * (it is the family's archive), and this is said on the page.
 */
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDisabled, type StoredUser } from '../auth/users.ts';
import { newId } from '../lib/ids.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';
import { localMoment } from '../planner/task-dates.ts';
import { type FamilyQuestion, QUESTIONS, questionById, THEMES } from './questions.ts';

const DAY = 86_400_000;
export const MIN_DAYS = 3;
export const MAX_DAYS = 7;
export const MEDIA_MAX = 600 * 1024 * 1024;

export interface DossierMedia {
  file: string;
  name: string;
  kind: 'audio' | 'video' | 'image';
  size: number;
  /** The words of a voice recording, when the administrator switched the transcription on. */
  transcript?: string;
}

export interface DossierEntry {
  id: string;
  username: string;
  qid: string;
  question: string;
  theme: string;
  text: string;
  media: DossierMedia[];
  at: string;
  source: 'portal' | 'telegram';
}

interface PersonState {
  enabled: boolean;
  nextAt: number | null;
  current: { qid: string; askedAt: number; reminded: boolean } | null;
  skipped: string[];
}

interface StoredFile {
  people: Record<string, PersonState>;
  entries: DossierEntry[];
}

export interface CopyStatus {
  total: number;
  ok: number;
  lastAt: string | null;
  problems: string[];
}

const EXTENSIONS: Record<string, DossierMedia['kind']> = {
  m4a: 'audio',
  mp3: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  wav: 'audio',
  aac: 'audio',
  weba: 'audio',
  amr: 'audio',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  '3gp': 'video',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  heic: 'image',
  gif: 'image',
};

export const MEDIA_TYPES: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  weba: 'audio/webm',
  amr: 'audio/amr',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  gif: 'image/gif',
};

export const extensionOf = (name: string): string =>
  (/\.([A-Za-z0-9]{2,5})$/.exec(name)?.[1] ?? '').toLowerCase();
export const mediaKind = (name: string): DossierMedia['kind'] | null => EXTENSIONS[extensionOf(name)] ?? null;

export function createDossier(options: {
  dataDir: string;
  clock: Clock;
  /** Other places for the copies (other disks); a missing disk is skipped and reported. */
  copies: string[];
  users: () => Promise<StoredUser[]>;
  /** Tells the person about the question (the portal's notification and the bot). */
  onAsk: (user: StoredUser, question: FamilyQuestion, reminder: boolean) => Promise<void>;
  random?: () => number;
  /** Called after a recording or a photo is saved (the transcription of voice starts here). */
  afterAttach?: (info: { username: string; entryId: string; media: DossierMedia; file: string }) => void;
}) {
  const root = path.join(options.dataDir, 'dossier');
  const file = path.join(root, 'dossier.json');
  const mediaDir = path.join(root, 'media');
  const queue = createSerialQueue();
  const random = options.random ?? Math.random;
  let copyStatus: CopyStatus = { total: options.copies.length, ok: 0, lastAt: null, problems: [] };

  async function load(): Promise<StoredFile> {
    try {
      const data = (await readJsonFile(file)) as Partial<StoredFile> | undefined;
      return {
        people: data?.people && typeof data.people === 'object' ? data.people : {},
        entries: Array.isArray(data?.entries) ? data.entries : [],
      };
    } catch {
      return { people: {}, entries: [] };
    }
  }
  const person = (data: StoredFile, username: string): PersonState =>
    (data.people[username] ??= { enabled: true, nextAt: null, current: null, skipped: [] });

  async function save(data: StoredFile): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeJsonAtomic(file, { version: 1, ...data });
  }

  /** The same data on the other disks: the index and every media file that is not there yet. */
  async function mirror(data: StoredFile): Promise<CopyStatus> {
    const problems: string[] = [];
    let ok = 0;
    for (const target of options.copies) {
      try {
        // The disk itself must be there (a USB drive may be pulled out): only the folder is created, not the drive.
        const drive = path.parse(target).root;
        await stat(drive);
        await mkdir(path.join(target, 'media'), { recursive: true });
        await writeFile(path.join(target, 'dossier.json'), JSON.stringify({ version: 1, ...data }));
        for (const entry of data.entries) {
          for (const media of entry.media) {
            const from = path.join(mediaDir, entry.username, media.file);
            const to = path.join(target, 'media', entry.username, media.file);
            const have = await stat(to).catch(() => null);
            if (have && have.size === media.size) continue;
            await mkdir(path.dirname(to), { recursive: true });
            await copyFile(from, to);
          }
        }
        ok += 1;
      } catch (error) {
        problems.push(`${target}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
      }
    }
    copyStatus = { total: options.copies.length, ok, lastAt: options.clock().toISOString(), problems };
    return copyStatus;
  }

  const seen = (data: StoredFile, username: string): Set<string> =>
    new Set([
      ...data.entries.filter((e) => e.username === username).map((e) => e.qid),
      ...person(data, username).skipped,
    ]);

  /** A question that this person was not asked yet, from the theme that was asked least recently. */
  function pick(data: StoredFile, username: string, not?: string): FamilyQuestion | null {
    const done = seen(data, username);
    const free = QUESTIONS.filter((item) => !done.has(item.id) && item.id !== not);
    if (free.length === 0) return null;
    const lastThemes = data.entries
      .filter((e) => e.username === username)
      .slice(-6)
      .map((e) => e.theme);
    const order = Object.keys(THEMES).sort(
      (a, b) => lastThemes.lastIndexOf(a) - lastThemes.lastIndexOf(b) || random() - 0.5,
    );
    for (const theme of order) {
      const list = free.filter((item) => item.theme === theme);
      if (list.length > 0) return list[Math.floor(random() * list.length)] as FamilyQuestion;
    }
    return free[0] ?? null;
  }

  const nextTime = (): number =>
    options.clock().getTime() + (MIN_DAYS + random() * (MAX_DAYS - MIN_DAYS)) * DAY;

  return {
    questionCount: QUESTIONS.length,
    copyStatus: () => copyStatus,

    state(username: string): Promise<{
      enabled: boolean;
      current: { question: FamilyQuestion; askedAt: string } | null;
      entries: DossierEntry[];
      remaining: number;
      nextAt: string | null;
    }> {
      return queue.run(async () => {
        const data = await load();
        const me = person(data, username);
        const current = me.current ? questionById(me.current.qid) : undefined;
        return {
          enabled: me.enabled,
          current:
            me.current && current
              ? { question: current, askedAt: new Date(me.current.askedAt).toISOString() }
              : null,
          entries: data.entries.filter((e) => e.username === username).reverse(),
          remaining: QUESTIONS.length - seen(data, username).size,
          nextAt: me.nextAt ? new Date(me.nextAt).toISOString() : null,
        };
      });
    },

    setEnabled(username: string, enabled: boolean): Promise<void> {
      return queue.run(async () => {
        const data = await load();
        const me = person(data, username);
        me.enabled = enabled;
        if (enabled && me.nextAt === null) me.nextAt = options.clock().getTime() + 60_000;
        await save(data);
      });
    },

    /** A question right now: the person asked for it (a new person, or a wish to answer another). Returns it, or null when all are asked. */
    askNow(username: string, another = false): Promise<FamilyQuestion | null> {
      return queue.run(async () => {
        const data = await load();
        const me = person(data, username);
        if (another && me.current) me.skipped.push(me.current.qid);
        const question = pick(data, username, me.current?.qid);
        me.current = question
          ? { qid: question.id, askedAt: options.clock().getTime(), reminded: false }
          : null;
        me.nextAt = nextTime();
        await save(data);
        return question;
      });
    },

    skip(username: string): Promise<void> {
      return queue.run(async () => {
        const data = await load();
        const me = person(data, username);
        if (me.current) me.skipped.push(me.current.qid);
        me.current = null;
        me.nextAt = nextTime();
        await save(data);
      });
    },

    /** Saves an answer. Without a question id it answers the current one; a person may also write to a past entry (extra words). */
    answer(
      username: string,
      body: { text: string; qid?: string; source?: 'portal' | 'telegram' },
    ): Promise<DossierEntry> {
      return queue.run(async () => {
        const data = await load();
        const me = person(data, username);
        const qid = body.qid ?? me.current?.qid;
        const question = qid ? questionById(qid) : undefined;
        if (!question)
          throw Object.assign(new Error('Сейчас нет вопроса, на который можно ответить.'), {
            statusCode: 409,
          });
        const entry: DossierEntry = {
          id: newId(),
          username,
          qid: question.id,
          question: question.text,
          theme: THEMES[question.theme] ?? question.theme,
          text: body.text.trim().slice(0, 20_000),
          media: [],
          at: options.clock().toISOString(),
          source: body.source ?? 'portal',
        };
        data.entries.push(entry);
        if (me.current?.qid === question.id) {
          me.current = null;
          me.nextAt = nextTime();
        }
        await save(data);
        void mirror(data);
        return entry;
      });
    },

    /** Adds words to an entry (more is remembered later). */
    addText(username: string, entryId: string, text: string): Promise<DossierEntry | null> {
      return queue.run(async () => {
        const data = await load();
        const entry = data.entries.find((e) => e.id === entryId && e.username === username);
        if (!entry) return null;
        entry.text = `${entry.text}${entry.text ? '\n\n' : ''}${text.trim()}`.slice(0, 40_000);
        await save(data);
        void mirror(data);
        return entry;
      });
    },

    /** A voice recording, a video or a photo for an entry (a raw stream; at most MEDIA_MAX). */
    async attach(
      username: string,
      entryId: string,
      name: string,
      size: number,
      body: NodeJS.ReadableStream,
    ): Promise<DossierMedia> {
      const kind = mediaKind(name);
      if (!kind)
        throw Object.assign(new Error('Такой тип файла не подходит: нужны запись голоса, видео или фото.'), {
          statusCode: 415,
        });
      if (size <= 0 || size > MEDIA_MAX)
        throw Object.assign(new Error('Файл слишком большой или пустой.'), { statusCode: 413 });
      const entryOk = await queue.run(async () =>
        (await load()).entries.some((e) => e.id === entryId && e.username === username),
      );
      if (!entryOk) throw Object.assign(new Error('Такой записи нет.'), { statusCode: 404 });
      const stored = `${newId()}.${extensionOf(name)}`;
      const dir = path.join(mediaDir, username);
      await mkdir(dir, { recursive: true });
      const temp = path.join(dir, `${stored}.part`);
      try {
        await pipeline(body, createWriteStream(temp, { flags: 'wx' }));
        const written = (await stat(temp)).size;
        if (written !== size)
          throw Object.assign(new Error('Файл пришёл не полностью, попробуйте ещё раз.'), {
            statusCode: 400,
          });
        await rename(temp, path.join(dir, stored));
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      return queue.run(async () => {
        const data = await load();
        const entry = data.entries.find((e) => e.id === entryId && e.username === username);
        if (!entry) throw Object.assign(new Error('Такой записи нет.'), { statusCode: 404 });
        const media: DossierMedia = { file: stored, name: name.slice(0, 120), kind, size };
        entry.media.push(media);
        await save(data);
        void mirror(data);
        options.afterAttach?.({ username, entryId, media, file: path.join(mediaDir, username, stored) });
        return media;
      });
    },

    mediaPath(entryId: string, file: string): Promise<{ path: string; owner: string; name: string } | null> {
      return queue.run(async () => {
        const data = await load();
        const entry = data.entries.find((e) => e.id === entryId);
        const media = entry?.media.find((m) => m.file === file);
        return entry && media
          ? { path: path.join(mediaDir, entry.username, media.file), owner: entry.username, name: media.name }
          : null;
      });
    },

    /** The words of a recording (made later in the background). */
    setTranscript(entryId: string, file: string, transcript: string): Promise<void> {
      return queue.run(async () => {
        const data = await load();
        const media = data.entries.find((e) => e.id === entryId)?.media.find((m) => m.file === file);
        if (!media) return;
        media.transcript = transcript;
        await save(data);
        void mirror(data);
      });
    },

    /** Removes an entry (the person's own); the copies on other disks keep it until the next full cleaning by hand. */
    remove(username: string, entryId: string, isAdmin: boolean): Promise<boolean> {
      return queue.run(async () => {
        const data = await load();
        const index = data.entries.findIndex((e) => e.id === entryId && (isAdmin || e.username === username));
        if (index < 0) return false;
        const [entry] = data.entries.splice(index, 1);
        for (const media of entry?.media ?? [])
          await rm(path.join(mediaDir, entry?.username ?? '', media.file), { force: true });
        await save(data);
        void mirror(data);
        return true;
      });
    },

    /** For the administrator: who answered how much. */
    overview(): Promise<
      Array<{
        username: string;
        entries: number;
        media: number;
        lastAt: string | null;
        enabled: boolean;
        waiting: boolean;
      }>
    > {
      return queue.run(async () => {
        const data = await load();
        const names = new Set([...Object.keys(data.people), ...data.entries.map((e) => e.username)]);
        return [...names].map((username) => {
          const mine = data.entries.filter((e) => e.username === username);
          return {
            username,
            entries: mine.length,
            media: mine.reduce((sum, e) => sum + e.media.length, 0),
            lastAt: mine[mine.length - 1]?.at ?? null,
            enabled: data.people[username]?.enabled ?? true,
            waiting: data.people[username]?.current != null,
          };
        });
      });
    },

    entriesOf(username: string): Promise<DossierEntry[]> {
      return queue.run(async () => (await load()).entries.filter((e) => e.username === username).reverse());
    },

    /** A full copy to the other disks now (also used by the hourly tick). */
    copyNow(): Promise<CopyStatus> {
      return queue.run(async () => mirror(await load()));
    },

    /** Every hour: a new question for those whose time has come (daytime only), a gentle reminder after three days, the copies. */
    async tick(): Promise<void> {
      const now = options.clock();
      const { time } = localMoment(now);
      const daytime = time >= '10:00' && time < '21:00';
      const people = (await options.users()).filter((user) => !isDisabled(user));
      for (const user of people) {
        const decision = await queue.run(async () => {
          const data = await load();
          const me = person(data, user.username);
          if (!me.enabled) return null;
          if (me.current) {
            if (!me.current.reminded && now.getTime() - me.current.askedAt > 3 * DAY && daytime) {
              me.current.reminded = true;
              await save(data);
              return { question: questionById(me.current.qid), reminder: true };
            }
            return null;
          }
          if (!daytime) return null;
          if (me.nextAt === null) {
            // A person who has not been met yet gets the first question after a day, not at once.
            me.nextAt = now.getTime() + DAY;
            await save(data);
            return null;
          }
          if (now.getTime() < me.nextAt) return null;
          const question = pick(data, user.username);
          me.nextAt = nextTime();
          if (!question) {
            await save(data);
            return null;
          }
          me.current = { qid: question.id, askedAt: now.getTime(), reminded: false };
          await save(data);
          return { question, reminder: false };
        });
        if (decision?.question) await options.onAsk(user, decision.question, decision.reminder);
      }
      await queue.run(async () => mirror(await load()));
    },
  };
}

export type Dossier = ReturnType<typeof createDossier>;
