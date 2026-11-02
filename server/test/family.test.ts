import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createArchive, tokens } from '../src/archive/archive.ts';
import { createTopics } from '../src/digest/topics.ts';
import { createDossier } from '../src/family/dossier.ts';
import { QUESTIONS } from '../src/family/questions.ts';
import { createFeatureStore } from '../src/features/features.ts';
import { createGuests, GUEST_DAILY_MESSAGES } from '../src/guests/guests.ts';
import { createDiskHistory } from '../src/health/disk-history.ts';
import { listBooks } from '../src/library/routes.ts';
import { externalHeaders } from '../src/olivia/chat.ts';
import { serverReport } from '../src/reports/build.ts';
import { reportIntent } from '../src/reports/service.ts';
import { digestHtml } from '../src/telegram/bot.ts';
import { makeTempDir, removeDir } from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function temp(): Promise<string> {
  const dir = await makeTempDir();
  cleanup.push(() => removeDir(dir));
  return dir;
}

const person = (username: string) =>
  ({ id: `id-${username}`, username, displayName: username, role: 'user', disabled: false }) as never;

describe('the question bank', () => {
  it('has about a hundred and fifty to two hundred distinct questions with stable ids', () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(150);
    expect(QUESTIONS.length).toBeLessThanOrEqual(200);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
    expect(new Set(QUESTIONS.map((q) => q.text)).size).toBe(QUESTIONS.length);
    expect(new Set(QUESTIONS.map((q) => q.theme)).size).toBeGreaterThanOrEqual(10);
  });
});

describe('the family archive', () => {
  it('asks, keeps words and a recording, copies everything to the other disk and never repeats a question', async () => {
    const dir = await temp();
    const copy = path.join(await temp(), 'copy');
    let now = new Date('2026-11-02T12:00:00');
    const asked: string[] = [];
    const dossier = createDossier({
      dataDir: dir,
      clock: () => now,
      copies: [copy],
      users: async () => [person('mama')],
      onAsk: async (_user, question) => void asked.push(question.id),
      random: () => 0.5,
    });
    // the first hour only meets the person, the question comes a day later (in the daytime)
    await dossier.tick();
    expect(asked).toHaveLength(0);
    now = new Date('2026-11-03T13:00:00');
    await dossier.tick();
    expect(asked).toHaveLength(1);
    const state = await dossier.state('mama');
    expect(state.current?.question.id).toBe(asked[0]);

    const entry = await dossier.answer('mama', { text: 'Я родилась в деревне.' });
    const bytes = Buffer.from('voice-bytes');
    const media = await dossier.attach('mama', entry.id, 'golos.m4a', bytes.length, Readable.from([bytes]));
    expect(media.kind).toBe('audio');
    await dossier.copyNow();
    expect(dossier.copyStatus()).toMatchObject({ total: 1, ok: 1 });
    expect(JSON.parse(await readFile(path.join(copy, 'dossier.json'), 'utf8')).entries).toHaveLength(1);
    expect((await stat(path.join(copy, 'media', 'mama', media.file))).size).toBe(bytes.length);

    const next = await dossier.askNow('mama', true);
    expect(next?.id).not.toBe(asked[0]);
    expect((await dossier.state('mama')).remaining).toBe(QUESTIONS.length - 1);
  });

  it('refuses files that are not recordings or photos, and a person cannot reach another one’s entry', async () => {
    const dir = await temp();
    const dossier = createDossier({
      dataDir: dir,
      clock: () => new Date('2026-11-02T12:00:00'),
      copies: [],
      users: async () => [],
      onAsk: async () => undefined,
    });
    await dossier.askNow('papa');
    const entry = await dossier.answer('papa', { text: 'Ответ' });
    await expect(
      dossier.attach('papa', entry.id, 'virus.exe', 3, Readable.from([Buffer.from('abc')])),
    ).rejects.toMatchObject({ statusCode: 415 });
    await expect(
      dossier.attach('mama', entry.id, 'a.jpg', 3, Readable.from([Buffer.from('abc')])),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await dossier.remove('mama', entry.id, false)).toBe(false);
    expect(await dossier.remove('mama', entry.id, true)).toBe(true);
  });
});

