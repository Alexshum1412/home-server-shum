import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { apiGet, isAbortError, toFailure } from '../api.ts';
import type { RemoteData } from './usePolling.ts';

export interface ResourceResult<T> extends RemoteData<T> {
  reload: () => void;
}

/** One-shot GET with loading / error / retry states; pass `null` to skip loading. */
export function useResource<T>(path: string | null): ResourceResult<T> {
  const [state, setState] = useState<RemoteData<T>>({
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
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await apiGet<T>(path, { signal: controller.signal });
      if (!controller.signal.aborted) setState({ data, error: null, loading: false, receivedAt: Date.now() });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      setState((prev) => ({ ...prev, error: toFailure(error), loading: false }));
    }
  }, [path]);

  useEffect(() => {
    void load();
    return () => inflight.current?.abort();
  }, [load]);

  const reload = useCallback(() => void load(), [load]);
  return { ...state, reload };
}
