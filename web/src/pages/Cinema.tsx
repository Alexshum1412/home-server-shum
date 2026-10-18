import { Clapperboard, ExternalLink, Pause, Play, Search, TriangleAlert, X } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type {
  CatalogDetailResponse,
  CatalogHomeResponse,
  CatalogItem,
  CatalogItemsResponse,
} from '../../../shared/api.ts';
import { apiPost } from '../api.ts';
import { kindLabel, Poster, PosterCard, watchedShare } from '../cinema/Poster.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useResource } from '../hooks/useResource.ts';
import { readParam, withQuery } from '../lib/query.ts';
import { navigate, useLocation } from '../router.ts';
import { ServicePage } from './Service.tsx';

const SAVE_EVERY_MS = 10_000;
const SORT_LABEL = { name: 'По названию', added: 'Сначала новые', year: 'По году' } as const;
type Sort = keyof typeof SORT_LABEL;

interface Filters {
  lib: string;
  q: string;
  genre: string;
  sort: Sort;
}

function readFilters(search: string): Filters {
  const sort = readParam(search, 'sort');
  return {
    lib: readParam(search, 'lib'),
    q: readParam(search, 'q'),
    genre: readParam(search, 'genre'),
    sort: sort === 'added' || sort === 'year' ? sort : 'name',
  };
}

const address = (filters: Filters, extra: Record<string, string> = {}) =>
  withQuery('/cinema', {
    lib: filters.lib,
    q: filters.q,
    genre: filters.genre,
    sort: filters.sort === 'name' ? '' : filters.sort,
    ...extra,
  });

