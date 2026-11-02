/**
 * The blocks of a digest for the interests of a person. Nothing is written in advance: a language word, a task, a workout
 * are made by the local model for the level the person gave, once a day for each topic and level (people with the same
 * topic and level share the answer), and the last words are remembered so that they do not come again. When the model does
 * not answer, the language topics fall back to a small fixed list and the rest are skipped. Feeds (news, Habr, «this day in
 * history») are real data from public sources, not words of a model.
 */
import path from 'node:path';
import { defaultLevel, INTERESTS, type InterestDef, type LevelMap } from '../../../shared/profile.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { englishLine, germanLine, parseHeadlines, recipeLine } from './interests.ts';

export interface Section {
  icon: string;
  title: string;
  lines: string[];
}

export type Generate = (system: string, prompt: string, maxTokens: number) => Promise<string | null>;

const LANGUAGE: Record<string, { name: string; extra: string }> = {
  german: { name: 'немецкий', extra: 'С артиклем у существительных.' },
  english: { name: 'английский', extra: '' },
  polish: { name: 'польский', extra: '' },
  french: { name: 'французский', extra: 'С артиклем у существительных.' },
  spanish: { name: 'испанский', extra: '' },
  italian: { name: 'итальянский', extra: '' },
  chinese: { name: 'китайский', extra: 'Иероглифы и пиньинь в скобках.' },
  japanese: { name: 'японский', extra: 'Запись и чтение (ромадзи) в скобках.' },
  korean: { name: 'корейский', extra: 'Хангыль и произношение буквами в скобках.' },
  turkish: { name: 'турецкий', extra: '' },
  czech: { name: 'чешский', extra: '' },
};

const ICON: Record<string, string> = { languages: '🌍', default: '✨' };
const TOPIC_ICON: Record<string, string> = {
  news: '📰',
  tech: '💻',
  history: '📜',
  science: '🔬',
  space: '🪐',
  animals: '🐾',
  geography: '🗺',
  math: '➗',
  riddle: '🧩',
  psychology: '🧠',
  philosophy: '🤔',
  coding: '👨‍💻',
  recipes: '🍲',
  baking: '🥧',
  healthy: '🥗',
  garden: '🌱',
  diy: '🛠',
  workout: '💪',
  stretch: '🧘',
  health: '❤️',
  sleep: '😴',
  kids: '🧸',
  parenting: '👨‍👩‍👧',
  pets: '🐶',
  money: '💰',
  productivity: '🗂',
  books: '📚',
  movies: '🎬',
  music: '🎵',
  poetry: '✍️',
  quote: '💬',
  joke: '😄',
  travel: '🧳',
  photo: '📷',
  cars: '🚗',
  fishing: '🎣',
  chess: '♟',
};

/** What to ask the model for each topic that is not a language. */
const ASK: Record<string, string> = {
  science: 'один малоизвестный, но достоверный научный факт и в одном предложении, почему это так',
  space: 'один достоверный факт о космосе или астрономии',
  animals: 'один достоверный интересный факт о животных или природе',
  geography: 'один достоверный факт о стране, городе или природном месте мира',
  math: 'одну небольшую математическую задачу и ответ в конце после слова «Ответ:»',
  riddle: 'одну загадку и отгадку в конце после слова «Ответ:»',
  psychology: 'одну короткую полезную мысль из психологии, понятно и без терминов',
  philosophy: 'одну мысль философа (имя и идея своими словами, не цитата) и вопрос для размышления',
  coding: 'один практичный совет по программированию с очень коротким примером',
  recipes: 'идею блюда на сегодня: название, главные продукты и 3–4 коротких шага',
  baking: 'идею выпечки: название, главные продукты и 3–4 коротких шага',
  healthy: 'один практичный совет о здоровом питании',
  garden: 'один сезонный совет для сада или огорода (время года — по сегодняшней дате)',
  diy: 'один практичный совет по дому или идею поделки своими руками',
  workout: 'короткую тренировку на 10 минут: 4–5 упражнений с числом повторений',
  stretch: 'одно упражнение на растяжку для спины или шеи и как его делать',
  health: 'один общий совет о здоровье (без диагнозов и лекарств)',
  sleep: 'один практичный совет для хорошего сна',
  kids: 'одну идею игры или занятия с ребёнком дома',
  parenting: 'один короткий добрый совет родителям',
  pets: 'один практичный совет по уходу за домашним питомцем',
  money: 'один практичный совет по семейному бюджету',
  productivity: 'один практичный совет, как всё успевать и не уставать',
  books: 'идею книги на вечер: автор, название, о чём (своими словами), только известные книги',
  movies: 'идею фильма на вечер: название, год, жанр, о чём (своими словами), только известные фильмы',
  music: 'короткий рассказ об одном музыканте, группе или жанре (без цитат из текстов песен)',
  poetry: 'рассказ об одном поэте и о чём его стихи (своими словами, без цитат и строк из стихов)',
  quote:
    'одно известное изречение, которое точно знаешь, и имя автора; если не уверена — своя мысль без кавычек',
  joke: 'одну добрую короткую шутку без грубостей',
  travel: 'идею места для поездки: где, чем знаменито, что посмотреть',
  photo: 'один практичный совет по фотографии',
  cars: 'один практичный совет по уходу за автомобилем',
  fishing: 'один практичный совет рыболову',
  chess: 'один шахматный совет или идею дебюта, понятно и коротко',
};

