/**
 * Understanding a question WITHOUT a language model: patterns for what people really ask. It is the
 * second way to reach every tool (the model is the first, where it helps), so «Оливия» keeps working
 * when the model is off, slow or wrong.
 */
import { faqById, matchFaq } from './knowledge.ts';

export type ToolName =
  | 'faq'
  | 'status'
  | 'disk'
  | 'backup'
  | 'media'
  | 'files'
  | 'downloads'
  | 'add_download'
  | 'calendar'
  | 'unknown';

export const TOOLS: readonly ToolName[] = [
  'faq',
  'status',
  'disk',
  'backup',
  'media',
  'files',
  'downloads',
  'add_download',
  'calendar',
  'unknown',
];

export interface Plan {
  tool: ToolName;
  /** What to look for (a title, a name), already cleaned. */
  query: string;
  /** A link or magnet the person wrote (always a piece of their own message). */
  url: string;
  faqId: string;
  where: 'files' | 'photos' | 'any';
  /** The patterns were sure; the model is not needed. */
  confident: boolean;
}

const STOP = new Set(
  [
    'найди',
    'найти',
    'найдите',
    'покажи',
    'показать',
    'покажите',
    'хочу',
    'хотим',
    'посмотреть',
    'посмотрим',
    'послушать',
    'включи',
    'включить',
    'мне',
    'нам',
    'пожалуйста',
    'пожалуй',
    'про',
    'об',
    'обо',
    'фильм',
    'фильмы',
    'фильма',
    'сериал',
    'сериалы',
    'мультик',
    'мультики',
    'мультфильм',
    'мультфильмы',
    'кино',
    'песню',
    'песни',
    'музыку',
    'аудиокнигу',
    'аудиокниги',
    'есть',
    'ли',
    'у',
    'нас',
    'где',
    'мои',
    'моё',
    'мой',
    'моя',
    'файл',
    'файлы',
    'файла',
    'документ',
    'документы',
    'фото',
    'фотки',
    'фотографии',
    'фотография',
    'снимки',
    'снимок',
    'картинки',
    'картинку',
    'папку',
    'папка',
    'из',
    'на',
    'в',
    'для',
    'и',
    'а',
    'с',
    'со',
    'по',
    'это',
    'что',
    'то',
    'какой',
    'какие',
    'ищи',
    'искать',
    'можно',
    'как',
    'нибудь',
    'чего',
    'типа',
    'такое',
    'хочется',
    'интересное',
    'интересного',
    'мы',
    'я',
    'нужно',
    'нужен',
    'нужна',
    'надо',
    'ну',
    'бы',
    'про',
    'там',
    'тут',
    'всё',
    'все',
  ].map((word) => word.replace(/ё/g, 'е')),
);

/** The words that name what is being looked for. */
export function topicWords(message: string, limit = 5): string {
  return message
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !STOP.has(word))
    .slice(0, limit)
    .join(' ');
}

const URL_RE = /magnet:\?[^\s<>"']+|https?:\/\/[^\s<>"']+/i;

export function routeByRules(message: string): Plan {
  const text = message.toLowerCase().replace(/ё/g, 'е').trim();
  const plan = (tool: ToolName, extra: Partial<Plan> = {}, confident = true): Plan => ({
    tool,
    query: '',
    url: '',
    faqId: '',
    where: 'any',
    confident,
    ...extra,
  });

  const link = URL_RE.exec(message);
  if (link) return plan('add_download', { url: link[0].replace(/[.,;)]+$/, '') });

  // «Как …?» about the portal itself comes first: «как скачать» is a question, not a command.
  // (\b does not know Cyrillic letters: the end of a word is checked with a lookahead.)
  if (/^(как|где|что делать|почему|зачем|можно ли|а как)(?![\p{L}\p{N}])/u.test(text) || text.endsWith('?')) {
    const how = matchFaq(text);
    if (how && /^(как|что делать|почему|зачем|можно ли|а как)(?![\p{L}\p{N}])/u.test(text))
      return plan('faq', { faqId: how.id });
  }
  if (/^(привет|здравствуй|добрый|доброе|добрая|hello|hi)(?![\p{L}\p{N}])/u.test(text) && text.length < 30) {
    return plan('faq', { faqId: 'capabilities' });
  }
  if (
    /(сколько|много|мало|осталось).*(мест|диск|памят)|(мест[ао]|диск|памят[ьи]|свободн\w*)\b.*(диск|сервер|осталось|занят|свободн)|^диск/.test(
      text,
    )
  ) {
    return plan('disk');
  }
  if (
    /(резервн|бэкап|бекап|копи[яиею]\w* (данных|файлов|сервера)|копирован|сохранени\w* данных|что с копи)/.test(
      text,
    )
  ) {
    return plan('backup');
  }
  if (/(загрузк|скачива|очеред\w*|торрент)/.test(text)) return plan('downloads');
  if (
    /(календар|событи|планы|что (у нас )?(на неделе|сегодня|завтра)|^сегодня|^завтра)/.test(text) &&
    !/(фильм|сериал)/.test(text)
  ) {
    return plan('calendar');
  }
  if (
    /(как дела|всё ли|все ли|работает ли|что с серверо|состояни|проблем|что сломал|всё хорошо|все хорошо|сервер)/.test(
      text,
    )
  ) {
    return plan('status');
  }
  const wantsPhotos = /(фото|снимк|фотограф|фотки|картинк)/.test(text);
  const wantsFiles = /(файл|документ|папк|скан|таблиц|презентац)/.test(text);
  if (wantsPhotos || wantsFiles) {
    return plan(
      'files',
      {
        query: topicWords(message),
        where: wantsPhotos && !wantsFiles ? 'photos' : wantsFiles && !wantsPhotos ? 'files' : 'any',
      },
      false,
    );
  }
  if (
    /(найди|найти|покажи|хочу|посмотреть|включи|ищи|послушать|есть ли|фильм|сериал|мультик|мультфильм|кино|песн|музык|аудиокниг|сказк)/.test(
      text,
    )
  ) {
    return plan('media', { query: topicWords(message) }, false);
  }
  const faq = matchFaq(text);
  if (faq) return plan('faq', { faqId: faq.id });
  return plan('unknown', {}, false);
}

export function faqIdIsKnown(id: string): boolean {
  return faqById(id) !== undefined;
}
