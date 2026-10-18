import { ChevronRight, Film, Folder, LifeBuoy, Music, X } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { MediaEntry, MediaListResponse } from '../../../shared/api.ts';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes } from '../lib/format.ts';
import { joinPath, readParam, withQuery } from '../lib/query.ts';
import { clearPosition, loadPosition, resumeAt, savePosition } from '../lib/resume.ts';
import { navigate, useLocation } from '../router.ts';
import { ErrorState } from './ErrorState.tsx';
import { Loading } from './Skeleton.tsx';

const SAVE_EVERY_MS = 5000;

const mediaUrl = (path: string) => `/api/media/file?${new URLSearchParams({ path }).toString()}`;
const address = (path: string) => withQuery('/cinema', { media: path });

/** One film or one audiobook chapter, played by the browser; the position is remembered per device. */
function Player(props: { entry: MediaEntry; path: string; onClose: () => void }) {
  const { entry } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const lastSave = useRef(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  function restore() {
    const element = media.current;
    if (!element) return;
    const at = resumeAt(loadPosition(props.path), element.duration);
    if (at > 0) element.currentTime = at;
  }
  function remember() {
    const element = media.current;
    if (!element || Date.now() - lastSave.current < SAVE_EVERY_MS) return;
    lastSave.current = Date.now();
    savePosition(props.path, element.currentTime);
  }
  function finish() {
    const element = media.current;
    if (element && !element.ended) savePosition(props.path, element.currentTime);
    props.onClose();
  }

  const common = {
    ref: media,
    src: mediaUrl(props.path),
    controls: true,
    autoPlay: true,
    preload: 'metadata' as const,
    onLoadedMetadata: restore,
    onTimeUpdate: remember,
    onPause: remember,
    onEnded: () => clearPosition(props.path),
    onError: () => setFailed(true),
  };

  return (
    <dialog ref={ref} class="viewer" aria-label={entry.name} onClose={finish}>
      <div class="viewer__bar">
        <p class="viewer__title">{entry.name}</p>
        <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
          <X size={20} aria-hidden="true" />
          Закрыть
        </button>
      </div>
      <div class="viewer__stage">
        {failed ? (
          <p class="viewer__status viewer__status--error" role="alert">
            Браузер не смог воспроизвести этот файл (формат или кодек не поддерживается). Попробуйте Jellyfin:
            он умеет перекодировать видео.
          </p>
        ) : entry.kind === 'audio' ? (
          <audio {...common} />
        ) : (
          <video {...common} class="viewer__media" />
        )}
      </div>
    </dialog>
  );
}

/**
 * «Запасной просмотр»: the library's files played straight from the portal. It works when Jellyfin
 * is stopped or broken. It does not convert anything, so a codec the browser cannot play fails —
 * then Jellyfin is needed.
 */
export function MediaFallback(props: { jellyfinOnline: boolean; forceOpen?: boolean }) {
  const { search } = useLocation();
  const folder = readParam(search, 'media')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const data = useResource<MediaListResponse>(
    `/api/media/list?${new URLSearchParams({ path: folder }).toString()}`,
  );
  const [playing, setPlaying] = useState<MediaEntry | null>(null);
  const crumbs = folder === '' ? [] : folder.split('/');

  let content = null;
  if (data.error && !data.data) {
    content = <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />;
  } else if (data.data && !data.data.available) {
    content = (
      <p class="banner banner--warn">{data.data.reason ?? 'Папка с фильмами и музыкой не найдена.'}</p>
    );
  } else if (data.data) {
    content =
      data.data.entries.length === 0 ? (
        <p class="section-lead">В этой папке нет файлов, которые браузер умеет воспроизводить.</p>
      ) : (
        <ul class="files">
          {data.data.entries.map((entry) => (
            <li key={entry.name} class="files__item">
              {entry.type === 'dir' ? (
                <button
                  type="button"
                  class="files__name files__name--dir"
                  onClick={() => navigate(address(joinPath(folder, entry.name)))}
                >
                  <Folder size={20} aria-hidden="true" />
                  <span>{entry.name}</span>
                </button>
              ) : (
                <button type="button" class="files__name" onClick={() => setPlaying(entry)}>
                  {entry.kind === 'audio' ? (
                    <Music size={20} aria-hidden="true" />
                  ) : (
                    <Film size={20} aria-hidden="true" />
                  )}
                  <span>{entry.name}</span>
                  <span class="visually-hidden">{entry.kind === 'audio' ? ' — слушать' : ' — смотреть'}</span>
                </button>
              )}
              {entry.sizeBytes !== null ? (
                <p class="meta files__meta">{formatBytes(entry.sizeBytes)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      );
  } else {
    content = <Loading label="Загружаем список фильмов и музыки…" />;
  }

  return (
    <details class="disclosure fallback" open={props.forceOpen === true || !props.jellyfinOnline}>
      <summary class="disclosure__summary">
        <LifeBuoy size={18} aria-hidden="true" />
        Запасной просмотр без Jellyfin
      </summary>
      <div class="fallback__body">
        <p class="section-lead">
          {props.jellyfinOnline
            ? 'Это запасной путь: если кинотеатр перестанет открываться, фильмы, музыку и аудиокниги можно включить прямо здесь.'
            : 'Кинотеатр сейчас недоступен, но файлы можно включить прямо отсюда.'}{' '}
          Видео и звук воспроизводит сам браузер. Без перекодирования, субтитров и обложек: если формат не
          поддерживается, нужен Jellyfin. Для аудиокниг место остановки запоминается на этом устройстве.
        </p>
        {crumbs.length > 0 ? (
          <nav class="crumbs" aria-label="Путь к папке">
            <button type="button" class="crumbs__item" onClick={() => navigate(address(''))}>
              Медиатека
            </button>
            {crumbs.map((part, index) => (
              <span key={`${index}-${part}`} class="crumbs__part">
                <ChevronRight size={16} aria-hidden="true" />
                <button
                  type="button"
                  class="crumbs__item"
                  aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                  onClick={() => navigate(address(crumbs.slice(0, index + 1).join('/')))}
                >
                  {part}
                </button>
              </span>
            ))}
          </nav>
        ) : null}
        {content}
      </div>
      {playing ? (
        <Player
          key={playing.name}
          entry={playing}
          path={joinPath(folder, playing.name)}
          onClose={() => setPlaying(null)}
        />
      ) : null}
    </details>
  );
}