export const topicDef = (id: string): InterestDef | undefined => INTERESTS.find((item) => item.id === id);

const SYSTEM =
  'Ты составляешь короткий блок для утреннего сообщения семье. Пиши по-русски, живо и просто, 2–5 коротких строк. ' +
  'Только то, что знаешь точно: не выдумывай цифры, даты, имена и цитаты. Без ссылок, без приветствий и подписей, ' +
  'без заголовков и без звёздочек. Не вставляй тексты песен и длинные цитаты.';

export function topicPrompt(def: InterestDef, level: string, day: string, recent: string[]): string {
  const avoid = recent.length > 0 ? `\nНе повторяй уже было: ${recent.slice(-25).join('; ')}.` : '';
  const language = LANGUAGE[def.id];
  if (language) {
    return (
      `Сегодня ${day}. Изучается ${language.name} язык, уровень ${level} по CEFR. ${language.extra}\n` +
      `Дай слово или короткую устойчивую фразу дня, подходящую именно этому уровню: ` +
      `${level === 'A1' || level === 'A2' ? 'частая бытовая лексика' : level === 'B1' || level === 'B2' ? 'более абстрактные и разговорные слова, фразовые глаголы и выражения' : 'редкие, книжные и тонкие по смыслу слова и идиомы'}.${avoid}\n` +
      'Строго четыре строки в таком виде:\nСлово: …\nПеревод: …\nПример: … (предложение на изучаемом языке)\nПеревод примера: …'
    );
  }
  const ask = ASK[def.id] ?? 'короткий полезный совет по теме';
  const skill = def.level ? ` Читатель: ${level}.` : '';
  return `Сегодня ${day}. Тема: «${def.title}».${skill}\nДай ${ask}.${avoid}`;
}

