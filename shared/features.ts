/**
 * The functions of the portal that the administrator can switch on and off. A function that is off disappears from
 * the navigation, and its part of the API answers 403 «отключено администратором» (the administrator's own pages and
 * the switches themselves are never switched off).
 */
export interface FeatureDef {
  id: string;
  title: string;
  lead: string;
  /** Address of the page in the portal (for hiding it), '' for functions without a page. */
  page: string;
  /** Beginnings of the API paths that belong to the function. */
  prefixes: readonly string[];
}

export const FEATURES: readonly FeatureDef[] = [
  {
    id: 'cinema',
    title: 'Кинотеатр',
    lead: 'Каталог фильмов, подборки, запасной просмотр.',
    page: '/cinema',
    prefixes: ['/api/catalog', '/api/media'],
  },
  {
    id: 'photos',
    title: 'Фото',
    lead: 'Фотографии, альбомы, загрузка с телефона.',
    page: '/photos',
    prefixes: ['/api/storage/photos'],
  },
  {
    id: 'files',
    title: 'Файлы',
    lead: 'Личные и общие файлы, корзина.',
    page: '/files',
    prefixes: ['/api/storage/files'],
  },
  {
    id: 'chat',
    title: 'Чат и звонки',
    lead: 'Переписка и голосовые/видеозвонки.',
    page: '/chat',
    prefixes: ['/api/chat', '/api/calls'],
  },
  {
    id: 'downloads',
    title: 'Загрузки',
    lead: 'Скачивание по ссылкам и торренты.',
    page: '/downloads',
    prefixes: ['/api/downloads'],
  },
  {
    id: 'calendar',
    title: 'Календарь',
    lead: 'События семьи.',
    page: '/calendar',
    prefixes: ['/api/calendar'],
  },
  { id: 'notes', title: 'Заметки', lead: 'Текстовые заметки.', page: '/notes', prefixes: ['/api/notes'] },
  {
    id: 'tasks',
    title: 'Дела',
    lead: 'Дела и списки покупок с напоминаниями.',
    page: '/tasks',
    prefixes: ['/api/tasks'],
  },
  {
    id: 'deadlines',
    title: 'Сроки и гарантии',
    lead: 'Документы, гарантии, подписки: напоминание заранее.',
    page: '/deadlines',
    prefixes: ['/api/deadlines'],
  },
  {
    id: 'digest',
    title: 'Утренний дайджест',
    lead: 'Личная утренняя сводка каждому.',
    page: '/digest',
    prefixes: ['/api/digest'],
  },
  {
    id: 'print',
    title: 'Печать',
    lead: 'Печать документов на принтере.',
    page: '/print',
    prefixes: ['/api/print'],
  },
  { id: 'olivia', title: 'Оливия', lead: 'Помощница семьи.', page: '/olivia', prefixes: ['/api/olivia'] },
  {
    id: 'search',
    title: 'Общий поиск',
    lead: 'Поиск по всему порталу (Ctrl+K).',
    page: '',
    prefixes: ['/api/search'],
  },
  {
    id: 'notifications',
    title: 'Уведомления',
    lead: 'Центр уведомлений и push.',
    page: '/notifications',
    prefixes: ['/api/notifications'],
  },
];

export type FeatureStates = Record<string, boolean>;

export interface FeaturesResponse {
  features: Array<{ id: string; title: string; lead: string; enabled: boolean }>;
  /** id → on/off, for the navigation. */
  states: FeatureStates;
}
