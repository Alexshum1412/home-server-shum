import {
  Activity,
  Bell,
  CalendarDays,
  Clapperboard,
  Download,
  FolderOpen,
  House,
  Images,
  ListChecks,
  MessagesSquare,
  NotebookPen,
  Printer,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserRound,
  X,
} from 'lucide-preact';
import { type ComponentChildren, createContext } from 'preact';
import { useContext, useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { SEARCH_KINDS, SEARCH_LABEL, type SearchKind, type SearchResponse } from '../../../shared/search.ts';
import { apiGet, isAbortError, NO_CONNECTION, toFailure } from '../api.ts';
import type { IconComponent } from '../components/icons.ts';
import { ROUTES, type RouteDef } from '../lib/routes.ts';
import { navigate } from '../router.ts';
import { useSession } from '../state.tsx';

const KIND_ICON: Record<SearchKind, IconComponent> = {
  media: Clapperboard,
  photos: Images,
  files: FolderOpen,
  notes: NotebookPen,
  events: CalendarDays,
  tasks: ListChecks,
  chats: MessagesSquare,
};

const PAGE_ICON: Record<string, IconComponent> = {
  home: House,
  cinema: Clapperboard,
  chat: MessagesSquare,
  photos: Images,
  files: FolderOpen,
  tasks: ListChecks,
  downloads: Download,
  calendar: CalendarDays,
  notes: NotebookPen,
  notifications: Bell,
  olivia: Sparkles,
  print: Printer,
  system: Activity,
  help: Smartphone,
  admin: ShieldCheck,
  account: UserRound,
};

/** Words people use for a page besides its name, so that «торрент» finds «Загрузки». */
const PAGE_WORDS: Record<string, string> = {
  home: 'домой начало',
  cinema: 'кино фильмы сериалы музыка аудиокниги',
  chat: 'сообщения переписка звонки',
  photos: 'фотографии снимки картинки альбомы',
  files: 'документы папки диск',
  tasks: 'дела задачи покупки список напоминания',
  downloads: 'торрент скачать закачки',
  calendar: 'события расписание дни рождения',
  notes: 'записки',
  notifications: 'оповещения',
  olivia: 'помощник ассистент',
  print: 'принтер печать',
  system: 'сервер компьютер диски состояние',
  help: 'подключение телефон установка tailscale',
  admin: 'пользователи пароли семья',
  account: 'профиль пароль тема',
};

const normalise = (text: string): string => text.toLowerCase().replace(/ё/g, 'е');

interface Entry {
  id: string;
  href: string;
  title: string;
  detail: string;
  icon: IconComponent;
}

interface Pane {
  key: string;
  label: string;
  icon: IconComponent;
  entries: Entry[];
  note: string | null;
}

const SearchContext = createContext<{ open: () => void }>({ open: () => undefined });
export const useSearch = () => useContext(SearchContext);

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Opens the search from anywhere: Ctrl+K (⌘K) always, «/» when nothing is being typed. */
export function SearchProvider(props: { children: ComponentChildren }) {
  const [shown, setShown] = useState(false);
  const value = useMemo(() => ({ open: () => setShown(true) }), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const combo = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k';
      const slash =
        event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isTyping(event.target);
      if (!combo && !slash) return;
      event.preventDefault();
      setShown(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <SearchContext.Provider value={value}>
      {props.children}
      {shown ? <SearchDialog onClose={() => setShown(false)} /> : null}
    </SearchContext.Provider>
  );
}

/** The button in the page header; on a phone only the magnifier is shown. */
export function SearchButton() {
  const { open } = useSearch();
  return (
    <button
      type="button"
      class="search-trigger"
      data-tour="search"
      onClick={open}
      aria-keyshortcuts="Control+K Meta+K"
    >
      <Search size={20} aria-hidden="true" />
      <span class="search-trigger__text">Поиск</span>
      <kbd class="search-trigger__key">Ctrl K</kbd>
    </button>
  );
}

function pageEntries(isAdmin: boolean, query: string): Entry[] {
  const needed = normalise(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const pages = ROUTES.filter((route: RouteDef) => route.id !== 'login' && (isAdmin || !route.adminOnly));
  return pages
    .filter((route) => {
      if (needed.length === 0) return true;
      const haystack = normalise(`${route.title} ${PAGE_WORDS[route.id] ?? ''}`);
      return needed.every((word) => haystack.includes(word.slice(0, Math.max(3, word.length - 2))));
    })
    .map((route) => ({
      id: `page:${route.id}`,
      href: route.path,
      title: route.title,
      detail: 'Открыть раздел',
      icon: PAGE_ICON[route.id] ?? House,
    }));
}

export function SearchDialog(props: { onClose: () => void }) {
  const ids = useId();
  const { session } = useSession();
  const isAdmin = session.user.role === 'admin';
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<SearchKind | 'all'>('all');
  const [answer, setAnswer] = useState<SearchResponse | null>(null);
  const [answered, setAnswered] = useState('');
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');
  const [retry, setRetry] = useState(0);

  const query = text.trim();
  const searching = query.length >= 2;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
  }, []);

  // Ask the server a moment after the last key; an older, slower answer never replaces a newer one.
  useEffect(() => {
    if (!searching) {
      setAnswer(null);
      setProblem('');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query });
        if (kind !== 'all') {
          params.set('kinds', kind);
          params.set('limit', '30');
        }
        const result = await apiGet<SearchResponse>(`/api/search?${params.toString()}`, {
          signal: controller.signal,
        });
        setAnswer(result);
        setAnswered(`${kind}:${query}`);
        setProblem('');
        setLoading(false);
      } catch (error) {
        if (isAbortError(error)) return;
        const failure = toFailure(error);
        setProblem(failure.unreachable ? NO_CONNECTION : failure.message);
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, kind, searching, retry]);

  const panes = useMemo<Pane[]>(() => {
    const out: Pane[] = [];
    const pages = pageEntries(isAdmin, searching ? query : '');
    if (kind === 'all' && pages.length > 0) {
      out.push({
        key: 'pages',
        label: searching ? 'Разделы' : 'Быстрый переход',
        icon: Search,
        entries: searching ? pages.slice(0, 3) : pages,
        note: null,
      });
    }
    if (searching && answer) {
      for (const group of answer.groups) {
        if (group.hits.length === 0 && group.unavailable === null) continue;
        const icon = KIND_ICON[group.kind];
        out.push({
          key: group.kind,
          label: group.label,
          icon,
          entries: group.hits.map((hit) => ({
            id: hit.id,
            href: hit.href,
            title: hit.title,
            detail: hit.detail,
            icon,
          })),
          note: group.unavailable
            ? `Недоступно: ${group.unavailable}`
            : group.more && kind === 'all'
              ? 'Показаны первые. Выберите это место выше, чтобы увидеть больше.'
              : group.more
                ? 'Показаны первые 30. Уточните запрос.'
                : null,
        });
      }
    }
    return out;
  }, [answer, isAdmin, kind, query, searching]);

  const flat = useMemo(() => panes.flatMap((pane) => pane.entries), [panes]);
  const shownHits = searching
    ? panes.filter((pane) => pane.key !== 'pages').reduce((n, pane) => n + pane.entries.length, 0)
    : 0;
  const settled = searching && answer !== null && answered === `${kind}:${query}` && !loading;

  function close() {
    dialogRef.current?.close();
  }

  function go(entry: Entry) {
    close();
    navigate(entry.href);
  }

  /** The arrow keys walk through the results (focus moves: the list is made of ordinary links). */
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('a.search__item') ?? []);
    if (links.length === 0) return;
    const at = links.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      links[at + 1 < links.length ? at + 1 : at]?.focus();
    } else if (at <= 0) {
      // From the first result back to the box.
      event.preventDefault();
      inputRef.current?.focus();
    } else {
      event.preventDefault();
      links[at - 1]?.focus();
    }
  }

  let status = '';
  if (problem) status = problem;
  else if (loading && searching) status = 'Ищу…';
  else if (settled) status = shownHits === 0 ? 'Ничего не найдено.' : `Найдено: ${shownHits}.`;

  const anyUnavailable = panes.some((pane) => pane.note?.startsWith('Недоступно'));

  return (
    <dialog
      ref={dialogRef}
      class="search-dialog"
      aria-label="Поиск по порталу"
      onClose={props.onClose}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === dialogRef.current) close();
      }}
    >
      <div class="search">
        <div class="search__bar">
          <Search size={22} aria-hidden="true" class="search__lens" />
          <input
            ref={inputRef}
            class="search__input"
            type="search"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            enterkeyhint="search"
            maxLength={80}
            aria-label="Что найти"
            placeholder="Фильм, фото, файл, заметка, событие, сообщение…"
            value={text}
            onInput={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Enter opens the first result; the arrow keys walk through the others.
              if (event.key === 'Enter' && flat[0]) {
                event.preventDefault();
                go(flat[0]);
              }
            }}
          />
          <button type="button" class="button button--quiet search__close" onClick={close}>
            <X size={20} aria-hidden="true" />
            <span class="search__close-text">Закрыть</span>
          </button>
        </div>

        <fieldset class="search__chips">
          <legend class="visually-hidden">Где искать</legend>
          <button type="button" class="chip" aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
            Везде
          </button>
          {SEARCH_KINDS.map((item) => (
            <button
              key={item}
              type="button"
              class="chip"
              aria-pressed={kind === item}
              onClick={() => setKind(item)}
            >
              {SEARCH_LABEL[item]}
            </button>
          ))}
        </fieldset>

        <p class="visually-hidden" role="status">
          {status}
        </p>

        <div class="search__results" aria-busy={loading}>
          {problem ? (
            <div class="search__empty" role="alert">
              <p>{problem}</p>
              <button type="button" class="button" onClick={() => setRetry((n) => n + 1)}>
                Повторить
              </button>
            </div>
          ) : null}
          {panes.map((pane) => {
            const Icon = pane.icon;
            return (
              <section key={pane.key} class="search__group" aria-labelledby={`${ids}-g-${pane.key}`}>
                <h3 id={`${ids}-g-${pane.key}`} class="search__group-title">
                  <Icon size={16} aria-hidden="true" />
                  {pane.label}
                </h3>
                <ul class="search__list">
                  {pane.entries.map((entry) => {
                    const EntryIcon = entry.icon;
                    return (
                      <li key={entry.id}>
                        <a
                          class="search__item"
                          href={entry.href}
                          onClick={(event) => {
                            // A click with Ctrl/⌘/Shift opens a new tab as usual; a plain one is handled here.
                            if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0)
                              return;
                            event.preventDefault();
                            go(entry);
                          }}
                        >
                          <EntryIcon size={20} aria-hidden="true" class="search__item-icon" />
                          <span class="search__item-text">
                            <span class="search__item-title">{entry.title}</span>
                            <span class="search__item-detail">{entry.detail}</span>
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
                {pane.note ? <p class="search__note">{pane.note}</p> : null}
              </section>
            );
          })}
          {settled && shownHits === 0 && !problem ? (
            <div class="search__empty">
              <p class="search__empty-title">Ничего не нашлось по «{query}»</p>
              {anyUnavailable ? (
                <p>Часть мест сейчас недоступна — они отмечены выше, там поиск не проверен.</p>
              ) : null}
              <p>
                Попробуйте другое слово или начало слова. Файлы и фотографии ищутся по названию, а не по
                содержимому; чужие личные записи, события и переписка в поиске не показываются.
              </p>
            </div>
          ) : null}
          {!searching ? (
            <p class="search__hint">
              Введите хотя бы две буквы. Поиск открывается сочетанием Ctrl+K или клавишей «/».
            </p>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}
