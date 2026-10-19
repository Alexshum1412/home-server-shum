import { ArrowLeft, Clapperboard, Sparkles, TriangleAlert } from 'lucide-preact';
import { useId } from 'preact/hooks';
import type { CatalogItem, CatalogLibrary, CatalogShelfEntry, CatalogShelvesResponse } from '../../../shared/api.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useLists } from './ListsProvider.tsx';
import { entriesOf, filterEntries, kindsOfLibrary, noteOf, VIEW_CHIP, VIEW_TITLE, type View, VIEWS } from './lists.ts';
import { MarkedPoster } from './Marks.tsx';

/** How many cards one row shows before «Показать все». */
const RAIL_SHOWN = 12;

/** A row of cards with an optional line under each (the reason, the date). */
export function Rail(props: {
  title: string;
  entries: ReadonlyArray<{ item: CatalogItem; note?: string }>;
  hrefOf: (item: CatalogItem) => string;
  onProblem: (text: string) => void;
  /** Where «Показать все» leads, and how many there are in all. */
  all?: { href: string; total: number };
  lead?: string;
}) {
  const ids = useId();
  if (props.entries.length === 0) return null;
  const shown = props.entries.slice(0, RAIL_SHOWN);
  return (
    <section class="rail" aria-labelledby={ids}>
      <div class="rail__head">
        <h2 id={ids} class="section-title">
          {props.title}
        </h2>
        {props.all && props.all.total > shown.length ? (
          <a class="text-link" href={props.all.href}>
            Показать все ({props.all.total})
            <span class="visually-hidden">: {props.title}</span>
          </a>
        ) : null}
      </div>
      {props.lead ? <p class="meta rail__lead">{props.lead}</p> : null}
      <ul class="rail__list">
        {shown.map(({ item, note }) => (
          <li key={item.id} class="rail__item">
            <MarkedPoster item={item} href={props.hrefOf(item)} note={note} onProblem={props.onProblem} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** «Мои подборки»: the chips that open one row as a page, so that search and filters work inside it. */
export function ViewChips(props: { current: View | ''; hrefOf: (view: View) => string }) {
  const lists = useLists();
  const shelves = lists.shelves;
  if (!shelves) return null;
  const counts: Record<View, number> = {
    foryou: shelves.forYou.length,
    news: shelves.news.length,
    later: shelves.later.length,
    favourites: shelves.favourites.length,
    history: shelves.history.length,
  };
  return (
    <nav class="chips" aria-label="Мои подборки">
      {VIEWS.map((view) => (
        <a
          key={view}
          class="chip"
          href={props.hrefOf(view)}
          aria-current={props.current === view ? 'page' : undefined}
        >
          {VIEW_CHIP[view]} · {counts[view]}
        </a>
      ))}
    </nav>
  );
}

interface RowProps {
  hrefOf: (item: CatalogItem) => string;
  viewHref: (view: View) => string;
  onProblem: (text: string) => void;
}

const asRow = (entries: CatalogShelfEntry[], view: View) =>
  entries.map((entry) => ({ item: entry.item, note: noteOf(view, entry) }));

/** The ids shown in «Новое»: «Недавно добавлено» does not repeat them. */
export function newIdsOf(shelves: CatalogShelvesResponse | null): ReadonlySet<string> {
  return new Set(shelves?.news.map((entry) => entry.item.id) ?? []);
}

/** «Для вас» and «Новое», or the reason why the personal rows are not there. */
export function TopRows(props: RowProps) {
  const lists = useLists();
  const { shelves } = lists;
  const hintId = useId();
  if (!shelves) {
    if (lists.shelvesError) {
      return (
        <div class="banner banner--info" role="status">
          <TriangleAlert class="banner__icon" size={20} aria-hidden="true" />
          <span class="banner__body">
            Ваши подборки сейчас недоступны: {lists.shelvesError.message}{' '}
            <button type="button" class="button button--quiet" onClick={lists.reload}>
              Повторить
            </button>
          </span>
        </div>
      );
    }
    return lists.loading ? <Loading label="Собираем ваши подборки…" /> : null;
  }
  return (
    <>
      {shelves.reason ? (
        <p class="banner banner--warn" role="status">
          <TriangleAlert class="banner__icon" size={20} aria-hidden="true" />
          Подборки временно пусты: {shelves.reason}
        </p>
      ) : null}
      {shelves.reason ? null : shelves.forYou.length > 0 ? (
        <Rail
          title="Для вас"
          lead="Подобрано по вашим отметкам и по тому, что смотрит семья. У каждого предложения — причина."
          entries={asRow(shelves.forYou, 'foryou')}
          hrefOf={props.hrefOf}
          onProblem={props.onProblem}
          all={{ href: props.viewHref('foryou'), total: shelves.forYou.length }}
        />
      ) : shelves.forYouHint ? (
        <section class="rail" aria-labelledby={hintId}>
          <h2 id={hintId} class="section-title">
            Для вас
          </h2>
          <p class="meta">
            <Sparkles size={16} aria-hidden="true" class="inline-icon" /> {shelves.forYouHint}
          </p>
        </section>
      ) : null}
      <Rail
        title="Новое"
        lead="Добавлено в медиатеку за последние две недели."
        entries={asRow(shelves.news, 'news')}
        hrefOf={props.hrefOf}
        onProblem={props.onProblem}
        all={{ href: props.viewHref('news'), total: shelves.news.length }}
      />
    </>
  );
}

/** «Мой список», «Избранное» and «История»: the person's own rows. */
export function MyRows(props: RowProps) {
  const { shelves } = useLists();
  if (!shelves) return null;
  return (
    <>
      <Rail
        title="Мой список"
        lead="То, что вы отложили на потом."
        entries={asRow(shelves.later, 'later')}
        hrefOf={props.hrefOf}
        onProblem={props.onProblem}
        all={{ href: props.viewHref('later'), total: shelves.later.length }}
      />
      <Rail
        title="Избранное"
        entries={asRow(shelves.favourites, 'favourites')}
        hrefOf={props.hrefOf}
        onProblem={props.onProblem}
        all={{ href: props.viewHref('favourites'), total: shelves.favourites.length }}
      />
      <Rail
        title="История: что я смотрел"
        lead="Видите только вы."
        entries={asRow(shelves.history, 'history')}
        hrefOf={props.hrefOf}
        onProblem={props.onProblem}
        all={{ href: props.viewHref('history'), total: shelves.history.length }}
      />
    </>
  );
}
/** One row as a page: its cards in a grid, narrowed by the page's library, genre and title search. */
export function ListView(props: {
  view: View;
  libraries: CatalogLibrary[];
  lib: string;
  genre: string;
  q: string;
  hrefOf: (item: CatalogItem) => string;
  backHref: string;
  onProblem: (text: string) => void;
}) {
  const lists = useLists();
  const { shelves } = lists;
  const { view } = props;
  const headingId = useId();
  const back = (
    <p>
      <a class="text-link" href={props.backHref}>
        <ArrowLeft size={18} aria-hidden="true" /> Все подборки
      </a>
    </p>
  );
  if (!shelves) {
    if (lists.shelvesError) {
      return (
        <>
          {back}
          <ErrorState failure={lists.shelvesError} onRetry={lists.reload} busy={lists.loading} level={2} />
        </>
      );
    }
    return (
      <>
        {back}
        <Loading label="Собираем ваши подборки…" />
      </>
    );
  }
  if (shelves.reason) {
    return (
      <>
        {back}
        <EmptyState icon={TriangleAlert} title="Подборка сейчас недоступна" level={2}>
          {shelves.reason}
        </EmptyState>
      </>
    );
  }
  const all = entriesOf(shelves, view);
  const library = props.libraries.find((item) => item.id === props.lib);
  const found = filterEntries(all, {
    kinds: library ? kindsOfLibrary(library.kind) : null,
    genre: props.genre,
    q: props.q,
  });
  const narrowed = props.lib !== '' || props.genre !== '' || props.q !== '';
  return (
    <section aria-labelledby={headingId}>
      {back}
      <h2 id={headingId} class="section-title">
        {VIEW_TITLE[view]}
      </h2>
      {view === 'history' ? <p class="meta">Видите только вы.</p> : null}
      {found.length === 0 ? (
        <EmptyState icon={Clapperboard} title={narrowed ? 'Ничего не найдено' : 'Здесь пока пусто'} level={3}>
          {narrowed
            ? 'В этой подборке нет подходящих. Попробуйте другое слово, другой жанр или раздел «Всё».'
            : view === 'foryou'
              ? (shelves.forYouHint ?? 'Пока нечего предложить.')
              : view === 'news'
                ? 'За последние две недели в медиатеку ничего не добавлялось.'
                : view === 'history'
                  ? 'Когда вы что-нибудь посмотрите, это появится здесь.'
                  : 'Нажмите на сердечко или закладку на афише, и фильм появится здесь.'}
        </EmptyState>
      ) : (
        <>
          <p class="meta cinema-count" role="status">
            {narrowed ? `Найдено: ${found.length} из ${all.length}` : `Всего: ${all.length}`}
          </p>
          <ul class="poster-grid">
            {found.map((entry) => (
              <li key={entry.item.id}>
                <MarkedPoster
                  item={entry.item}
                  href={props.hrefOf(entry.item)}
                  note={noteOf(view, entry)}
                  onProblem={props.onProblem}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