function cleanBlock(text: string): string[] {
  return text
    .replace(/\*\*|__|`|^#+\s*/gm, '')
    .replace(/https?:\/\/\S+/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 8);
}

/** The line that identifies a block for «do not repeat» (the word of a language block, the first words of others). */
function headOf(lines: string[]): string {
  const first = lines.find((line) => /^слово\s*:/i.test(line)) ?? lines[0] ?? '';
  return first.replace(/^слово\s*:\s*/i, '').slice(0, 60);
}

function formatLanguage(lines: string[]): string[] {
  const field = (name: RegExp) =>
    lines
      .find((line) => name.test(line))
      ?.replace(/^[^:]+:\s*/, '')
      .trim();
  const word = field(/^слово\s*:/i);
  const translation = field(/^перевод\s*:/i);
  const example = field(/^пример\s*:/i);
  const exampleRu = field(/^перевод примера\s*:/i);
  if (!word || !translation) return lines;
  return [
    `${word} — ${translation}`,
    ...(example ? [`«${example}»`] : []),
    ...(exampleRu ? [`${exampleRu}`] : []),
  ];
}

interface TopicFile {
  cache: Record<string, string[]>;
  recent: Record<string, string[]>;
}

export function createTopics(options: { dataDir: string; generate: Generate; fetch?: typeof fetch }) {
  const file = path.join(options.dataDir, 'digest-topics.json');
  const queue = createSerialQueue();
  const fetchImpl = options.fetch ?? fetch;

  async function load(): Promise<TopicFile> {
    try {
      const data = (await readJsonFile(file)) as Partial<TopicFile> | undefined;
      return { cache: data?.cache ?? {}, recent: data?.recent ?? {} };
    } catch {
      return { cache: {}, recent: {} };
    }
  }

  async function feed(id: string, day: string): Promise<string[] | null> {
    try {
      if (id === 'news' || id === 'tech') {
        const url =
          id === 'news'
            ? 'https://feeds.bbci.co.uk/russian/rss.xml'
            : 'https://habr.com/ru/rss/best/daily/?fl=ru';
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
        if (!response.ok) return null;
        const items = parseHeadlines(await response.text(), 4);
        return items.length > 0 ? items : null;
      }
      if (id === 'history') {
        const [, month, date] = day.split('-');
        const response = await fetchImpl(
          `https://ru.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${date}`,
          { signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'FamilyServer/1.0 (home portal)' } },
        );
        if (!response.ok) return null;
        const body = (await response.json()) as { events?: Array<{ year?: number; text?: string }> };
        const picked = (body.events ?? [])
          .filter((e) => typeof e.year === 'number' && typeof e.text === 'string')
          .sort(
            (a, b) => ((b.text?.length ?? 0) - (a.text?.length ?? 0)) * 0 || (b.year ?? 0) - (a.year ?? 0),
          )
          .slice(0, 3)
          .map((e) => `${e.year}: ${String(e.text).slice(0, 180)}`);
        return picked.length > 0 ? picked : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  function fallback(id: string, day: string): string[] | null {
    if (id === 'german') return [germanLine(day).replace(/^Слово дня на немецком: /, '')];
    if (id === 'english') return [englishLine(day).replace(/^Слово дня на английском: /, '')];
    if (id === 'recipes') return [recipeLine(day).replace(/^Идея на сегодня: /, '')];
    return null;
  }

  return {
    /** The block of one topic for one level on one day (made once, then shared). */
    block(id: string, level: string | undefined, day: string): Promise<Section | null> {
      const def = topicDef(id);
      if (!def) return Promise.resolve(null);
      const used = def.level ? (level ?? defaultLevel(def.level)) : '';
      const key = `${day}|${id}|${used}`;
      const icon = LANGUAGE[id] ? ICON.languages : (TOPIC_ICON[id] ?? ICON.default);
      const title = LANGUAGE[id] ? `${def.title}, ${used}` : def.level ? `${def.title} (${used})` : def.title;
      return queue.run(async () => {
        const data = await load();
        const hit = data.cache[key];
        if (hit) return { icon: icon as string, title, lines: hit };
        let lines: string[] | null = await feed(id, day);
        if (!lines && (ASK[id] || LANGUAGE[id])) {
          const recent = data.recent[`${id}|${used}`] ?? [];
          const text = await options.generate(
            SYSTEM,
            topicPrompt(def, used, day, recent),
            LANGUAGE[id] ? 160 : 260,
          );
          if (text) {
            const cleaned = cleanBlock(text);
            lines = LANGUAGE[id] ? formatLanguage(cleaned) : cleaned;
            if (lines.length > 0) {
              data.recent[`${id}|${used}`] = [...recent, headOf(cleaned)].slice(-40);
            } else lines = null;
          }
        }
        lines ??= fallback(id, day);
        if (!lines || lines.length === 0) return null;
        // Only today's answers are kept.
        for (const old of Object.keys(data.cache)) if (!old.startsWith(day)) delete data.cache[old];
        data.cache[key] = lines;
        await writeJsonAtomic(file, { version: 1, ...data });
        return { icon: icon as string, title, lines };
      });
    },
  };
}

export type Topics = ReturnType<typeof createTopics>;

/** Which topics of a person have a block today, in the order the person chose them. */
export function topicsOf(interests: string[]): string[] {
  const known = new Set(INTERESTS.map((item) => item.id));
  return interests.filter((id) => known.has(id));
}

export type { LevelMap };
