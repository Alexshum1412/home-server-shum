import {
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  FolderPlus,
  ImagePlus,
  Images,
  Pencil,
  Trash2,
  X,
} from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { FileEntry, FileListResponse, StorageSpace } from '../../../shared/api.ts';
import { ALBUMS_FOLDER, type AlbumsResponse } from '../../../shared/storage-extras.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { QuotaNote } from '../components/QuotaNote.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { TrashDialog } from '../components/TrashDialog.tsx';
import { UploadPanel } from '../components/UploadPanel.tsx';
import { useBeforeUnload } from '../hooks/useBeforeUnload.ts';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes, formatCount } from '../lib/format.ts';
import { joinPath, readParam, withQuery } from '../lib/query.ts';
import { makeThumbnail, monthFolder, storageQuery, uploadThumbnail } from '../lib/upload.ts';
import { browserUploadApi } from '../lib/upload-api.ts';
import { useUploader } from '../lib/useUploader.ts';
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

function photosAddress(space: StorageSpace, month: string | null, album: string | null): string {
  return withQuery('/photos', {
    space: space === 'shared' ? 'shared' : '',
    month: month ?? '',
    album: album ?? '',
  });
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
  onTrash: (e: FileEntry) => void;
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
        <button type="button" class="button button--quiet" onClick={() => props.onTrash(item)}>
          <Trash2 size={20} aria-hidden="true" />В корзину<span class="visually-hidden"> «{item.name}»</span>
        </button>
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

/** A choice that is remembered in this browser (a convenience; a private window simply forgets it). */
function useStoredFlag(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : saved === '1';
    } catch {
      return initial;
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, next ? '1' : '0');
    } catch {
      // not remembered
    }
  };
  return [value, set];
}

