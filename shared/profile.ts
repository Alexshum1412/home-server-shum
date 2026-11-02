/** What a person tells about themselves: it makes the digest and the bot fit them. */
export type LevelScale = 'cefr' | 'skill';

export interface InterestDef {
  id: string;
  title: string;
  lead: string;
  group: string;
  /** The topic adapts to the level of the person (languages: A1–C2; others: a simple skill scale). */
  level?: LevelScale;
}

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export const SKILL_LEVELS = ['новичок', 'средний', 'опытный'] as const;

export const LEVELS_BY_SCALE: Record<LevelScale, readonly string[]> = {
  cefr: CEFR_LEVELS,
  skill: SKILL_LEVELS,
};

const lang = (id: string, title: string, what: string): InterestDef => ({
  id,
  title,
  group: 'Иностранные языки',
  level: 'cefr',
  lead: `Каждое утро — ${what} по вашему уровню (нужно выбрать уровень).`,
});
const tip = (id: string, title: string, lead: string, group: string, level?: LevelScale): InterestDef => ({
  id,
  title,
  lead,
  group,
  ...(level ? { level } : {}),
});

export const INTERESTS: readonly InterestDef[] = [
  lang('german', 'Немецкий', 'слово и пример на немецком'),
  lang('english', 'Английский', 'слово и пример на английском'),
  lang('polish', 'Польский', 'слово и пример на польском'),
  lang('french', 'Французский', 'слово и пример на французском'),
  lang('spanish', 'Испанский', 'слово и пример на испанском'),
  lang('italian', 'Итальянский', 'слово и пример на итальянском'),
  lang('chinese', 'Китайский', 'слово (иероглифы и пиньинь) и пример на китайском'),
  lang('japanese', 'Японский', 'слово (с чтением) и пример на японском'),
  lang('korean', 'Корейский', 'слово и пример на корейском'),
  lang('turkish', 'Турецкий', 'слово и пример на турецком'),
  lang('czech', 'Чешский', 'слово и пример на чешском'),
  tip('news', 'Новости мира', 'Три главных заголовка Би-би-си на русском.', 'Мир и новости'),
  tip('tech', 'Технологии и IT', 'Лучшие статьи дня с Хабра.', 'Мир и новости'),
  tip('history', 'Этот день в истории', 'Что случилось в этот день (по Википедии).', 'Мир и новости'),
  tip('science', 'Наука', 'Интересный научный факт.', 'Учёба и ум'),
  tip('space', 'Космос', 'Факт о космосе и астрономии.', 'Учёба и ум'),
  tip('animals', 'Животные и природа', 'Факт о животных и природе.', 'Учёба и ум'),
  tip('geography', 'География и страны', 'Факт о странах, городах, местах.', 'Учёба и ум'),
  tip('math', 'Задачка по математике', 'Небольшая задача под ваш уровень.', 'Учёба и ум', 'skill'),
  tip('riddle', 'Загадка', 'Загадка дня (ответ — внизу).', 'Учёба и ум'),
  tip('psychology', 'Психология', 'Короткая мысль о том, как мы думаем и чувствуем.', 'Учёба и ум'),
  tip('philosophy', 'Философия', 'Мысль или вопрос для размышления.', 'Учёба и ум'),
  tip('coding', 'Программирование', 'Небольшой совет по программированию.', 'Учёба и ум', 'skill'),
  tip('recipes', 'Что приготовить', 'Идея на сегодня с составом и шагами.', 'Кухня и дом'),
  tip('baking', 'Выпечка', 'Идея для выпечки.', 'Кухня и дом'),
  tip('healthy', 'Здоровое питание', 'Совет о питании.', 'Кухня и дом'),
  tip('garden', 'Сад и огород', 'Сезонный совет для сада и огорода.', 'Кухня и дом'),
  tip('diy', 'Своими руками и ремонт', 'Домашний совет или идея поделки.', 'Кухня и дом'),
  tip('workout', 'Зарядка и тренировка', 'Короткая тренировка под ваш уровень.', 'Здоровье и спорт', 'skill'),
  tip('stretch', 'Растяжка и спина', 'Упражнение для спины и шеи.', 'Здоровье и спорт'),
  tip('health', 'Здоровье', 'Общий совет о здоровье (не заменяет врача).', 'Здоровье и спорт'),
  tip('sleep', 'Сон и бодрость', 'Совет для хорошего сна.', 'Здоровье и спорт'),
  tip('kids', 'Игры и занятия с детьми', 'Идея, чем занять ребёнка сегодня.', 'Семья и жизнь'),
  tip('parenting', 'Воспитание', 'Короткий совет родителям.', 'Семья и жизнь'),
  tip('pets', 'Домашние питомцы', 'Совет по уходу за питомцем.', 'Семья и жизнь'),
  tip('money', 'Домашний бюджет', 'Совет по экономии и деньгам.', 'Семья и жизнь'),
  tip('productivity', 'Дела и порядок', 'Совет, как всё успевать.', 'Семья и жизнь'),
  tip('books', 'Книга на вечер', 'Идея, что почитать.', 'Культура и досуг'),
  tip('movies', 'Фильм на вечер', 'Идея, что посмотреть (из известного).', 'Культура и досуг'),
  tip('music', 'Музыка', 'Рассказ о музыканте или жанре.', 'Культура и досуг'),
  tip('poetry', 'Стихи', 'Об одном поэте и его стихах (без полного текста).', 'Культура и досуг'),
  tip('quote', 'Мысль дня', 'Известное изречение с автором.', 'Культура и досуг'),
  tip('joke', 'Улыбка дня', 'Добрая шутка.', 'Культура и досуг'),
  tip('travel', 'Путешествия', 'Идея места для поездки.', 'Хобби и техника'),
  tip('photo', 'Фотография', 'Совет по фото.', 'Хобби и техника'),
  tip('cars', 'Автомобиль', 'Совет по уходу за машиной.', 'Хобби и техника'),
  tip('fishing', 'Рыбалка', 'Совет рыболову.', 'Хобби и техника'),
  tip('chess', 'Шахматы', 'Совет для игры под ваш уровень.', 'Хобби и техника', 'skill'),
];

/** The level a person gave for a topic that has a scale; levels are kept per topic. */
export type LevelMap = Record<string, string>;

export const defaultLevel = (scale: LevelScale): string => (scale === 'cefr' ? 'A2' : 'новичок');
export interface ProfileView {
  city: string;
  hasCoordinates: boolean;
  /** The name in Telegram that the person gave (@name), only to show. */
  telegramUsername: string;
  /** The bot knows this person (they linked the chat). */
  telegramLinked: boolean;
  /** The notifications of the portal are also sent to the linked Telegram chat. */
  telegramNotify: boolean;
  interests: string[];
  /** The level of the person for the topics that have a scale (language: A1–C2). */
  levels: LevelMap;
  /** Anything else the person is into, in their words (the model sees it when it writes the digest). */
  about: string;
  /** The first-sign-in questions were answered or skipped. */
  onboarded: boolean;
}

export interface ProfileResponse {
  profile: ProfileView;
  interests: readonly InterestDef[];
  /** The Telegram bot of the family (its name), or null when it is not connected. */
  bot: string | null;
}

export interface ProfilePatch {
  city?: string;
  telegramUsername?: string;
  telegramNotify?: boolean;
  interests?: string[];
  levels?: LevelMap;
  about?: string;
  onboarded?: boolean;
}

export interface TelegramLinkResponse {
  code: string;
  bot: string;
  expiresInMinutes: number;
}
