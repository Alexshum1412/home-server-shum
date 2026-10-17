import {
  ChevronRight,
  Download,
  Eye,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { FileEntry, FileListResponse, StorageSpace } from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { useBeforeUnload } from '../hooks/useBeforeUnload.ts';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes, formatDateTime } from '../lib/format.ts';
import { joinPath, readParam, withQuery } from '../lib/query.ts';
import { storageQuery, uploadFile } from '../lib/upload.ts';
import { navigate, useLocation } from '../router.ts';

const SPACES: ReadonlyArray<{ id: StorageSpace; label: string; lead: string }> = [
  { id: 'personal', label: 'Личное', lead: 'Видите только вы. Здесь же папка «Загрузки».' },
  { id: 'shared', label: 'Общее', lead: 'Видит вся семья: документы, сканы, учебные материалы.' },
];

/** Types the server may show in the browser (it decides; this only picks the button). */
const VIEWABLE = /\.(jpe?g|png|gif|webp|avif|mp4|m4v|mov|webm|mp3|pdf|txt)$/i;

interface UploadRow {
  name: string;
  percent: number;
  error: string | null;
  done: boolean;
}

/** The folder is part of the address, so Back goes up one level and a folder can be bookmarked. */
function folderAddress(space: StorageSpace, path: string): string {
  return withQuery('/files', { space: space === 'shared' ? 'shared' : '', path });
}

