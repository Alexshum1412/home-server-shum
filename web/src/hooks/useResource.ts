import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { type ApiFailure, apiGet, isAbortError, toFailure } from '../api.ts';
import type { RemoteData } from './usePolling.ts';

export interface ResourceResult<T> extends RemoteData<T> {
  reload: () => void;
}

/** What was received for exactly one `path`: data of another path is never handed out. */
interface Slot<T> extends RemoteData<T> {
  path: string | null;
}

/**
 * One-shot GET with loading / error / retry states; pass `null` to skip loading.
 *
 * The result always belongs to the `path` asked for: after the path changes the previous data is
 * gone from the very first render (no stale folder list under a new heading, no wrong «пусто»).
 * `reload()` on the same path keeps the current data on screen while it refreshes.
 */
export function useResource<T>(path: string | null): ResourceResult<T> {
  const [slot, setSlot] = useState<Slot<T>>({
    path,
    data: null,
    error: null,
    loading: path !== null,
    receivedAt: null,
  });
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (path === null) return;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setSlot((prev) =>
      prev.path === path
        ? { ...prev, loading: true, error: null }
        : { path, data: null, error: null, loading: true, receivedAt: null },
    );
    try {
      const data = await apiGet<T>(path, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setSlot({ path, data, error: null, loading: false, receivedAt: Date.now() });
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      const failure: ApiFailure = toFailure(error);
      setSlot((prev) =>
        prev.path === path
          ? { ...prev, error: failure, loading: false }
          : { path, data: null, error: failure, loading: false, receivedAt: null },
      );
    }
  }, [path]);

  useEffect(() => {
    void load();
    return () => inflight.current?.abort();
  }, [load]);

  const reload = useCallback(() => void load(), [load]);
  if (slot.path !== path) {
    // The effect has not run yet for the new path: show «loading», never the old answer.
    return { data: null, error: null, loading: path !== null, receivedAt: null, reload };
  }
  return { data: slot.data, error: slot.error, loading: slot.loading, receivedAt: slot.receivedAt, reload };
}
