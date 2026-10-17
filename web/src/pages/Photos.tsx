import { ChevronLeft, ChevronRight, Film, ImagePlus, Images, X } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { FileEntry, FileListResponse, StorageSpace } from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatCount } from '../lib/format.ts';
import { makeThumbnail, monthFolder, storageQuery, uploadFile, uploadThumbnail } from '../lib/upload.ts';

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

function Viewer(props: {
  items: FileEntry[];
  index: number;
  url: (e: FileEntry) => string;
  onClose: () => void;
  onMove: (i: number) => void;
}) {
  const item = props.items[props.index];
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight' && props.index < props.items.length - 1) props.onMove(props.index + 1);
      if (event.key === 'ArrowLeft' && props.index > 0) props.onMove(props.index - 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);
  if (!item) return null;
  return (
    <dialog ref={ref} class="viewer" aria-label={item.name} onClose={props.onClose}>
      <div class="viewer__bar">
        <p class="viewer__title">{item.name}</p>
        <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
          <X size={20} aria-hidden="true" />
          Закрыть
        </button>
      </div>
      <div class="viewer__stage">
        {isVideo(item.name) ? (
          // biome-ignore lint/a11y/useMediaCaption: family home videos have no caption tracks
          <video class="viewer__media" src={props.url(item)} controls preload="metadata" />
        ) : (
          <img class="viewer__media" src={props.url(item)} alt={item.name} />
        )}
      </div>
      <div class="viewer__nav">
        <button
          type="button"
          class="button button--secondary"
          disabled={props.index === 0}
          onClick={() => props.onMove(props.index - 1)}
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
          disabled={props.index >= props.items.length - 1}
          onClick={() => props.onMove(props.index + 1)}
        >
          Вперёд
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>
    </dialog>
  );
}

export function PhotosPage() {
  const ids = useId();
  const [space, setSpace] = useState<StorageSpace>('personal');
  const [month, setMonth] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: string[] } | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const path = month ?? '';
  const data = useResource<FileListResponse>(
    `/api/storage/photos/list?${storageQuery({ root: 'photos', space, path })}`,
  );

  const url = (entry: FileEntry) =>
    `/api/storage/photos/file?${storageQuery({ root: 'photos', space, path: `${path}/${entry.name}`.replace(/^\//, '') })}&inline=1`;
  const thumbUrl = (entry: FileEntry) =>
    `/api/storage/photos/thumb?${storageQuery({ root: 'photos', space, path: `${path}/${entry.name}`.replace(/^\//, '') })}`;

  async function onFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    const failed: string[] = [];
    setError('');
    setProgress({ done: 0, total: files.length, failed });
    const made = new Set<string>();
    for (const file of files) {
      const folder = monthFolder(file);
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
        const saved = await uploadFile(target, file);
        const thumb = await makeThumbnail(file);
        if (thumb) await uploadThumbnail(target, saved.name, thumb).catch(() => undefined);
      } catch (err) {
        const failure = toFailure(err);
        failed.push(`${file.name}: ${failure.unreachable ? NO_CONNECTION : failure.message}`);
      }
      setProgress((p) => (p ? { ...p, done: p.done + 1, failed: [...failed] } : p));
    }
    if (input.current) input.current.value = '';
    data.reload();
  }

  const entries = data.data?.entries ?? [];
  const folders = entries.filter((e) => e.type === 'dir').sort((a, b) => b.name.localeCompare(a.name));
  const media = entries.filter((e) => e.type === 'file');

  let content = null;
  if (data.data) {
    if (month === null) {
      content =
        folders.length === 0 ? (
          <p class="section-lead">Фотографий пока нет. Нажмите «Добавить фото и видео».</p>
        ) : (
          <ul class="months">
            {folders.map((folder) => (
              <li key={folder.name}>
                <button type="button" class="months__item" onClick={() => setMonth(folder.name)}>
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
  } else if (data.error) {
    content = <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />;
  } else {
    content = <Loading label="Загружаем фотографии…" />;
  }

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
            onClick={() => {
              setSpace(s);
              setMonth(null);
            }}
          >
            {s === 'personal' ? 'Мои' : 'Общие'}
          </button>
        ))}
      </fieldset>
      <div class="action-row">
        <label class="button button--primary" htmlFor={`${ids}-add`}>
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
          onChange={(event) => void onFiles(event.currentTarget.files)}
        />
        {month !== null ? (
          <button type="button" class="button button--secondary" onClick={() => setMonth(null)}>
            <ChevronLeft size={20} aria-hidden="true" />
            Все месяцы
          </button>
        ) : null}
      </div>
      {progress ? (
        <p class={progress.failed.length > 0 ? 'banner banner--warn' : 'banner banner--ok'} role="status">
          Загружено {progress.done} из {formatCount(progress.total, 'файла', 'файлов', 'файлов')}.
          {progress.failed.length > 0 ? ` Не получилось: ${progress.failed.join('; ')}` : ''}
        </p>
      ) : null}
      <p class="form-error" role="alert">
        {error}
      </p>
      <section class="page-section" aria-label={month ? monthLabel(month) : 'Месяцы'}>
        {month ? <h2 class="section-title">{monthLabel(month)}</h2> : null}
        {content}
      </section>
      {viewing !== null ? (
        <Viewer
          items={media}
          index={viewing}
          url={url}
          onClose={() => setViewing(null)}
          onMove={setViewing}
        />
      ) : null}
    </div>
  );
}