export function FilesPage() {
  const ids = useId();
  const { search } = useLocation();
  const space: StorageSpace = readParam(search, 'space') === 'shared' ? 'shared' : 'personal';
  const path = readParam(search, 'path')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const toast = useToast();
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const data = useResource<FileListResponse>(
    `/api/storage/files/list?${storageQuery({ root: 'files', space, path })}`,
  );
  useBeforeUnload(uploading);

  // After opening a folder the focused button is gone from the page: move focus to the new heading.
  useEffect(() => {
    toast.clear();
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
  }, [space, path]);

  const crumbs = path === '' ? [] : path.split('/');
  const target = { root: 'files' as const, space, path };
  const current = SPACES.find((s) => s.id === space) ?? SPACES[0];
  const folderTitle = crumbs.length > 0 ? (crumbs[crumbs.length - 1] ?? '') : (current?.label ?? '');

  function fail(err: unknown) {
    const failure = toFailure(err);
    toast.showError(failure.unreachable ? NO_CONNECTION : failure.message);
  }

  async function onFiles(list: FileList | null) {
    if (!list || list.length === 0 || uploading) return;
    const files = Array.from(list);
    setUploads(files.map((f) => ({ name: f.name, percent: 0, error: null, done: false })));
    setUploading(true);
    toast.clear();
    for (const [index, file] of files.entries()) {
      try {
        await uploadFile(target, file, (loaded, total) =>
          setUploads((all) =>
            all.map((u, i) => (i === index ? { ...u, percent: Math.round((loaded / total) * 100) } : u)),
          ),
        );
        setUploads((all) => all.map((u, i) => (i === index ? { ...u, percent: 100, done: true } : u)));
      } catch (err) {
        const failure = toFailure(err);
        setUploads((all) =>
          all.map((u, i) =>
            i === index ? { ...u, error: failure.unreachable ? NO_CONNECTION : failure.message } : u,
          ),
        );
      }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
    data.reload();
  }

  async function newFolder() {
    const name = window.prompt('Имя новой папки');
    if (!name?.trim()) return;
    try {
      await apiPost('/api/storage/files/mkdir', { space, path, name: name.trim() });
      toast.showOk(`Папка «${name.trim()}» создана.`);
      data.reload();
    } catch (err) {
      fail(err);
    }
  }

  async function rename(entry: FileEntry) {
    const name = window.prompt('Новое имя', entry.name);
    if (!name?.trim() || name.trim() === entry.name) return;
    try {
      await apiPost('/api/storage/files/rename', {
        space,
        path: joinPath(path, entry.name),
        name: name.trim(),
      });
      toast.showOk(`«${entry.name}» переименован в «${name.trim()}».`);
      data.reload();
    } catch (err) {
      fail(err);
    }
  }

  async function trash(entry: FileEntry) {
    const what = entry.type === 'dir' ? `папку «${entry.name}» со всем содержимым` : `файл «${entry.name}»`;
    if (!window.confirm(`Переместить ${what} в корзину? Восстановить сможет администратор на сервере.`))
      return;
    try {
      await apiPost('/api/storage/files/trash', { space, path: joinPath(path, entry.name) });
      toast.showOk(`«${entry.name}» перемещён в корзину.`);
      data.reload();
    } catch (err) {
      fail(err);
    }
  }

  const fileUrl = (entry: FileEntry, inline: boolean) =>
    `/api/storage/files/file?${storageQuery(target, { path: joinPath(path, entry.name) })}${inline ? '&inline=1' : ''}`;

  let content = null;
  // The failure comes first: an old list must never hide the reason the new one is missing.
  if (data.error && !data.data) {
    content = <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />;
  } else if (data.data) {
    content = (
      <>
        {data.error ? (
          <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />
        ) : null}
        {data.data.entries.length === 0 ? (
          <p class="section-lead">Здесь пока пусто. Загрузите файлы или создайте папку.</p>
        ) : (
          <ul class="files">
            {data.data.entries.map((entry) => (
              <li key={entry.name} class="files__item">
                {entry.type === 'dir' ? (
                  <button
                    type="button"
                    class="files__name files__name--dir"
                    onClick={() => navigate(folderAddress(space, joinPath(path, entry.name)))}
                  >
                    <Folder size={20} aria-hidden="true" />
                    <span>{entry.name}</span>
                  </button>
                ) : (
                  <a class="files__name" href={fileUrl(entry, false)} download={entry.name}>
                    <File size={20} aria-hidden="true" />
                    <span>{entry.name}</span>
                  </a>
                )}
                <p class="meta files__meta">
                  {entry.sizeBytes !== null ? `${formatBytes(entry.sizeBytes)} · ` : ''}
                  {formatDateTime(entry.modifiedAt)}
                </p>
                <div class="files__actions">
                  {entry.type === 'file' && VIEWABLE.test(entry.name) ? (
                    <a
                      class="button button--quiet"
                      href={fileUrl(entry, true)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Eye size={18} aria-hidden="true" />
                      Открыть
                      <span class="visually-hidden"> «{entry.name}» в новой вкладке</span>
                    </a>
                  ) : null}
                  {entry.type === 'file' ? (
                    <a class="button button--quiet" href={fileUrl(entry, false)} download={entry.name}>
                      <Download size={18} aria-hidden="true" />
                      Скачать<span class="visually-hidden"> «{entry.name}»</span>
                    </a>
                  ) : null}
                  <button type="button" class="button button--quiet" onClick={() => void rename(entry)}>
                    <Pencil size={18} aria-hidden="true" />
                    Переименовать<span class="visually-hidden"> «{entry.name}»</span>
                  </button>
                  <button type="button" class="button button--quiet" onClick={() => void trash(entry)}>
                    <Trash2 size={18} aria-hidden="true" />В корзину
                    <span class="visually-hidden"> «{entry.name}»</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  } else {
    content = <Loading label="Загружаем список файлов…" />;
  }

  return (
    <div class="page">
      <PageHeader
        title="Файлы"
        icon={FolderOpen}
        lead="Документы и любые файлы на домашнем сервере. Программы (.exe и т. п.) не сохраняются."
      />
      <fieldset class="segmented">
        <legend class="visually-hidden">Чьи файлы</legend>
        {SPACES.map((s) => (
          <button
            key={s.id}
            type="button"
            class="segmented__item"
            aria-pressed={space === s.id}
            onClick={() => navigate(folderAddress(s.id, ''), { replace: true })}
          >
            {s.label}
          </button>
        ))}
      </fieldset>
      <p class="section-lead">{current?.lead}</p>

      {crumbs.length > 0 ? (
        <nav class="crumbs" aria-label="Путь к папке">
          <button
            type="button"
            class="crumbs__item"
            onClick={() => navigate(folderAddress(space, ''))}
            aria-current={path === '' ? 'page' : undefined}
          >
            {current?.label}
          </button>
          {crumbs.map((part, i) => (
            <span key={`${i}-${part}`} class="crumbs__part">
              <ChevronRight size={16} aria-hidden="true" />
              <button
                type="button"
                class="crumbs__item"
                aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                onClick={() => navigate(folderAddress(space, crumbs.slice(0, i + 1).join('/')))}
              >
                {part}
              </button>
            </span>
          ))}
        </nav>
      ) : null}

      <div class="action-row">
        <label
          class="button button--primary upload-label"
          htmlFor={`${ids}-upload`}
          aria-disabled={uploading ? 'true' : undefined}
        >
          <Upload size={20} aria-hidden="true" />
          Загрузить файлы
        </label>
        <input
          ref={fileInput}
          id={`${ids}-upload`}
          class="visually-hidden"
          type="file"
          multiple
          disabled={uploading}
          onChange={(event) => void onFiles(event.currentTarget.files)}
        />
        <button type="button" class="button button--secondary" onClick={() => void newFolder()}>
          <FolderPlus size={20} aria-hidden="true" />
          Новая папка
        </button>
      </div>
      {data.data?.freeBytes != null ? (
        <p class="meta">
          Свободно на сервере: {formatBytes(data.data.freeBytes)}. Один файл — до{' '}
          {formatBytes(data.data.maxUploadBytes)}.
        </p>
      ) : null}

      {uploads.length > 0 ? (
        <>
          {uploading ? (
            <p class="banner banner--info" role="status">
              Не закрывайте страницу, пока идёт загрузка: иначе файл не дойдёт до сервера.
            </p>
          ) : null}
          <ul class="uploads" aria-label="Загрузка на сервер">
            {uploads.map((u, index) => (
              <li key={`${index}-${u.name}`} class="uploads__item">
                <span class="uploads__name">{u.name}</span>
                {u.error ? (
                  <span class="download__error">{u.error}</span>
                ) : (
                  <progress max={100} value={u.percent} aria-label={`${u.name}: ${u.percent} %`} />
                )}
                <span class="meta">{u.error ? '' : u.done ? 'готово' : `${u.percent} %`}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <section class="page-section" aria-label="Содержимое папки" aria-busy={data.loading && !data.data}>
        <h2 ref={heading} class="section-title" tabIndex={-1}>
          {folderTitle}
        </h2>
        {content}
      </section>
      <ToastRegion toast={toast} />
    </div>
  );
}
