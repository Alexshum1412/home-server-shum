import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  documentTitle,
  internalNavigationTarget,
  isActivePath,
  isAdminOnly,
  type LinkClickInfo,
  matchRoute,
  normalizePath,
  ROUTES,
  type RouteId,
  routePath,
} from './routes.ts';

const EXPECTED: Array<[string, RouteId]> = [
  ['/', 'home'],
  ['/cinema', 'cinema'],
  ['/photos', 'photos'],
  ['/files', 'files'],
  ['/downloads', 'downloads'],
  ['/calendar', 'calendar'],
  ['/notes', 'notes'],
  ['/print', 'print'],
  ['/system', 'system'],
  ['/help', 'help'],
  ['/admin', 'admin'],
  ['/account', 'account'],
  ['/login', 'login'],
];

describe('matchRoute', () => {
  it.each(EXPECTED)('%s → %s', (path, id) => {
    expect(matchRoute(path)).toBe(id);
  });

  it('covers every route in the table', () => {
    expect(ROUTES.map((route) => route.path).sort()).toEqual(EXPECTED.map(([path]) => path).sort());
  });

  it('tolerates case, repeated and trailing slashes', () => {
    expect(matchRoute('/System/')).toBe('system');
    expect(matchRoute('//cinema//')).toBe('cinema');
    expect(matchRoute('')).toBe('home');
    expect(matchRoute('admin')).toBe('admin');
  });

  it('sends unknown paths to «not found»', () => {
    expect(matchRoute('/nope')).toBe('notFound');
    expect(matchRoute('/admin/users')).toBe('notFound');
    expect(matchRoute('/cinema.html')).toBe('notFound');
  });
});

describe('route helpers', () => {
  it('marks only the administration section as admin-only', () => {
    expect(isAdminOnly('admin')).toBe(true);
    for (const route of ROUTES.filter((r) => r.id !== 'admin')) expect(isAdminOnly(route.id)).toBe(false);
    expect(isAdminOnly('notFound')).toBe(false);
  });

  it('builds paths and document titles', () => {
    expect(routePath('system')).toBe('/system');
    expect(routePath('home')).toBe('/');
    expect(documentTitle('system')).toBe(`Состояние системы — ${APP_NAME}`);
    expect(documentTitle('notFound')).toBe(`Страница не найдена — ${APP_NAME}`);
  });

  it('normalizes paths and compares sections exactly', () => {
    expect(normalizePath('/Help///')).toBe('/help');
    expect(isActivePath('/system/', '/system')).toBe(true);
    expect(isActivePath('/system', '/')).toBe(false);
  });
});

describe('internalNavigationTarget', () => {
  const base: LinkClickInfo = {
    href: 'http://127.0.0.1:8070/system',
    pageUrl: 'http://127.0.0.1:8070/',
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    target: '',
    hasDownload: false,
  };

  it('routes plain same-origin clicks in the app', () => {
    expect(internalNavigationTarget(base)).toBe('/system');
    expect(internalNavigationTarget({ ...base, href: '/help?x=1#top' })).toBe('/help?x=1#top');
  });

  it('leaves everything else to the browser', () => {
    expect(internalNavigationTarget({ ...base, href: 'https://example.org/' })).toBeNull();
    expect(internalNavigationTarget({ ...base, ctrlKey: true })).toBeNull();
    expect(internalNavigationTarget({ ...base, button: 1 })).toBeNull();
    expect(internalNavigationTarget({ ...base, target: '_blank' })).toBeNull();
    expect(internalNavigationTarget({ ...base, hasDownload: true })).toBeNull();
    expect(internalNavigationTarget({ ...base, defaultPrevented: true })).toBeNull();
    expect(internalNavigationTarget({ ...base, href: '/api/admin/diagnostics' })).toBeNull();
    expect(internalNavigationTarget({ ...base, href: '/manifest.webmanifest' })).toBeNull();
    expect(internalNavigationTarget({ ...base, href: '#main' })).toBeNull();
  });
});
