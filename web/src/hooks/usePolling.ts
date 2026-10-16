import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { type ApiFailure, apiGet, isAbortError, toFailure } from '../api.ts';

export interface RemoteData<T> {
  /** Last good data; kept when a later request fails. */
  data: T | null;
  /** Error of the latest attempt, null after a success. */
  error: ApiFailure | null;
  /** A request is in flight. */
  loading: boolean;
  /** Client time (ms) when `data` was received. */
  receivedAt: number | null;
}

export interface PollingResult<T> extends RemoteData<T> {
  refresh: () => void;
  /** Replace the data with a fresher copy obtained elsewhere (e.g. after a manual refresh). */
  replace: (data: T) => void;
}

/** Minimum gap before a "tab became visible" refetch. */
const VISIBLE_REFETCH_GAP_MS = 5_000;

/**
 * GETs `path` every `intervalMs` while the page is visible. Hidden tabs do not poll;
 * becoming visible triggers an immediate refetch. The last good data is kept on errors.
 */
export function usePolling<T>(path: string, intervalMs: number, enabled = true): PollingResult<T> {
  const [state, setState] = useState<RemoteData<T>>({
    data: null,
    error: null,
    loading: enabled,
    receivedAt: null,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflight = useRef<AbortController | null>(null);
  const lastStart = useRef(0);
  /** Set by the effect cleanup (unmount, path change): nothing may start or be scheduled after it. */
  const disposed = useRef(false);

  const run = useCallback(async () => {
    if (disposed.current) return;
    clearTimeout(timer.current);
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    lastStart.current = Date.now();
    setState((prev) => (prev.loading ? prev : { ...prev, loading: true }));
    try {
      const data = await apiGet<T>(path, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setState({ data, error: null, loading: false, receivedAt: Date.now() });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      setState((prev) => ({ ...prev, error: toFailure(error), loading: false }));
    } finally {
      if (!controller.signal.aborted && !disposed.current && document.visibilityState === 'visible') {
        // A timer set meanwhile (e.g. by a visibility change during this request) is replaced, never orphaned.
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void run(), intervalMs);
      }
    }
  }, [path, intervalMs]);

  useEffect(() => {
    if (!enabled) return;
    disposed.current = false;
    const onVisibility = () => {
      clearTimeout(timer.current);
      if (disposed.current || document.visibilityState !== 'visible') return;
      if (Date.now() - lastStart.current >= VISIBLE_REFETCH_GAP_MS) void run();
      else timer.current = setTimeout(() => void run(), intervalMs);
    };
    if (document.visibilityState === 'visible') void run();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed.current = true;
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer.current);
      inflight.current?.abort();
    };
  }, [enabled, run, intervalMs]);

  const refresh = useCallback(() => void run(), [run]);
  const replace = useCallback((data: T) => {
    setState({ data, error: null, loading: false, receivedAt: Date.now() });
  }, []);

  return { ...state, refresh, replace };
}
