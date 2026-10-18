/** Contract of the unified search (Ctrl+K): GET /api/search. */

export type SearchKind = 'media' | 'photos' | 'files' | 'notes' | 'events' | 'tasks' | 'chats';

export interface SearchHit {
  /** Stable within one answer; used as the list key. */
  id: string;
  kind: SearchKind;
  title: string;
  /** One line under the title: where it lies, when it is, who wrote it. */
  detail: string;
  /** Page inside the portal that shows the result. */
  href: string;
}

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  hits: SearchHit[];
  /** True when the group stopped at its limit and there may be more. */
  more: boolean;
  /** Why this place could not be searched, in plain words; the hits are then empty. */
  unavailable: string | null;
}

export interface SearchResponse {
  query: string;
  groups: SearchGroup[];
}

export const SEARCH_LABEL: Record<SearchKind, string> = {
  media: 'Фильмы и музыка',
  photos: 'Фото и видео',
  files: 'Файлы и документы',
  notes: 'Заметки',
  events: 'События календаря',
  tasks: 'Дела',
  chats: 'Сообщения',
};

export const SEARCH_KINDS: readonly SearchKind[] = [
  'media',
  'photos',
  'files',
  'notes',
  'events',
  'tasks',
  'chats',
];
