import { Tv } from 'lucide-preact';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useResource } from '../hooks/useResource.ts';

interface PlexState {
  running: boolean;
  claimed: boolean | null;
  version: string | null;
  libraries: Array<{ title: string; type: string; count: number | null }>;
  note: string | null;
  lanUrl: string | null;
}

const TYPE: Record<string, string> = { movie: 'фильмы', show: 'сериалы', artist: 'музыка', photo: 'фото' };

/** «Plex»: the second way to watch the same films (the apps of Plex are on almost every television, Samsung included). */
export function PlexPage() {
  const data = useResource<PlexState>('/api/plex');
  const d = data.data;
  return (
    <div class="page page--narrow">
      <PageHeader
        title="Plex — кино на телевизоре"
        icon={Tv}
        lead="Те же фильмы и сериалы, но через Plex. Его приложение есть почти на каждом телевизоре (Samsung, LG, Sony, приставки), поэтому он работает там, где Jellyfin не запускается. Plex и Jellyfin равноправны: смотрите тем, который удобнее."
      />
      {data.error && !d ? (
        <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />
      ) : null}
      {!d && !data.error ? <Loading label="Проверяем Plex…" /> : null}
      {d ? (
        <>
          <section class="page-section">
            <h2 class="section-title">Состояние</h2>
            <p class={d.running ? 'banner banner--info' : 'banner banner--warn'} role="status">
              {d.running
                ? `Plex работает${d.version ? ` (версия ${d.version})` : ''}${d.claimed === false ? ', но не привязан к аккаунту: войдите в него на самом сервере' : ''}.`
                : (d.note ?? 'Plex не работает.')}
            </p>
            {d.lanUrl ? (
              <p>
                <a class="button button--primary" href={d.lanUrl} target="_blank" rel="noopener noreferrer">
                  Открыть Plex в браузере
                </a>{' '}
                <span class="meta">(в домашней сети: {d.lanUrl})</span>
              </p>
            ) : null}
          </section>

          <section class="page-section">
            <h2 class="section-title">Библиотеки Plex</h2>
            {d.libraries.length > 0 ? (
              <ul>
                {d.libraries.map((library) => (
                  <li key={library.title}>
                    <strong>{library.title}</strong>{' '}
                    <span class="meta">
                      — {TYPE[library.type] ?? library.type}
                      {library.count !== null ? `, ${library.count}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="section-lead">{d.note ?? 'Библиотек пока нет.'}</p>
            )}
          </section>

          <section class="page-section">
            <h2 class="section-title">Как включить на телевизоре</h2>
            <ol>
              <li>
                На телевизоре откройте магазин приложений (на Samsung — Smart Hub → «Приложения») и найдите
                «Plex».
              </li>
              <li>Установите, откройте и войдите в тот же аккаунт Plex, к которому привязан наш сервер.</li>
              <li>
                Выберите сервер (его имя показано в приложении) и нужную библиотеку — фильмы появятся сами.
              </li>
              <li>
                Если телевизор не видит сервер: он и сервер должны быть в одной домашней сети; в Plex на
                сервере включён «Удалённый доступ» или проверьте правила брандмауэра (они уже созданы при
                установке).
              </li>
            </ol>
            <p class="meta">
              Запасной путь без приложения: на телевизоре откройте браузер и адрес Plex выше. Ещё один — DLNA:
              Plex показывается в списке медиасерверов телевизора («Источники» → «Медиасерверы»).
            </p>
          </section>

          <section class="page-section">
            <h2 class="section-title">Plex или Jellyfin?</h2>
            <ul>
              <li>
                <strong>Plex</strong> — приложение почти на любом телевизоре и приставке, красивые карточки,
                удобно, когда Jellyfin не запускается. Нужен бесплатный аккаунт Plex.
              </li>
              <li>
                <strong>Jellyfin</strong> — полностью свой, без аккаунта в интернете, есть наши подборки и
                «продолжить просмотр» в портале.
              </li>
              <li>
                Файлы одни и те же: папки «Фильмы», «Сериалы», «Мультфильмы» на диске D. Что добавили в них —
                появится в обоих.
              </li>
              <li>
                Субтитры: в Jellyfin — плагин Open Subtitles (нужна запись opensubtitles.com); в Plex — в
                настройках библиотеки «Субтитры».
              </li>
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