const NEW_ALBUM = '\u0000new';
const ALBUM_NAME_BAD = /[\\/:*?"<>|]/;

export function PhotosPage() {
  const ids = useId();
  const { search } = useLocation();
  const space: StorageSpace = readParam(search, 'space') === 'shared' ? 'shared' : 'personal';
  const rawMonth = readParam(search, 'month').replace(/[\\/]/g, '');
  const month = rawMonth === '' ? null : rawMonth;
  const rawAlbum = readParam(search, 'album').replace(/[\\/]/g, '');
  const album = rawAlbum === '' ? null : rawAlbum;
  const inFolder = month !== null || album !== null;
  const path = album !== null ? `${ALBUMS_FOLDER}/${album}` : (month ?? '');
  const toast = useToast();
  const [viewing, setViewing] = useState<number | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [strip, setStrip] = useStoredFlag('photos.strip', true);
  const [check, setCheck] = useStoredFlag('photos.check', true);
  const [dest, setDest] = useState<string>(album ?? '');
  const [newAlbum, setNewAlbum] = useState('');
  const [trashOpen, setTrashOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingName, setCreatingName] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const attempted = useRef(new Set<string>());
  const data = useResource<FileListResponse>(
    `/api/storage/photos/list?${storageQuery({ root: 'photos', space, path })}`,
  );
  const albums = useResource<AlbumsResponse>(`/api/storage/photos/albums?space=${space}`);
  const { uploader, snapshot } = useUploader({
    root: 'photos',
    space,
    strip,
    checkDuplicates: check,
    afterSaved: async (item, saved) => {
      const thumb = await makeThumbnail(item.file);
      if (thumb) await uploadThumbnail({ root: 'photos', space, path: item.folder }, saved.name, thumb);
    },
  });
  const uploading = snapshot.running;
  useBeforeUnload(uploading);

  useEffect(() => {
    setViewing(null);
    setDest(album ?? '');
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
  }, [space, month, album]);

  // When a batch ends the lists are read again: the new photos and the numbers of the albums.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !snapshot.running) {
      data.reload();
      albums.reload();
    }
    wasRunning.current = snapshot.running;
  }, [snapshot.running]);

  const entryPath = (entry: FileEntry) => joinPath(path, entry.name);
  const url = (entry: FileEntry) =>
    `/api/storage/photos/file?${storageQuery({ root: 'photos', space, path: entryPath(entry) })}&inline=1`;
  const downloadUrl = (entry: FileEntry) =>
    `/api/storage/photos/file?${storageQuery({ root: 'photos', space, path: entryPath(entry) })}`;
  const thumbUrl = (entry: FileEntry) =>
    `/api/storage/photos/thumb?${storageQuery({ root: 'photos', space, path: entryPath(entry) })}`;

  function failure(error: unknown) {
    const f = toFailure(error);
    toast.showError(f.unreachable ? NO_CONNECTION : f.message);
  }

  function onFiles(list: FileList | null) {
    if (!list || list.length === 0 || uploading) return;
    const files = Array.from(list);
    let folderOf: (file: File) => string = (file) => monthFolder(file);
    if (dest === NEW_ALBUM) {
      const name = newAlbum.trim();
      if (name === '' || Array.from(name).length > 60 || ALBUM_NAME_BAD.test(name) || name.startsWith('.')) {
        toast.showError('Назовите новый альбом: до 60 символов, без \\ / : * ? " < > |.');
        if (input.current) input.current.value = '';
        return;
      }
      folderOf = () => `${ALBUMS_FOLDER}/${name}`;
    } else if (dest !== '') {
      folderOf = () => `${ALBUMS_FOLDER}/${dest}`;
    }
    toast.clear();
    uploader.clearFinished();
    uploader.add(files, folderOf);
    void uploader.start();
    if (input.current) input.current.value = '';
  }

  async function createAlbum(event: Event) {
    event.preventDefault();
    const name = creatingName.trim();
    if (name === '' || Array.from(name).length > 60 || ALBUM_NAME_BAD.test(name) || name.startsWith('.')) {
      toast.showError('Назовите альбом: до 60 символов, без \\ / : * ? " < > |.');
      return;
    }
    try {
      await browserUploadApi().mkdir('photos', space, `${ALBUMS_FOLDER}/${name}`);
      setCreating(false);
      setCreatingName('');
      navigate(photosAddress(space, null, name));
    } catch (error) {
      failure(error);
    }
  }

  async function renameAlbum() {
    if (album === null) return;
    const name = window.prompt('Новое название альбома', album)?.trim();
    if (!name || name === album) return;
    try {
      await apiPost('/api/storage/photos/rename', { space, path: `${ALBUMS_FOLDER}/${album}`, name });
      navigate(photosAddress(space, null, name), { replace: true });
    } catch (error) {
      failure(error);
    }
  }

  async function trashPhoto(entry: FileEntry) {
    if (!window.confirm(`Переместить «${entry.name}» в корзину? Вернуть можно из корзины.`)) return;
    try {
      await apiPost('/api/storage/photos/trash', { space, path: entryPath(entry) });
      setViewing(null);
      toast.showOk(`«${entry.name}» перемещён в корзину.`);
      data.reload();
      albums.reload();
    } catch (error) {
      failure(error);
    }
  }

  // Previews for photos that arrived without one (copied on the server): made once by this browser.
  useEffect(() => {
    if (!data.data || !inFolder) return;
    const missing = data.data.entries
      .filter(
        (e) =>
          e.type === 'file' &&
          !e.hasThumb &&
          isDecodableImage(e.name) &&
          (e.sizeBytes ?? 0) <= THUMB_MAX_SOURCE_BYTES &&
          !attempted.current.has(`${space}/${path}/${e.name}`),
      )
      .slice(0, THUMB_BATCH);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      setPreparing(true);
      let made = 0;
      for (const entry of missing) {
        if (cancelled) break;
        attempted.current.add(`${space}/${path}/${entry.name}`);
        try {
          const response = await fetch(url(entry), { credentials: 'same-origin' });
          if (!response.ok) continue;
          const blob = await response.blob();
          const thumb = await makeThumbnail(new File([blob], entry.name, { type: blob.type }));
          if (thumb) {
            await uploadThumbnail({ root: 'photos', space, path }, entry.name, thumb);
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
  }, [data.data, path, space]);

  const entries = data.data?.entries ?? [];
  const folders = entries
    .filter((e) => e.type === 'dir' && e.name !== ALBUMS_FOLDER)
    .sort((a, b) => b.name.localeCompare(a.name));
  const media = entries.filter((e) => e.type === 'file');
  const albumList = albums.data?.albums ?? [];

  let content = null;
  if (data.error && !data.data) {
    content = <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />;
  } else if (data.data) {
    if (!inFolder) {
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
                  onClick={() => navigate(photosAddress(space, folder.name, null))}
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
          <p class="section-lead">{album !== null ? 'В этом альбоме пока пусто.' : 'В этом месяце пусто.'}</p>
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
  const title = album ?? (month ? monthLabel(month) : spaceTitle);
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
            disabled={uploading}
            onClick={() => navigate(photosAddress(s, null, null), { replace: true })}
          >
            {s === 'personal' ? 'Мои' : 'Общие'}
          </button>
        ))}
      </fieldset>
      <QuotaNote quota={data.data?.quota} />
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
          onChange={(event) => onFiles(event.currentTarget.files)}
        />
        {inFolder ? (
          <button
            type="button"
            class="button button--secondary"
            onClick={() => navigate(photosAddress(space, null, null))}
          >
            <ChevronLeft size={20} aria-hidden="true" />
            {album !== null ? 'Все фото' : 'Все месяцы'}
          </button>
        ) : null}
        <button type="button" class="button button--quiet" onClick={() => setTrashOpen(true)}>
          <Trash2 size={20} aria-hidden="true" />
          Корзина
        </button>
      </div>
      <div class="upload-options">
        <div class="upload-options__row">
          <label class="field__label" htmlFor={`${ids}-dest`}>
            Куда добавить
          </label>
          <select
            id={`${ids}-dest`}
            class="field__input"
            value={dest}
            disabled={uploading}
            onChange={(event) => setDest(event.currentTarget.value)}
          >
            <option value="">По месяцам (по дате съёмки)</option>
            {albumList.map((a) => (
              <option key={a.name} value={a.name}>
                Альбом «{a.name}»
              </option>
            ))}
            <option value={NEW_ALBUM}>Новый альбом…</option>
          </select>
          {dest === NEW_ALBUM ? (
            <>
              <label class="visually-hidden" htmlFor={`${ids}-new`}>
                Название нового альбома
              </label>
              <input
                id={`${ids}-new`}
                class="field__input"
                placeholder="Название альбома"
                maxLength={60}
                value={newAlbum}
                disabled={uploading}
                onInput={(event) => setNewAlbum(event.currentTarget.value)}
              />
            </>
          ) : null}
        </div>
        <label class="check">
          <input
            type="checkbox"
            checked={strip}
            disabled={uploading}
            onChange={(event) => setStrip(event.currentTarget.checked)}
          />
          Убирать место съёмки и сведения о камере (только в JPEG)
        </label>
        <p class="meta">
          Фотографии других форматов (HEIC, PNG, видео) сохраняются как есть, вместе со всем, что в них
          записано.
        </p>
        <label class="check">
          <input
            type="checkbox"
            checked={check}
            disabled={uploading}
            onChange={(event) => setCheck(event.currentTarget.checked)}
          />
          Пропускать то, что уже есть на сервере (одинаковые файлы)
        </label>
      </div>
      <UploadPanel
        snapshot={snapshot}
        onStop={() => uploader.stop()}
        onRetry={() => void uploader.retry()}
        onUploadSkipped={() => void uploader.uploadSkipped()}
        onClear={() => uploader.clearFinished()}
      />
      {preparing ? <p class="meta">Готовим миниатюры для фото, добавленных на сервере…</p> : null}
      <section class="page-section" aria-label={title} aria-busy={data.loading && !data.data}>
        <h2 ref={heading} class="section-title" tabIndex={-1}>
          {title}
        </h2>
        {album !== null ? (
          <div class="action-row">
            <button type="button" class="button button--quiet" onClick={() => void renameAlbum()}>
              <Pencil size={18} aria-hidden="true" />
              Переименовать альбом
            </button>
          </div>
        ) : null}
        {content}
        {data.data && data.data.freeBytes != null && !inFolder ? (
          <p class="meta">Свободно на сервере: {formatBytes(data.data.freeBytes)}.</p>
        ) : null}
      </section>
      {!inFolder && data.data ? (
        <section class="page-section" aria-labelledby={`${ids}-albums`}>
          <h2 id={`${ids}-albums`} class="section-title">
            Альбомы
          </h2>
          {albumList.length === 0 ? (
            <p class="section-lead">
              Альбомов пока нет. Альбом собирает фотографии по поводу или человеку, независимо от даты:
              поездка, день рождения, дача.
            </p>
          ) : (
            <ul class="albums">
              {albumList.map((a) => (
                <li key={a.name}>
                  <button
                    type="button"
                    class="albums__item"
                    onClick={() => navigate(photosAddress(space, null, a.name))}
                  >
                    <span class="albums__cover">
                      {a.cover ? (
                        <img
                          src={`/api/storage/photos/thumb?${storageQuery({ root: 'photos', space, path: `${ALBUMS_FOLDER}/${a.name}/${a.cover}` })}`}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <Images size={32} aria-hidden="true" />
                      )}
                    </span>
                    <span class="albums__text">
                      <span class="albums__name">{a.name}</span>
                      <span class="meta">
                        {a.count === 0
                          ? 'пусто'
                          : formatCount(a.count, 'фото или видео', 'фото или видео', 'фото и видео')}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {creating ? (
            <form class="upload-options__row" onSubmit={createAlbum}>
              <label class="visually-hidden" htmlFor={`${ids}-album-name`}>
                Название альбома
              </label>
              <input
                id={`${ids}-album-name`}
                class="field__input"
                placeholder="Название альбома"
                maxLength={60}
                value={creatingName}
                onInput={(event) => setCreatingName(event.currentTarget.value)}
              />
              <button type="submit" class="button button--primary">
                Создать
              </button>
              <button type="button" class="button button--quiet" onClick={() => setCreating(false)}>
                Отмена
              </button>
            </form>
          ) : (
            <div class="action-row">
              <button type="button" class="button button--secondary" onClick={() => setCreating(true)}>
                <FolderPlus size={20} aria-hidden="true" />
                Новый альбом
              </button>
            </div>
          )}
        </section>
      ) : null}
      {viewing !== null && media[viewing] ? (
        <Viewer
          items={media}
          index={viewing}
          url={url}
          thumbUrl={thumbUrl}
          downloadUrl={downloadUrl}
          onClose={() => setViewing(null)}
          onMove={setViewing}
          onTrash={(entry) => void trashPhoto(entry)}
        />
      ) : null}
      {trashOpen ? (
        <TrashDialog
          root="photos"
          space={space}
          onClose={() => setTrashOpen(false)}
          onRestored={(message) => {
            toast.showOk(message);
            data.reload();
            albums.reload();
          }}
        />
      ) : null}
      <ToastRegion toast={toast} />
    </div>
  );
}