function minutes(total: number | null): string {
  if (total === null) return '';
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours} ч ${rest} мин` : `${rest} мин`;
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** The film or the chapter, played by the browser; the place is sent to the portal every few seconds. */
function Player(props: { detail: CatalogDetailResponse; onProblem: () => void }) {
  const { detail } = props;
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const lastSave = useRef(0);
  const id = detail.item.id;

  function report(force = false) {
    const element = media.current;
    if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return;
    if (!force && Date.now() - lastSave.current < SAVE_EVERY_MS) return;
    lastSave.current = Date.now();
    apiPost('/api/catalog/progress', {
      id,
      positionSec: Math.floor(element.currentTime),
      durationSec: Math.floor(element.duration),
    }).catch(() => undefined);
  }

  useEffect(() => () => report(true), []);

  const common = {
    ref: media,
    src: `/api/catalog/stream/${id}${detail.media === 'audio' ? '?as=audio' : ''}`,
    controls: true,
    autoPlay: true,
    playsInline: true,
    preload: 'metadata' as const,
    onLoadedMetadata: () => {
      const element = media.current;
      const at = detail.item.resumeSec;
      if (element && at && at > 5 && at < element.duration - 8) element.currentTime = at;
    },
    onTimeUpdate: () => report(),
    onPause: () => report(true),
    onEnded: () => report(true),
    onError: props.onProblem,
  };
  return detail.media === 'audio' ? (
    <audio {...common} class="cinema-player__audio" />
  ) : (
    <video {...common} class="cinema-player__video" />
  );
}

function ItemDialog(props: { id: string; filters: Filters; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const detail = useResource<CatalogDetailResponse>(`/api/catalog/items/${props.id}`);
  const [playing, setPlaying] = useState(false);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  // Another item (a season, an episode) opens in the same window from the start.
  useEffect(() => {
    setPlaying(false);
    setProblem(false);
  }, [props.id]);

  const data = detail.data;
  const item = data?.item;
  const jellyfinLink = data?.jellyfinUrl
    ? `${data.jellyfinUrl}/web/index.html#!/details?id=${props.id}`
    : null;
  const canPlay = data !== null && data.media !== null && data.playback !== 'jellyfin';

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only closes the dialog on the dark area; Escape and «Закрыть» do the same from the keyboard
    <dialog
      ref={ref}
      class="cinema-dialog"
      aria-labelledby={titleId}
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
    >
      <div class="cinema-dialog__bar">
        <h2 id={titleId} class="cinema-dialog__title">
          {item?.title ?? 'Загружаем…'}
        </h2>
        <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
          <X size={20} aria-hidden="true" />
          Закрыть
        </button>
      </div>
      {detail.error && !data ? (
        <ErrorState failure={detail.error} onRetry={detail.reload} busy={detail.loading} level={3} />
      ) : null}
      {!data && !detail.error ? <Loading label="Загружаем описание…" /> : null}
      {data && item ? (
        <div class="cinema-dialog__body">
          {playing && canPlay && !problem ? (
            <div class="cinema-player">
              <Player detail={data} onProblem={() => setProblem(true)} />
              <button type="button" class="button button--quiet" onClick={() => setPlaying(false)}>
                <Pause size={18} aria-hidden="true" />
                Остановить и вернуться к описанию
              </button>
            </div>
          ) : (
            <div class="cinema-info">
              <span class="cinema-info__poster">
                <Poster item={item} width={400} />
              </span>
              <div class="cinema-info__text">
                <p class="cinema-info__facts">
                  {[
                    kindLabel(item.kind),
                    item.year,
                    minutes(item.runtimeMin),
                    item.rating ? `оценка ${item.rating}` : '',
                  ]
                    .filter((part) => part !== null && part !== '')
                    .join(' · ')}
                </p>
                {item.genres.length > 0 ? <p class="cinema-info__genres">{item.genres.join(', ')}</p> : null}
                {data.overview ? <p class="cinema-info__overview">{data.overview}</p> : null}
                {problem ? (
                  <p class="banner banner--warn" role="alert">
                    <TriangleAlert size={20} aria-hidden="true" />
                    Браузер не смог воспроизвести этот файл (формат или кодек не поддерживается). Откройте его
                    в Jellyfin: он перекодирует видео на лету.
                  </p>
                ) : data.playbackNote && data.media !== null ? (
                  <p class="banner banner--info">{data.playbackNote}</p>
                ) : null}
                <div class="cinema-info__actions">
                  {canPlay && !problem ? (
                    <button
                      type="button"
                      class="button button--primary button--large"
                      onClick={() => setPlaying(true)}
                    >
                      <Play size={20} aria-hidden="true" />
                      {item.resumeSec
                        ? `Продолжить с ${formatSeconds(item.resumeSec)}`
                        : data.media === 'audio'
                          ? 'Слушать'
                          : 'Смотреть'}
                    </button>
                  ) : null}
                  {data.media !== null && jellyfinLink ? (
                    <a
                      class={
                        canPlay && !problem
                          ? 'button button--secondary'
                          : 'button button--primary button--large'
                      }
                      href={jellyfinLink}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={18} aria-hidden="true" />
                      Открыть в Jellyfin<span class="visually-hidden"> (в новой вкладке)</span>
                    </a>
                  ) : null}
                </div>
                {data.media !== null ? (
                  <p class="meta">
                    {[
                      data.container,
                      data.videoCodec,
                      data.audioCodec,
                      data.width && data.height ? `${data.width}×${data.height}` : '',
                    ]
                      .filter((part) => part)
                      .join(' · ')}
                  </p>
                ) : null}
              </div>
            </div>
          )}
          {data.children.length > 0 && !(playing && canPlay && !problem) ? (
            <section
              class="cinema-children"
              aria-label={
                data.item.kind === 'series'
                  ? 'Сезоны'
                  : data.item.kind === 'season'
                    ? 'Серии'
                    : 'Главы и треки'
              }
            >
              <ul class="cinema-children__list">
                {data.children.map((child) => (
                  <li key={child.id}>
                    <a class="cinema-children__row" href={address(props.filters, { item: child.id })}>
                      <span class="cinema-children__no">{child.episode ?? ''}</span>
                      <span class="cinema-children__name">{child.title}</span>
                      <span class="meta">{minutes(child.runtimeMin)}</span>
                      {watchedShare(child) !== null ? (
                        <span class="meta">просмотрено {watchedShare(child)} %</span>
                      ) : null}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

function Rail(props: { title: string; items: CatalogItem[]; filters: Filters }) {
  const ids = useId();
  if (props.items.length === 0) return null;
  return (
    <section class="rail" aria-labelledby={ids}>
      <h2 id={ids} class="section-title">
        {props.title}
      </h2>
      <ul class="rail__list">
        {props.items.map((item) => (
          <li key={item.id} class="rail__item">
            <PosterCard item={item} href={address(props.filters, { item: item.id })} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Toolbar(props: { home: CatalogHomeResponse; filters: Filters }) {
  const { home, filters } = props;
  const [text, setText] = useState(filters.q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setText(filters.q), [filters.q]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const go = (next: Partial<Filters>) => navigate(address({ ...filters, ...next }), { replace: true });
  const onInput = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => go({ q: value.trim() }), 350);
  };

  return (
    <div class="cinema-tools">
      <form
        class="cinema-search"
        aria-label="Поиск"
        onSubmit={(event) => {
          event.preventDefault();
          clearTimeout(timer.current);
          go({ q: text.trim() });
        }}
      >
        <label class="visually-hidden" htmlFor="cinema-q">
          Поиск по названию
        </label>
        <Search size={20} aria-hidden="true" class="cinema-search__icon" />
        <input
          id="cinema-q"
          class="field__input cinema-search__input"
          type="search"
          placeholder="Найти фильм, сериал, песню…"
          value={text}
          maxLength={100}
          onInput={(event) => onInput(event.currentTarget.value)}
        />
      </form>
      <nav class="chips" aria-label="Разделы медиатеки">
        <a
          class="chip"
          href={address({ ...filters, lib: '' })}
          aria-current={filters.lib === '' ? 'page' : undefined}
        >
          Всё
        </a>
        {home.libraries.map((library) => (
          <a
            key={library.id}
            class="chip"
            href={address({ ...filters, lib: library.id })}
            aria-current={filters.lib === library.id ? 'page' : undefined}
          >
            {library.name}
          </a>
        ))}
      </nav>
      <div class="cinema-tools__row">
        {home.genres.length > 0 ? (
          <label class="cinema-select">
            <span class="field__label">Жанр</span>
            <select
              class="field__input"
              value={filters.genre}
              onChange={(event) => go({ genre: event.currentTarget.value })}
            >
              <option value="">Все жанры</option>
              {home.genres.map((genre) => (
                <option key={genre} value={genre}>
                  {genre}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label class="cinema-select">
          <span class="field__label">Порядок</span>
          <select
            class="field__input"
            value={filters.sort}
            onChange={(event) => go({ sort: event.currentTarget.value as Sort })}
          >
            {(Object.keys(SORT_LABEL) as Sort[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABEL[key]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function Results(props: { filters: Filters; home: CatalogHomeResponse }) {
  const { filters } = props;
  const query = new URLSearchParams({ sort: filters.sort, limit: '100' });
  if (filters.lib) query.set('library', filters.lib);
  if (filters.q) query.set('q', filters.q);
  if (filters.genre) query.set('genre', filters.genre);
  const result = useResource<CatalogItemsResponse>(`/api/catalog/items?${query.toString()}`);
  if (result.error && !result.data)
    return <ErrorState failure={result.error} onRetry={result.reload} busy={result.loading} level={2} />;
  if (!result.data) return <Loading label="Ищем…" />;
  if (result.data.items.length === 0) {
    return (
      <EmptyState icon={Clapperboard} title="Ничего не найдено" level={2}>
        Попробуйте другое слово, другой жанр или раздел «Всё».
      </EmptyState>
    );
  }
  return (
    <section aria-label="Найденное">
      <p class="meta cinema-count" role="status">
        Найдено: {result.data.total}
        {result.data.total > result.data.items.length ? `, показаны первые ${result.data.items.length}` : ''}
      </p>
      <ul class="poster-grid">
        {result.data.items.map((item) => (
          <li key={item.id}>
            <PosterCard item={item} href={address(filters, { item: item.id })} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Catalog(props: { home: CatalogHomeResponse }) {
  const { search } = useLocation();
  const filters = readFilters(search);
  const itemId = readParam(search, 'item');
  const filtered = filters.lib !== '' || filters.q !== '' || filters.genre !== '' || filters.sort !== 'name';
  const { home } = props;

  return (
    <>
      <Toolbar home={home} filters={filters} />
      {filtered ? (
        <Results filters={filters} home={home} />
      ) : (
        <>
          <Rail title="Продолжить просмотр" items={home.continueWatching} filters={filters} />
          <Rail title="Недавно добавлено" items={home.latest} filters={filters} />
          {home.continueWatching.length === 0 && home.latest.length === 0 ? (
            <EmptyState icon={Clapperboard} title="В медиатеке пока ничего нет">
              Положите фильмы в папку C:\FamilyData\Media (администратор знает как) — они появятся здесь после
              сканирования Jellyfin.
            </EmptyState>
          ) : null}
        </>
      )}
      {itemId !== '' ? (
        <ItemDialog
          key={itemId}
          id={itemId}
          filters={filters}
          onClose={() => navigate(address(filters), { replace: true })}
        />
      ) : null}
      <p class="meta cinema-footer">
        Не открывается или нужен запасной способ?{' '}
        <a class="text-link" href={withQuery('/cinema', { fallback: '1' })}>
          Запасной просмотр без Jellyfin и состояние кинотеатра
        </a>
        {home.jellyfinUrl ? (
          <>
            {' · '}
            <a class="text-link" href={home.jellyfinUrl} target="_blank" rel="noopener noreferrer">
              Открыть Jellyfin целиком<span class="visually-hidden"> (в новой вкладке)</span>
            </a>
          </>
        ) : null}
      </p>
    </>
  );
}

/** «Кинотеатр»: posters, search, genres and «continue watching» from Jellyfin; the old page remains as the fallback. */
export function CinemaPage() {
  const { search } = useLocation();
  const fallback = readParam(search, 'fallback') === '1';
  const home = useResource<CatalogHomeResponse>(fallback ? null : '/api/catalog');

  if (fallback) {
    return (
      <>
        <ServicePage kind="media" openFallback />
        <p class="meta cinema-footer">
          <a class="text-link" href="/cinema">
            ← К афишам кинотеатра
          </a>
        </p>
      </>
    );
  }
  if (!home.data && home.error) {
    return (
      <>
        <PageHeader title="Кинотеатр" icon={Clapperboard} />
        <ErrorState failure={home.error} onRetry={home.reload} busy={home.loading} />
      </>
    );
  }
  if (!home.data) {
    return (
      <>
        <PageHeader title="Кинотеатр" icon={Clapperboard} />
        <Loading label="Открываем медиатеку…" />
      </>
    );
  }
  if (!home.data.available) {
    // Jellyfin is down or not set up: the honest reason first, then the page that always worked.
    return (
      <>
        <p class="banner banner--warn" role="status">
          <TriangleAlert size={20} aria-hidden="true" />
          Афиши недоступны: {home.data.reason ?? 'Jellyfin не отвечает.'} Ниже — запасной способ.
        </p>
        <ServicePage kind="media" />
      </>
    );
  }
  return (
    <div class="page">
      <PageHeader
        title="Кинотеатр"
        icon={Clapperboard}
        lead="Фильмы, сериалы, музыка и аудиокниги семьи. Нажмите на афишу, чтобы смотреть."
      />
      <Catalog home={home.data} />
    </div>
  );
}
