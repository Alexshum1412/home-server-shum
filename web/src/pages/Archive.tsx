import { BookOpen, Download, Save, Search, Trash2 } from 'lucide-preact';
import { useId, useState } from 'preact/hooks';
import { apiGet, apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatDateTime } from '../lib/format.ts';

interface Page {
  id: string;
  url: string;
  title: string;
  savedAt: string;
  shared: boolean;
  owner: string;
  chars: number;
}
interface Hit {
  kind: 'page' | 'note';
  title: string;
  snippet: string;
  href: string;
}
interface ArchiveResponse {
  pages: Page[];
  hits: Hit[];
  query: string;
}

/** «Знания»: pages saved for later (a small ArchiveBox) and a search over saved pages and notes. */
export function ArchivePage() {
  const ids = useId();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const data = useResource<ArchiveResponse>(`/api/archive${asked ? `?q=${encodeURIComponent(asked)}` : ''}`);
  const [url, setUrl] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ title: string; text: string } | null>(null);

  async function run<T>(job: () => Promise<T>, ok: string) {
    setBusy(true);
    try {
      await job();
      if (ok) toast.showOk(ok);
      data.reload();
    } catch (error) {
      const failure = toFailure(error);
      toast.showError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  const d = data.data;
  return (
    <div class="page">
      <PageHeader
        title="Знания и сохранённые страницы"
        icon={BookOpen}
        lead="Сохраните страницу из интернета — она останется у нас, даже если сайт пропадёт. Оливия умеет искать по сохранённым страницам и заметкам: спросите «что я сохранял про …»."
      />
      <section class="page-section" aria-labelledby={`${ids}-find`}>
        <h2 id={`${ids}-find`} class="section-title">
          Найти
        </h2>
        <form
          class="action-row"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(query.trim());
          }}
        >
          <label class="visually-hidden" htmlFor={`${ids}-q`}>
            Что найти в сохранённых страницах и заметках
          </label>
          <input
            id={`${ids}-q`}
            class="field__input"
            placeholder="Слова из страницы или заметки"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button type="submit" class="button button--primary">
            <Search size={18} aria-hidden="true" />
            Найти
          </button>
        </form>
        {d && d.query !== '' ? (
          d.hits.length === 0 ? (
            <p class="section-lead">Ничего не нашлось. Попробуйте другие слова.</p>
          ) : (
            <ul class="archive__hits">
              {d.hits.map((hit) => (
                <li key={`${hit.kind}-${hit.href}`}>
                  <a href={hit.href}>
                    {hit.kind === 'page' ? '🌐' : '📝'} {hit.title}
                  </a>
                  <p class="meta">{hit.snippet}</p>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>

      <section class="page-section" aria-labelledby={`${ids}-save`}>
        <h2 id={`${ids}-save`} class="section-title">
          Сохранить страницу
        </h2>
        <form
          class="action-row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await apiPost('/api/archive/save', { url: url.trim(), shared });
              setUrl('');
            }, 'Страница сохранена.');
          }}
        >
          <label class="visually-hidden" htmlFor={`${ids}-url`}>
            Адрес страницы
          </label>
          <input
            id={`${ids}-url`}
            class="field__input"
            type="url"
            placeholder="https://…"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
          <button type="submit" class="button button--primary" disabled={busy || url.trim() === ''}>
            <Save size={18} aria-hidden="true" />
            Сохранить
          </button>
        </form>
        <label class="check">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.currentTarget.checked)} />
          Показать всей семье (иначе только мне)
        </label>
        <p class="meta">
          Сохраняются только открытые текстовые страницы; закрытые и домашняя сеть недоступны.
        </p>
      </section>

      <section class="page-section" aria-labelledby={`${ids}-list`}>
        <h2 id={`${ids}-list`} class="section-title">
          Сохранено {d ? `(${d.pages.length})` : ''}
        </h2>
        {data.error && !d ? (
          <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />
        ) : null}
        {!d && !data.error ? <Loading label="Загружаем…" /> : null}
        {d && d.pages.length === 0 ? <p class="section-lead">Пока ничего не сохранено.</p> : null}
        <ul class="archive__list">
          {d?.pages.map((page) => (
            <li key={page.id} class="archive__item">
              <strong>{page.title}</strong>
              <p class="meta">
                {formatDateTime(page.savedAt)} · {Math.round(page.chars / 1000)} тыс. знаков ·{' '}
                {page.shared ? 'для семьи' : 'личная'}
              </p>
              <div class="action-row">
                <button
                  type="button"
                  class="button button--secondary"
                  onClick={() =>
                    void apiGet<{ title: string; text: string }>(`/api/archive/${page.id}`).then(
                      (full) => setOpen(full),
                      () => toast.showError('Не получилось открыть.'),
                    )
                  }
                >
                  Читать
                </button>
                <a class="button button--quiet" href={`/api/archive/${page.id}/original`} download>
                  <Download size={16} aria-hidden="true" />
                  Оригинал
                </a>
                <a class="button button--quiet" href={page.url} target="_blank" rel="noopener noreferrer">
                  Открыть на сайте
                </a>
                <button
                  type="button"
                  class="button button--quiet"
                  disabled={busy}
                  onClick={() => void run(() => apiPost(`/api/archive/${page.id}/delete`, {}), 'Удалено.')}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  Удалить
                </button>
              </div>
            </li>
          ))}
        </ul>
        {open ? (
          <article class="archive__reader">
            <h3>{open.title}</h3>
            <p class="archive__text">{open.text}</p>
            <button type="button" class="button button--quiet" onClick={() => setOpen(null)}>
              Закрыть
            </button>
          </article>
        ) : null}
      </section>
      <ToastRegion toast={toast} />
    </div>
  );
}
