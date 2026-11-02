import { BookOpen, ChevronLeft, ChevronRight, FileText, X } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes } from '../lib/format.ts';

interface Book {
  id: string;
  title: string;
  kind: 'cbz' | 'pdf';
  folder: string;
  sizeBytes: number;
}

const progressKey = (id: string) => `comics:page:${id}`;
const savedPage = (id: string): number => {
  try {
    return Math.max(0, Number(localStorage.getItem(progressKey(id))) || 0);
  } catch {
    return 0;
  }
};

/** The reader: one page at a time, tap the sides or use the arrows; the place is remembered on this device. */
function Reader(props: { book: Book; onClose: () => void }) {
  const { book } = props;
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(() => savedPage(book.id));
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    void fetch(`/api/comics/${book.id}/pages`, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('bad');
        setCount(((await response.json()) as { pages: number }).pages);
      })
      .catch(() => setFailed(true));
  }, [book.id]);

  const last = (count ?? 1) - 1;
  const go = (next: number) => {
    const clamped = Math.min(Math.max(0, next), last);
    setPage(clamped);
    try {
      localStorage.setItem(progressKey(book.id), String(clamped));
    } catch {
      // the place is simply not remembered
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
      else if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        go(page + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') go(page - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The next page is fetched ahead, so turning feels instant.
  useEffect(() => {
    if (count !== null && page < last) new Image().src = `/api/comics/${book.id}/page/${page + 1}`;
  }, [page, count, last, book.id]);

  return (
    <div class="reader" role="dialog" aria-modal="true" aria-label={`Чтение: ${book.title}`}>
      <header class="reader__bar">
        <button
          ref={closeRef}
          type="button"
          class="reader__icon"
          onClick={props.onClose}
          aria-label="Закрыть"
        >
          <X size={22} aria-hidden="true" />
        </button>
        <strong class="reader__title">{book.title}</strong>
        <span class="reader__count" aria-live="polite">
          {count === null ? '' : `${page + 1} / ${count}`}
        </span>
      </header>
      <div class="reader__stage">
        {failed ? (
          <p class="reader__message">Этот файл не открывается: он повреждён или это не архив комикса.</p>
        ) : count === null ? (
          <p class="reader__message">Открываю…</p>
        ) : count === 0 ? (
          <p class="reader__message">В этом файле нет картинок.</p>
        ) : (
          <img
            class="reader__page"
            src={`/api/comics/${book.id}/page/${page}`}
            alt={`Страница ${page + 1} из ${count}`}
            draggable={false}
          />
        )}
        <button
          type="button"
          class="reader__tap reader__tap--prev"
          onClick={() => go(page - 1)}
          disabled={page <= 0}
          aria-label="Предыдущая страница"
        >
          <ChevronLeft size={28} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="reader__tap reader__tap--next"
          onClick={() => go(page + 1)}
          disabled={count === null || page >= last}
          aria-label="Следующая страница"
        >
          <ChevronRight size={28} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** «Комиксы и манга»: the family's comics read right in the portal (cbz page by page, pdf in the browser's viewer). */
export function ComicsPage() {
  const data = useResource<{ folder: string; books: Book[] }>('/api/comics');
  const [open, setOpen] = useState<Book | null>(null);
  const d = data.data;

  return (
    <div class="page">
      <PageHeader
        title="Комиксы, манга и книги"
        icon={BookOpen}
        lead="Читалка прямо в портале: работает с телефона и из любой сети, где открывается сервер. Место, где вы остановились, запоминается на этом устройстве."
      />
      {data.error && !d ? (
        <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />
      ) : null}
      {!d && !data.error ? <Loading label="Загружаем…" /> : null}
      {d && d.books.length === 0 ? (
        <section class="page-section">
          <h2 class="section-title">Пока здесь пусто</h2>
          <p class="section-lead">
            Положите файлы комиксов (.cbz — архив с картинками, или .pdf) в папку «{d.folder}» на сервере —
            они появятся здесь сразу. Папки внутри можно использовать как серии.
          </p>
        </section>
      ) : null}
      {d && d.books.length > 0 ? (
        <ul class="shelf">
          {d.books.map((book) => (
            <li key={book.id} class="shelf__item">
              {book.kind === 'pdf' ? (
                <a
                  class="shelf__card"
                  href={`/api/comics/${book.id}/file`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span class="shelf__cover shelf__cover--pdf">
                    <FileText size={36} aria-hidden="true" />
                  </span>
                  <span class="shelf__title">{book.title}</span>
                  <span class="shelf__meta">PDF · {formatBytes(book.sizeBytes)}</span>
                </a>
              ) : (
                <button type="button" class="shelf__card" onClick={() => setOpen(book)}>
                  <span class="shelf__cover">
                    <img src={`/api/comics/${book.id}/page/0`} alt="" loading="lazy" />
                  </span>
                  <span class="shelf__title">{book.title}</span>
                  <span class="shelf__meta">
                    {book.folder ? `${book.folder} · ` : ''}
                    {formatBytes(book.sizeBytes)}
                    {savedPage(book.id) > 0 ? ` · стр. ${savedPage(book.id) + 1}` : ''}
                  </span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {open ? <Reader book={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