describe('the search over what the family keeps', () => {
  it('finds notes by words with other endings and ranks a title match higher', async () => {
    const dir = await temp();
    const notes = {
      list: async () => [
        { name: 'Рецепт борща', modifiedAt: '2026-01-01' },
        { name: 'Поездка', modifiedAt: '2026-01-02' },
      ],
      read: async (_space: string, _user: string, name: string) => ({
        text: name === 'Рецепт борща' ? 'Свёкла, капуста, мясо.' : 'Билеты на поезд и борщ в дорогу.',
      }),
      save: async () => undefined,
    };
    const archive = createArchive({ dataDir: dir, clock: () => new Date(), notes: notes as never });
    expect(tokens('борщом')).toEqual(tokens('борща'));
    const hits = await archive.search('mama', 'как приготовить борщ');
    expect(hits[0]?.title).toBe('Рецепт борща');
    expect(await archive.search('mama', 'космос')).toEqual([]);
  });
});

describe('words made for a level', () => {
  it('asks the model once for a topic and level, shares the answer and remembers the word', async () => {
    const dir = await temp();
    const prompts: string[] = [];
    const topics = createTopics({
      dataDir: dir,
      generate: async (_system, prompt) => {
        prompts.push(prompt);
        return 'Слово: die Geduld\nПеревод: терпение\nПример: Ich habe keine Geduld.\nПеревод примера: У меня нет терпения.';
      },
    });
    const first = await topics.block('german', 'B1', '2026-11-02');
    expect(first?.lines[0]).toBe('die Geduld — терпение');
    expect(prompts[0]).toContain('уровень B1');
    await topics.block('german', 'B1', '2026-11-02');
    expect(prompts).toHaveLength(1);
    await topics.block('german', 'B1', '2026-11-03');
    expect(prompts[1]).toContain('die Geduld');
  });
});

describe('small things', () => {
  it('does not take a replaced disk for a fast loss of space', async () => {
    const dir = await temp();
    let now = new Date('2026-10-01T00:00:00Z').getTime();
    let free = 1800 * 1024 ** 3;
    const history = createDiskHistory(dir, {
      clock: () => new Date(now),
      probe: async () => [{ path: 'C:\\', freeBytes: free }],
      reserveBytes: 2 * 1024 ** 3,
    });
    for (let i = 0; i < 30; i += 1) {
      await history.record();
      now += 3_600_000;
    }
    free = 415 * 1024 ** 3; // another disk
    for (let i = 0; i < 30; i += 1) {
      await history.record();
      now += 3_600_000;
    }
    const [forecast] = await history.forecast();
    expect(forecast?.daysLeft).toBeNull();
  });

  it('makes the digest bold headings for Telegram and escapes the rest', () => {
    const html = digestHtml('Доброе утро!\n\n🌤 Погода\n• ясно <b>\n\n🌿 Хорошего дня!');
    expect(html).toContain('<b>🌤 Погода</b>');
    expect(html).toContain('ясно &lt;b&gt;');
  });
});

describe('reports', () => {
  it('recognises a request for a report and its kind', () => {
    expect(reportIntent('Сделай отчёт о состоянии сервера с графиками')).toBe('server');
    expect(reportIntent('пришли документом сводку на неделю')).toBe('week');
    expect(reportIntent('как дела на сервере')).toBeNull();
    expect(reportIntent('расскажи про отчёт по физике')).toBeNull();
  });

  it('writes a page of the exact height with the warnings, disks and programs, and escapes the words', () => {
    const now = new Date('2026-11-02T08:00:00');
    const measured = (value: number | null) => ({ value, collectedAt: null, source: 't', reason: null });
    const system = {
      server: {
        version: '1',
        startedAt: '',
        hostname: 'HOME',
        osRelease: null,
        uptimeSeconds: measured(90_000),
      },
      cpu: { model: 'x', cores: 4, usagePercent: measured(10) },
      memory: { totalBytes: 16 * 1024 ** 3, usedBytes: measured(8 * 1024 ** 3) },
      temperatureC: measured(null),
      hardware: null,
      volumes: [
        {
          path: 'C:\\',
          totalBytes: 100 * 1024 ** 3,
          freeBytes: 50 * 1024 ** 3,
          collectedAt: null,
          reason: null,
          lowSpace: false,
        },
      ],
      backup: { message: 'копия <b>есть</b>' },
      programs: measured(null),
      overall: { level: 'ok', text: 'Всё в порядке' },
      alerts: [{ id: 'a', level: 'warning', title: 'Заголовок <script>', text: 'Пояснение' }],
    } as never;
    const page = serverReport({
      now,
      system,
      history: [],
      forecast: [],
      incidents: [],
      downloads: { active: 0, done24h: 0 },
      internetUp: true,
    });
    expect(page.html).toContain(`height:${page.height}px`);
    expect(page.html).toContain('Заголовок &lt;script&gt;');
    expect(page.html).not.toContain('<script>');
    expect(page.html).toContain('копия &lt;b&gt;есть');
    expect(page.summary).toContain('предупреждений: 1');
  });
});

