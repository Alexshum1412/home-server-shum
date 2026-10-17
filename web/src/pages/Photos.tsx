import { ChevronLeft, ChevronRight, Download, Film, ImagePlus, Images, X } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { FileEntry, FileListResponse, StorageSpace } from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useBeforeUnload } from '../hooks/useBeforeUnload.ts';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes, formatCount } from '../lib/format.ts';
import { joinPath, readParam, withQuery } from '../lib/query.ts';
import { makeThumbnail, monthFolder, storageQuery, uploadFile, uploadThumbnail } from '../lib/upload.ts';
import { navigate, useLocation } from '../router.ts';

const MONTHS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

/** "2026-10" → "октябрь 2026"; other folder names stay as they are. */
function monthLabel(name: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(name);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${m[1]}` : name;
}

const isVideo = (name: string) => /\.(mp4|m4v|mov|webm)$/i.test(name);
const isDecodableImage = (name: string) => /\.(jpe?g|png|gif|webp|avif)$/i.test(name);

/** Photos imported without a browser (scripts\import) get their previews the first time they are opened. */
const THUMB_MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const THUMB_BATCH = 24;
const SWIPE_MIN_PX = 50;

function photosAddress(space: StorageSpace, month: string | null): string {
  return withQuery('/photos', { space: space === 'shared' ? 'shared' : '', month: month ?? '' });
}

/** The photo itself; the key makes every photo a fresh element, so the previous one never lingers. */
function ViewerMedia(props: { item: FileEntry; src: string; thumb: string | null; downloadUrl: string }) {
  const { item } = props;
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const ready = () => setState('ready');
  const failed = () => setState('failed');
  return (
    <>
      {state === 'loading' && props.thumb ? (
        <img class="viewer__thumb" src={props.thumb} alt="" aria-hidden="true" />
      ) : null}
      {state === 'loading' ? (
        <p class="viewer__status" role="status">
          Загружаем…
        </p>
      ) : null}
      {state === 'failed' ? (
        <p class="viewer__status viewer__status--error" role="alert">
          Браузер не может показать этот файл (например, фото в формате HEIC).{' '}
          <a href={props.downloadUrl} download={item.name}>
            Скачать
          </a>
        </p>
      ) : isVideo(item.name) ? (
        // biome-ignore lint/a11y/useMediaCaption: family home videos have no caption tracks
        <video
          class={state === 'ready' ? 'viewer__media' : 'viewer__media viewer__media--pending'}
          src={props.src}
          controls
          preload="metadata"
          onLoadedMetadata={ready}
          onError={failed}
        />
      ) : (
        <img
          class={state === 'ready' ? 'viewer__media' : 'viewer__media viewer__media--pending'}
          src={props.src}
          alt={item.name}
          onLoad={ready}
          onError={failed}
        />
      )}
    </>
  );
}

function Viewer(props: {
  items: FileEntry[];
  index: number;
  url: (e: FileEntry) => string;
  thumbUrl: (e: FileEntry) => string;
  downloadUrl: (e: FileEntry) => string;
  onClose: () => void;
  onMove: (i: number) => void;
}) {
  const item = props.items[props.index];
  const ref = useRef<HTMLDialogElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const atStart = props.index <= 0;
  const atEnd = props.index >= props.items.length - 1;
  const next = props.items[props.index + 1];

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // A focused video uses the arrows to seek; fields and buttons keep their own keys.
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (['VIDEO', 'AUDIO', 'INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      }
      if (event.key === 'ArrowRight' && !atEnd) props.onMove(props.index + 1);
      if (event.key === 'ArrowLeft' && !atStart) props.onMove(props.index - 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props, atStart, atEnd]);

  // The next photo is fetched ahead of time, so «Вперёд» shows it at once.
  useEffect(() => {
    if (next && !isVideo(next.name) && isDecodableImage(next.name)) {
      const preload = new Image();
      preload.src = props.url(next);
    }
  }, [next, props.url]);

  if (!item) return null;

  const move = (to: number) => {
    if (to >= 0 && to < props.items.length) props.onMove(to);
  };
  const onPointerDown = (event: PointerEvent) => {
    swipe.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 2) return;
    move(dx < 0 ? props.index + 1 : props.index - 1);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only closes the dialog on the dark area; Escape and «Закрыть» do the same from the keyboard
    <dialog
      ref={ref}
      class="viewer"
      aria-label={item.name}
      onClose={props.onClose}
      onClick={(event) => {
        // A tap on the dark area around the photo closes the viewer.
        if (event.target === ref.current) ref.current?.close();
      }}
    >
      <div class="viewer__bar">
        <p class="viewer__title">{item.name}</p>
        <a class="button button--quiet" href={props.downloadUrl(item)} download={item.name}>
          <Download size={20} aria-hidden="true" />
          Скачать<span class="visually-hidden"> «{item.name}»</span>
        </a>
        <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
          <X size={20} aria-hidden="true" />
          Закрыть
        </button>
      </div>
      <div class="viewer__stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <ViewerMedia
          key={item.name}
          item={item}
          src={props.url(item)}
          thumb={item.hasThumb ? props.thumbUrl(item) : null}
          downloadUrl={props.downloadUrl(item)}
        />
      </div>
      <div class="viewer__nav">
        <button
          type="button"
          class="button button--secondary"
          aria-disabled={atStart ? 'true' : undefined}
          onClick={() => move(props.index - 1)}
        >
          <ChevronLeft size={20} aria-hidden="true" />
          Назад
        </button>
        <span class="meta">
          {props.index + 1} из {props.items.length}
        </span>
        <button
          type="button"
          class="button button--secondary"
          aria-disabled={atEnd ? 'true' : undefined}
          onClick={() => move(props.index + 1)}
        >
          Вперёд
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>
    </dialog>
  );
}

interface UploadProgress {
  done: number;
  total: number;
  current: string;
  percent: number;
  failed: string[];
  finished: boolean;
}

export function PhotosPage() {
  const ids = useId();
  const { search } = useLocation();
  const space: StorageSpace = readParam(search, 'space') === 'shared' ? 'shared' : 'personal';
  const rawMonth = readParam(search, 'month').replace(/[\\/]/g, '');
  const month = rawMonth === '' ? null : rawMonth;
  const [viewing, setViewing] = useState<number | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [preparing, setPreparing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const attempted = useRef(new Set<string>());
  const path = month ?? '';
  const uploading = progress !== null && !progress.finished;
  const data = useResource<FileListResponse>(
    `/api/storage/photos/list?${storageQuery({ root: 'photos', space, path })}`,
  );
  useBeforeUnload(uploading);

  useEffect(() => {
    setViewing(null);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
  }, [space, month]);

  const entryPath = (entry: FileEntry) => joinPath(path, entry.name);
  const url = (entry: FileEntry) =>
    `/api/storage/photos/file?${storageQuery({ root: 'photos', space, path: entryPath(entry) })}&inline=1`;
  const downloadUrl = (entry: FileEntry) =>
    `/api/storage/photos/file?${storageQuery({ root: 'photos', space, path: entryPath(entry) })}`;
  const thumbUrl = (entry: FileEntry) =>
    `/api/storage/photos/thumb?${storageQuery({ root: 'photos', space, path: entryPath(entry) })}`;

  async function onFiles(list: FileList | null) {
    if (!list || list.length === 0 || uploading) return;
    const files = Array.from(list);
    const failed: string[] = [];
    setProgress({
      done: 0,
      total: files.length,
      current: files[0]?.name ?? '',
      percent: 0,
      failed,
      finished: false,
    });
    const made = new Set<string>();
    for (const file of files) {
      const folder = monthFolder(file);
      setProgress((p) => (p ? { ...p, current: file.name, percent: 0 } : p));
      try {
        if (!made.has(folder)) {
          await apiPost('/api/storage/photos/mkdir', { space, path: '', name: folder }).catch(
            (err: unknown) => {
              if (toFailure(err).status !== 409) throw err;
            },
          );
          made.add(folder);
        }
        const target = { root: 'photos' as const, space, path: folder };
        const saved = await uploadFile(target, file, (loaded, total) =>
          setProgress((p) => (p ? { ...p, percent: Math.round((loaded / total) * 100) } : p)),
        );
        const thumb = await makeThumbnail(file);
        if (thumb) await uploadThumbnail(target, saved.name, thumb).catch(() => undefined);
      } catch (err) {
        const failure = toFailure(err);
        failed.push(`${file.name}: ${failure.unreachable ? NO_CONNECTION : failure.message}`);
      }
      setProgress((p) => (p ? { ...p, done: p.done + 1, failed: [...failed] } : p));
    }
    setProgress((p) => (p ? { ...p, finished: true } : p));
    if (input.current) input.current.value = '';
    data.reload();
  }

  // Previews for photos that arrived without one (copied on the server): made once by this browser.
  useEffect(() => {
    if (!data.data || month === null) return;
    const missing = data.data.entries
      .filter(
        (e) =>
          e.type === 'file' &&
          !e.hasThumb &&
          isDecodableImage(e.name) &&
          (e.sizeBytes ?? 0) <= THUMB_MAX_SOURCE_BYTES &&
          !attempted.current.has(`${space}/${month}/${e.name}`),
      )
      .slice(0, THUMB_BATCH);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      setPreparing(true);
      let made = 0;
      for (const entry of missing) {
        if (cancelled) break;
        attempted.current.add(`${space}/${month}/${entry.name}`);
        try {
          const response = await fetch(url(entry), { credentials: 'same-origin' });
          if (!response.ok) continue;
          const blob = await response.blob();
          const thumb = await makeThumbnail(new File([blob], entry.name, { type: blob.type }));
          if (thumb) {
            await uploadThumbnail({ root: 'photos', space, path: month }, entry.name, thumb);
            made += 1;
          }
        } catch {
          // no preview for this one; the gallery shows an icon
        }
      }
      if (!cancelled) {
        setPreparing(false);
        if (made > 0) data.reload();
      }
    })();
    return () => {
      cancelled = true;
      setPreparing(false);
    };
  }, [data.data, month, space]);

  const entries = data.data?.entries ?? [];
  const folders = entries.filter((e) => e.type === 'dir').sort((a, b) => b.name.localeCompare(a.name));
  const media = entries.filter((e) => e.type === 'file');

  let content = null;
  if (data.error && !data.data) {
    content = <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />;
  } else if (data.data) {
    if (month === null) {
      content =
        folders.length === 0 ? (
          <p class="section-lead">Фотографий пока нет. Нажмите «Добавить фото и видео».</p>
        ) : (
          <ul class="months">
            {folders.map((folder) => (
              <li key={folder.name}>
                <button
                  type="button"
                  class="months__item"
                  onClick={() => navigate(photosAddress(space, folder.name))}
                >
                  <Images size={22} aria-hidden="true" />
                  <span>{monthLabel(folder.name)}</span>
                </button>
              </li>
            ))}
          </ul>
        );
    } else {
      content =
        media.length === 0 ? (
          <p class="section-lead">В этом месяце пусто.</p>
        ) : (
          <ul class="gallery">
            {media.map((entry, index) => (
              <li key={entry.name}>
                <button type="button" class="gallery__item" onClick={() => setViewing(index)}>
                  {entry.hasThumb ? (
                    <img src={thumbUrl(entry)} alt={entry.name} loading="lazy" width={180} height={180} />
                  ) : (
                    <span class="gallery__placeholder">
                      {isVideo(entry.name) ? (
                        <Film size={32} aria-hidden="true" />
                      ) : (
                        <Images size={32} aria-hidden="true" />
                      )}
                      <span class="gallery__name">{entry.name}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        );
    }
  } else {
    content = <Loading label="Загружаем фотографии…" />;
  }

  const spaceTitle = space === 'personal' ? 'Мои фото' : 'Общие фото';
  return (
    <div class="page">
      <PageHeader
        title="Фото"
        icon={Images}
        lead="Фото и видео семьи на домашнем сервере. Добавляются вручную с телефона или компьютера — это не фоновое автокопирование."
      />
      <fieldset class="segmented">
        <legend class="visually-hidden">Чьи фото</legend>
        {(['personal', 'shared'] as const).map((s) => (
          <button
            key={s}
            type="button"
            class="segmented__item"
            aria-pressed={space === s}
            onClick={() => navigate(photosAddress(s, null), { replace: true })}
          >
            {s === 'personal' ? 'Мои' : 'Общие'}
          </button>
        ))}
      </fieldset>
      <div class="action-row">
        <label
          class="button button--primary upload-label"
          htmlFor={`${ids}-add`}
          aria-disabled={uploading ? 'true' : undefined}
        >
          <ImagePlus size={20} aria-hidden="true" />
          Добавить фото и видео
        </label>
        <input
          ref={input}
          id={`${ids}-add`}
          class="visually-hidden"
          type="file"
          accept="image/*,video/*"
          multiple
          disabled={uploading}
          onChange={(event) => void onFiles(event.currentTarget.files)}
        />
        {month !== null ? (
          <button
            type="button"
            class="button button--secondary"
            onClick={() => navigate(photosAddress(space, null))}
          >
            <ChevronLeft size={20} aria-hidden="true" />
            Все месяцы
          </button>
        ) : null}
      </div>
      {progress ? (
        <div class={progress.failed.length > 0 ? 'banner banner--warn' : 'banner banner--info'} role="status">
          <p>
            {progress.finished ? 'Готово: ' : 'Загружаем: '}
            {progress.done} из {formatCount(progress.total, 'файла', 'файлов', 'файлов')}.
            {uploading ? ' Не закрывайте страницу, пока идёт загрузка.' : ''}
          </p>
          {uploading ? (
            <p class="photos-progress">
              <span class="uploads__name">{progress.current}</span>
              <progress
                max={100}
                value={progress.percent}
                aria-label={`${progress.current}: ${progress.percent} %`}
              />
              <span class="meta">{progress.percent} %</span>
            </p>
          ) : null}
          {progress.failed.length > 0 ? <p>Не получилось: {progress.failed.join('; ')}</p> : null}
        </div>
      ) : null}
      {preparing ? <p class="meta">Готовим миниатюры для фото, добавленных на сервере…</p> : null}
      <section
        class="page-section"
        aria-label={month ? monthLabel(month) : 'Месяцы'}
        aria-busy={data.loading && !data.data}
      >
        <h2 ref={heading} class="section-title" tabIndex={-1}>
          {month ? monthLabel(month) : spaceTitle}
        </h2>
        {content}
        {data.data && data.data.freeBytes != null && month === null ? (
          <p class="meta">Свободно на сервере: {formatBytes(data.data.freeBytes)}.</p>
        ) : null}
      </section>
      {viewing !== null && media[viewing] ? (
        <Viewer
          items={media}
          index={viewing}
          url={url}
          thumbUrl={thumbUrl}
          downloadUrl={downloadUrl}
          onClose={() => setViewing(null)}
          onMove={setViewing}
        />
      ) : null}
    </div>
  );
}
