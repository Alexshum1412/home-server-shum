import { Library as LibraryIcon, Search } from 'lucide-preact';
import { useId, useState } from 'preact/hooks';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes } from '../lib/format.ts';

interface Book {
  name: string;
  file: string;
  title: string;
  sizeBytes: number;
  downloading: boolean;
}
interface LibraryState {
  books: Book[];
  serving: boolean;
  folder: string;
  root: string;
}

/** «Офлайн-библиотека»: Wikipedia and other reference books that live on this PC and open without the internet. */
export function LibraryPage() {
  const ids = useId();
  const data = useResource<LibraryState>('/api/library');
  const [query, setQuery] = useState('');
  const [book, setBook] = useState('');
  const d = data.data;
  const ready = d?.books.filter((item) => !item.downloading) ?? [];
  const chosen = book || ready[0]?.name || '';

  return (
    <div class="page page--narrow">
      <PageHeader
        title="Офлайн-библиотека"
        icon={LibraryIcon}
        lead="Википедия и справочники, скачанные на сервер заранее. Они открываются без интернета: если связь пропала надолго, вы всё равно сможете «погуглить» в них с телефона или телевизора, пока работают сервер и домашняя сеть."
      />
      {data.error && !d ? (
        <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />
      ) : null}
      {!d && !data.error ? <Loading label="Загружаем…" /> : null}
      {d ? (
        <>
          {!d.serving ? (
            <p class="banner banner--warn" role="status">
              Библиотека сейчас не запущена
              {ready.length === 0
                ? ': книги ещё скачиваются или не добавлены.'
                : '. Администратор может запустить её на странице «Сервер» («Офлайн-библиотека (Kiwix)»).'}
            </p>
          ) : null}
          {d.serving && ready.length > 0 ? (
            <section class="page-section" aria-labelledby={`${ids}-find`}>
              <h2 id={`${ids}-find`} class="section-title">
                Искать
              </h2>
              <form class="action-row" method="get" action={`${d.root}/search`}>
                <label class="visually-hidden" htmlFor={`${ids}-q`}>
                  Что найти в офлайн-библиотеке
                </label>
                <input
                  id={`${ids}-q`}
                  class="field__input"
                  name="pattern"
                  placeholder="Например: первая помощь при ожоге"
                  value={query}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                />
                <select
                  class="field__input"
                  name="content"
                  aria-label="Где искать"
                  value={chosen}
                  onChange={(e) => setBook(e.currentTarget.value)}
                >
                  {ready.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.title}
                    </option>
                  ))}
                </select>
                <button type="submit" class="button button--primary">
                  <Search size={18} aria-hidden="true" />
                  Найти
                </button>
              </form>
              <p>
                <a class="button button--secondary" href={`${d.root}/`}>
                  Открыть всю библиотеку
                </a>
              </p>
            </section>
          ) : null}
          <section class="page-section">
            <h2 class="section-title">Что скачано</h2>
            {d.books.length === 0 ? (
              <p class="section-lead">
                Пока ничего. Книги кладутся в папку {d.folder} (файлы .zim с сайта download.kiwix.org).
              </p>
            ) : (
              <ul>
                {d.books.map((item) => (
                  <li key={item.file}>
                    <strong>{item.title}</strong>{' '}
                    <span class="meta">
                      — {formatBytes(item.sizeBytes)}
                      {item.downloading ? ', ещё скачивается' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p class="meta">
              Содержимое — копия Википедии и родственных проектов на дату скачивания, без новостей после неё.
              Это сделано для случая, когда интернета нет; обычные вопросы Оливия по-прежнему ищет в сети.
            </p>
          </section>
          <section class="page-section">
            <h2 class="section-title">Ещё без интернета</h2>
            <p>
              Сохранённые страницы и поиск по ним и по заметкам —{' '}
              <a href="/archive">«Память» → «Знания и страницы»</a>. Экстренная карточка семьи с телефонами и
              важными сведениями — <a href="/emergency">«Память» → «Экстренная карточка»</a>.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
