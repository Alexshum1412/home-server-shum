import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useState } from 'preact/hooks';
import type { CatalogMarks, CatalogMarkState, CatalogShelvesResponse } from '../../../shared/api.ts';
import { type ApiFailure, apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { useResource } from '../hooks/useResource.ts';
import { type MarkFlag, type MarkSets, toSets } from './lists.ts';

const MARK_FIELD: Record<MarkFlag, keyof CatalogMarks> = {
  favourite: 'favourites',
  later: 'later',
  watched: 'watched',
};

export interface ListsApi {
  /** The person's marks are known: the controls on the posters may be shown. */
  ready: boolean;
  sets: MarkSets;
  has(flag: MarkFlag, id: string): boolean;
  /** A change of this item is on its way to the server. */
  busy(id: string): boolean;
  /** Turns one mark of an item over. Resolves with a plain-words problem, or null when it was saved. */
  toggle(id: string, flag: MarkFlag): Promise<string | null>;
  /** The rows (null until they arrive, or when they could not be read). */
  shelves: CatalogShelvesResponse | null;
  shelvesError: ApiFailure | null;
  loading: boolean;
  reload(): void;
}

const NONE: ListsApi = {
  ready: false,
  sets: toSets(null),
  has: () => false,
  busy: () => false,
  toggle: async () => 'Отметки сейчас недоступны.',
  shelves: null,
  shelvesError: null,
  loading: false,
  reload: () => undefined,
};

export const ListsContext = createContext<ListsApi>(NONE);

export const useLists = (): ListsApi => useContext(ListsContext);

function withMark(marks: CatalogMarks, flag: MarkFlag, id: string, on: boolean): CatalogMarks {
  const field = MARK_FIELD[flag];
  const rest = marks[field].filter((other) => other !== id);
  return { ...marks, [field]: on ? [id, ...rest] : rest };
}

function withState(marks: CatalogMarks, state: CatalogMarkState): CatalogMarks {
  let next = withMark(marks, 'favourite', state.id, state.favourite);
  next = withMark(next, 'later', state.id, state.later);
  return withMark(next, 'watched', state.id, state.watched);
}

/**
 * Loads the rows once for the cinema page and keeps the marks of this person. A mark is shown at once
 * and taken back (with the reason) when the server does not accept it; the rows are fetched again
 * afterwards, in the background, so they follow the change.
 */
export function useListsState(): ListsApi {
  const shelves = useResource<CatalogShelvesResponse>('/api/catalog/shelves');
  const [marks, setMarks] = useState<CatalogMarks | null>(null);
  const [pending, setPending] = useState<readonly string[]>([]);
  const received = shelves.data?.marks ?? null;
  useEffect(() => {
    if (received) setMarks(received);
  }, [received]);

  const sets = useMemo(() => toSets(marks), [marks]);
  const reload = shelves.reload;

  const toggle = useCallback(
    async (id: string, flag: MarkFlag): Promise<string | null> => {
      if (marks === null) return 'Отметки ещё загружаются.';
      const was = marks[MARK_FIELD[flag]].includes(id);
      setMarks((current) => (current ? withMark(current, flag, id, !was) : current));
      setPending((current) => [...current, id]);
      try {
        const state = await apiPost<CatalogMarkState>('/api/catalog/marks', { id, [flag]: !was });
        setMarks((current) => (current ? withState(current, state) : current));
        reload();
        return null;
      } catch (error) {
        setMarks((current) => (current ? withMark(current, flag, id, was) : current));
        const failure = toFailure(error);
        return failure.unreachable ? NO_CONNECTION : failure.message;
      } finally {
        setPending((current) => {
          const at = current.indexOf(id);
          return at === -1 ? current : [...current.slice(0, at), ...current.slice(at + 1)];
        });
      }
    },
    [marks, reload],
  );

  return useMemo(
    () => ({
      ready: marks !== null,
      sets,
      has: (flag, id) => sets[flag].has(id),
      busy: (id) => pending.includes(id),
      toggle,
      shelves: shelves.data,
      shelvesError: shelves.data ? null : shelves.error,
      loading: shelves.loading,
      reload,
    }),
    [marks, sets, pending, toggle, shelves.data, shelves.error, shelves.loading, reload],
  );
}
