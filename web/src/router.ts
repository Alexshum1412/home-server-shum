/**
 * Tiny History-API router: a location store, a hook, and a document-level
 * click handler that turns same-origin <a href> clicks into pushState navigation.
 */
import { useEffect, useState } from 'preact/hooks';
import { internalNavigationTarget, matchRoute, type RouteId } from './lib/routes.ts';

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function currentUrl(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = new URL(to, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  const next = url.pathname + url.search + url.hash;
  const same = next === currentUrl();
  if (options.replace || same) window.history.replaceState(null, '', next);
  else window.history.pushState(null, '', next);
  if (!same) window.scrollTo(0, 0);
  emit();
}

export interface LocationState {
  path: string;
  /** Query string with the leading «?» (or ''): the folder, space and month live there. */
  search: string;
  route: RouteId;
}

function readLocation(): LocationState {
  return {
    path: window.location.pathname,
    search: window.location.search,
    route: matchRoute(window.location.pathname),
  };
}

export function useLocation(): LocationState {
  const [state, setState] = useState(readLocation);
  useEffect(() => {
    const update = () =>
      setState((prev) =>
        prev.path === window.location.pathname && prev.search === window.location.search
          ? prev
          : readLocation(),
      );
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return state;
}

function onDocumentClick(event: MouseEvent): void {
  const origin = event.target instanceof Element ? event.target : null;
  const anchor = origin?.closest('a');
  if (!anchor?.hasAttribute('href')) return;
  const target = internalNavigationTarget({
    href: anchor.href,
    pageUrl: window.location.href,
    button: event.button,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    defaultPrevented: event.defaultPrevented,
    target: anchor.getAttribute('target') ?? '',
    hasDownload: anchor.hasAttribute('download'),
  });
  if (target === null) return;
  event.preventDefault();
  navigate(target);
}

/** Installs the popstate and link-click handlers. Returns a cleanup function. */
export function startRouter(): () => void {
  window.addEventListener('popstate', emit);
  document.addEventListener('click', onDocumentClick);
  return () => {
    window.removeEventListener('popstate', emit);
    document.removeEventListener('click', onDocumentClick);
  };
}
