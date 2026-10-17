/** Route table and pure helpers for the History-API router (no DOM access here). */

export type RouteId =
  | 'home'
  | 'cinema'
  | 'photos'
  | 'files'
  | 'downloads'
  | 'calendar'
  | 'notes'
  | 'print'
  | 'system'
  | 'help'
  | 'admin'
  | 'account'
  | 'login'
  | 'notFound';

export interface RouteDef {
  id: Exclude<RouteId, 'notFound'>;
  path: string;
  /** Page name used in the document title and navigation. */
  title: string;
  /** Shown in the navigation only to admins (the server enforces 403 on its API anyway). */
  adminOnly?: boolean;
}

export const APP_NAME = 'Семейный сервер';

export const ROUTES: readonly RouteDef[] = [
  { id: 'home', path: '/', title: 'Главная' },
  { id: 'cinema', path: '/cinema', title: 'Кинотеатр' },
  { id: 'photos', path: '/photos', title: 'Фото' },
  { id: 'files', path: '/files', title: 'Файлы' },
  { id: 'downloads', path: '/downloads', title: 'Загрузки' },
  { id: 'calendar', path: '/calendar', title: 'Календарь' },
  { id: 'notes', path: '/notes', title: 'Заметки' },
  { id: 'print', path: '/print', title: 'Печать' },
  { id: 'system', path: '/system', title: 'Состояние системы' },
  { id: 'help', path: '/help', title: 'Подключение' },
  { id: 'admin', path: '/admin', title: 'Администрирование', adminOnly: true },
  { id: 'account', path: '/account', title: 'Мой профиль' },
  { id: 'login', path: '/login', title: 'Вход' },
];

const byPath = new Map(ROUTES.map((route) => [route.path, route]));

/** '/System//' → '/system'. Query and hash must already be stripped. */
export function normalizePath(pathname: string): string {
  let path = pathname.trim() || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path.toLowerCase();
}

export function matchRoute(pathname: string): RouteId {
  return byPath.get(normalizePath(pathname))?.id ?? 'notFound';
}

/** True for sections that only admins may open (unknown paths are not admin-only). */
export function isAdminOnly(id: RouteId): boolean {
  return ROUTES.some((route) => route.id === id && route.adminOnly === true);
}

export function routePath(id: Exclude<RouteId, 'notFound'>): string {
  return ROUTES.find((route) => route.id === id)?.path ?? '/';
}

export function documentTitle(id: RouteId): string {
  const page = id === 'notFound' ? 'Страница не найдена' : ROUTES.find((route) => route.id === id)?.title;
  return `${page} — ${APP_NAME}`;
}

/** Is `path` the active section? Exact match only: every section is one level deep. */
export function isActivePath(currentPath: string, linkPath: string): boolean {
  return normalizePath(currentPath) === normalizePath(linkPath);
}

export interface LinkClickInfo {
  href: string;
  /** Full URL of the page the link is on. */
  pageUrl: string;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  /** Value of the link's target attribute ('' when absent). */
  target: string;
  hasDownload: boolean;
}

/**
 * Decides whether a click on an <a> should be handled by the client-side router.
 * Returns the in-app URL (path + query + hash) or null to let the browser handle it.
 */
export function internalNavigationTarget(click: LinkClickInfo): string | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (click.hasDownload) return null;
  if (click.target && click.target !== '_self') return null;
  let url: URL;
  let page: URL;
  try {
    page = new URL(click.pageUrl);
    url = new URL(click.href, page);
  } catch {
    return null;
  }
  if (url.origin !== page.origin) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // In-page anchors (e.g. the skip link) keep native behaviour: scroll and move focus.
  if (url.hash && url.pathname === page.pathname && url.search === page.search) return null;
  // API endpoints and static files (anything with an extension) are real server resources.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
  if (/\.[a-z0-9]+$/i.test(url.pathname)) return null;
  return url.pathname + url.search + url.hash;
}