describe('functions that wait for the administrator', () => {
  it('keeps a new function off until it is switched on, and an old one on until it is switched off', async () => {
    const dir = await temp();
    const features = createFeatureStore(dir);
    await features.load();
    expect(features.isOn('transcribe')).toBe(false);
    expect(features.isOn('family')).toBe(true);
    expect(features.offFeatureFor('/api/comics/x')).toBe('comics');
    await features.set('transcribe', true);
    await features.set('family', false);
    const again = createFeatureStore(dir);
    await again.load();
    expect(again.isOn('transcribe')).toBe(true);
    expect(again.isOn('family')).toBe(false);
  });
});

describe('people from outside the family', () => {
  it('opens a person once, counts their messages per day, keeps only allowed topics and lets the administrator stop them', async () => {
    const dir = await temp();
    let now = new Date('2026-11-02T08:00:00Z');
    const guests = createGuests({ dataDir: dir, clock: () => now });
    const first = await guests.open('1001', 'Игорь');
    expect(first?.subscribed).toBe(false);
    await guests.update('1001', { subscribed: true, topics: ['news', 'german', 'family-secrets', 'tasks'] });
    expect((await guests.get('1001'))?.topics).toEqual(['news', 'german']);
    expect((await guests.subscribers()).map((g) => g.chatId)).toEqual(['1001']);
    for (let i = 0; i < GUEST_DAILY_MESSAGES; i += 1) expect(await guests.count('1001')).toBe(true);
    expect(await guests.count('1001')).toBe(false);
    now = new Date('2026-11-03T08:00:00Z');
    expect(await guests.count('1001')).toBe(true);
    await guests.block('1001', true);
    expect(await guests.open('1001', 'Игорь')).toBeNull();
    expect(await guests.subscribers()).toEqual([]);
    expect(await guests.remove('1001')).toBe(true);
  });
});

describe('the offline library', () => {
  it('lists the books by their short names and marks the ones that are still being downloaded', async () => {
    const dir = await temp();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'wikipedia_ru_all_maxi_2026-10.zim'), 'x');
    await writeFile(path.join(dir, 'wikipedia_be_all_nopic_2026-09.zim'), 'xx');
    await writeFile(path.join(dir, 'wikipedia_be_all_nopic_2026-09.zim.aria2'), '');
    await writeFile(path.join(dir, 'notes.txt'), 'not a book');
    const books = await listBooks(dir);
    expect(books.map((b) => b.name).sort()).toEqual([
      'wikipedia_be_all_nopic_2026-09',
      'wikipedia_ru_all_maxi_2026-10',
    ]);
    expect(books.find((b) => b.name === 'wikipedia_be_all_nopic_2026-09')?.downloading).toBe(true);
    expect(books.find((b) => b.name === 'wikipedia_ru_all_maxi_2026-10')?.title).toContain(
      'Википедия на русском',
    );
    expect(await listBooks(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('what a stranger may do and the free models', () => {
  it('starts as digest-only, keeps the rights the administrator gives and finds people by words', async () => {
    const dir = await temp();
    const guests = createGuests({ dataDir: dir, clock: () => new Date('2026-11-02T08:00:00Z') });
    const guest = await guests.open('2002', 'Анна', 'anna_x');
    expect(guest).toMatchObject({ chat: false, username: 'anna_x', note: '' });
    await guests.update('2002', { chat: true, note: 'подруга Ольги' });
    expect(await guests.get('2002')).toMatchObject({ chat: true, note: 'подруга Ольги' });
    expect((await guests.list()).some((g) => g.note.includes('Ольги'))).toBe(true);
  });

  it('reads the key of the router of free models from its file and sends it as a bearer token', async () => {
    const dir = await temp();
    const { writeFile } = await import('node:fs/promises');
    const keyFile = path.join(dir, 'freellm.key');
    await writeFile(keyFile, 'freellmapi-test-key\n');
    const headers = await externalHeaders({
      url: 'http://127.0.0.1:3101/v1',
      keyFile,
      model: 'auto',
      enabled: () => true,
    });
    expect(headers.authorization).toBe('Bearer freellmapi-test-key');
    expect(
      (
        await externalHeaders({
          url: 'x',
          keyFile: path.join(dir, 'none'),
          model: 'auto',
          enabled: () => true,
        })
      ).authorization,
    ).toBeUndefined();
  });
});
