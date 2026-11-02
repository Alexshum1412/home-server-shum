/**
 * The sections of the portal as the family sees them: ten entries instead of eighteen pages. A section opens its first
 * page; inside it the pages are tabs. Addresses of the pages did not change (old bookmarks and links still work).
 */
export interface NavTab {
  path: string;
  label: string;
  adminOnly?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  /** Shorter text for the bottom bar. */
  short?: string;
  /** Address of the section's own page (where a click on the section leads). */
  to: string;
  tabs: readonly NavTab[];
  /** The section is for administrators only. */
  adminOnly?: boolean;
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'home', label: 'Главная', to: '/', tabs: [{ path: '/', label: 'Главная' }] },
  {
    id: 'chat',
    label: 'Чат',
    to: '/chat',
    tabs: [
      { path: '/chat', label: 'Люди' },
      { path: '/olivia', label: 'Оливия' },
    ],
  },
  {
    id: 'notifications',
    label: 'Уведомления',
    short: 'Новое',
    to: '/notifications',
    tabs: [{ path: '/notifications', label: 'Уведомления' }],
  },
  {
    id: 'planner',
    label: 'Дела',
    to: '/tasks',
    tabs: [
      { path: '/tasks', label: 'Дела и покупки' },
      { path: '/calendar', label: 'Календарь' },
      { path: '/notes', label: 'Заметки' },
      { path: '/deadlines', label: 'Сроки и гарантии' },
    ],
  },
  {
    id: 'media',
    label: 'Медиа',
    to: '/cinema',
    tabs: [
      { path: '/cinema', label: 'Кинотеатр' },
      { path: '/photos', label: 'Фото' },
      { path: '/files', label: 'Файлы' },
    ],
  },
  {
    id: 'memory',
    label: 'Память',
    to: '/family',
    tabs: [
      { path: '/family', label: 'Семейный архив' },
      { path: '/archive', label: 'Знания и страницы' },
    ],
  },
  { id: 'downloads', label: 'Загрузки', to: '/downloads', tabs: [{ path: '/downloads', label: 'Загрузки' }] },
  { id: 'print', label: 'Печать', to: '/print', tabs: [{ path: '/print', label: 'Печать' }] },
  {
    id: 'server',
    label: 'Сервер',
    to: '/status',
    tabs: [
      { path: '/status', label: 'Что с сервером' },
      { path: '/system', label: 'Состояние', adminOnly: true },
      { path: '/server', label: 'Программы', adminOnly: true },
      { path: '/safety', label: 'Безопасность', adminOnly: true },
      { path: '/admin', label: 'Администрирование', adminOnly: true },
      { path: '/help', label: 'Подключение' },
    ],
  },
  {
    id: 'account',
    label: 'Мой профиль',
    short: 'Профиль',
    to: '/account',
    tabs: [
      { path: '/account', label: 'Профиль' },
      { path: '/digest', label: 'Дайджест' },
    ],
  },
];

const normalise = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

export function groupOfPath(path: string): NavGroup | undefined {
  const target = normalise(path);
  return NAV_GROUPS.find((group) => group.tabs.some((tab) => tab.path === target));
}
