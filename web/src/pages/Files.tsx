import {
  ChevronRight,
  Download,
  Eye,
  File,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { FileEntry, FileListResponse, StorageSpace } from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { FileViewer, viewKindOf } from '../components/FileViewer.tsx';
import { MoveDialog } from '../components/MoveDialog.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { QuotaNote } from '../components/QuotaNote.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { TrashDialog } from '../components/TrashDialog.tsx';
import { UploadPanel } from '../components/UploadPanel.tsx';
import { useBeforeUnload } from '../hooks/useBeforeUnload.ts';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes, formatDateTime } from '../lib/format.ts';
import { joinPath, readParam, withQuery } from '../lib/query.ts';
import { storageQuery } from '../lib/upload.ts';
import { useUploader } from '../lib/useUploader.ts';
import { navigate, useLocation } from '../router.ts';

const SPACES: ReadonlyArray<{ id: StorageSpace; label: string; lead: string }> = [
  { id: 'personal', label: 'Личное', lead: 'Видите только вы. Здесь же папка «Загрузки».' },
  { id: 'shared', label: 'Общее', lead: 'Видит вся семья: документы, сканы, учебные материалы.' },
];

/** The folder is part of the address, so Back goes up one level and a folder can be bookmarked. */
function folderAddress(space: StorageSpace, path: string): string {
  return withQuery('/files', { space: space === 'shared' ? 'shared' : '', path });
}

const things = (n: number) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} элемент`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} элемента`;
  return `${n} элементов`;
};

export function FilesPage() {
  const ids = useId();
  const { search } = useLocation();
  const space: StorageSpace = readParam(search, 'space') === 'shared' ? 'shared' : 'personal';
  const path = readParam(search, 'path')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [viewing, setViewing] = useState<FileEntry | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const data = useResource<FileListResponse>(
    `/api/storage/files/list?${storageQuery({ root: 'files', space, path })}`,
  );
  const { uploader, snapshot } = useUploader({
    root: 'files',
    space,
    strip: false,
    checkDuplicates: false,
  });
  const uploading = snapshot.running;
  useBeforeUnload(uploading);

  // After opening a folder the focused button is gone from the page: move focus to the new heading.
  useEffect(() => {
    toast.clear();
    setSelected([]);
    setViewing(null);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
  }, [space, path]);

  // When a batch ends the list is read again.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !snapshot.running) data.reload();
    wasRunning.current = snapshot.running;
  }, [snapshot.running]);

  const crumbs = path === '' ? [] : path.split('/');
  const target = { root: 'files' as const, space, path };
  const current = SPACES.find((s) => s.id === space) ?? SPACES[0];
  const folderTitle = crumbs.length > 0 ? (crumbs[crumbs.length - 1] ?? '') : (current?.label ?? '');
  const entries = data.data?.entries ?? [];
  const picked = entries.filter((entry) => selected.includes(entry.name));

  function fail(err: unknown) {
    const failure = toFailure(err);
    toast.showError(failure.unreachable ? NO_CONNECTION : failure.message);
  }

  function onFiles(list: FileList | null) {
    if (!list || list.length === 0 || uploading) return;
    toast.clear();
    uploader.clearFinished();
    uploader.add(Array.from(list), () => path);
    void uploader.start();
    if (fileInput.current) fileInput.current.value = '';
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

  /** One or several items to the trash, after one question that names what goes. */
  async function trash(names: string[]) {
    const what = names
      .map((name) => entries.find((entry) => entry.name === name))
      .filter((entry): entry is FileEntry => entry !== undefined);
    if (what.length === 0) return;
    const first = what[0] as FileEntry;
    const question =
      what.length === 1
        ? `Переместить ${first.type === 'dir' ? `папку «${first.name}» со всем содержимым` : `файл «${first.name}»`} в корзину? Её можно будет вернуть оттуда кнопкой «Корзина».`
        : `Переместить в корзину: ${things(what.length)} (папки — со всем содержимым)? Их можно будет вернуть оттуда кнопкой «Корзина».`;
    if (!window.confirm(question)) return;
    let done = 0;
    const problems: string[] = [];
    for (const entry of what) {
      try {
        await apiPost('/api/storage/files/trash', { space, path: joinPath(path, entry.name) });
        done += 1;
      } catch (err) {
        const failure = toFailure(err);
        problems.push(`«${entry.name}»: ${failure.unreachable ? NO_CONNECTION : failure.message}`);
      }
    }
    setSelected([]);
    data.reload();
    if (problems.length > 0) {
      toast.showError(
        `${done > 0 ? `В корзину перемещено: ${things(done)}. ` : ''}Не удалось: ${problems.join('; ')}`,
      );
    } else {
      toast.showOk(
        what.length === 1 ? `«${first.name}» перемещён в корзину.` : `В корзину перемещено: ${things(done)}.`,
      );
    }
  }

  async function moveTo(toFolder: string) {
    if (!moving) return;
    setMoveBusy(true);
    let done = 0;
    const problems: string[] = [];
    for (const name of moving) {
      try {
        await apiPost('/api/storage/files/move', { space, path: joinPath(path, name), to: toFolder });
        done += 1;
      } catch (err) {
        const failure = toFailure(err);
        problems.push(`«${name}»: ${failure.unreachable ? NO_CONNECTION : failure.message}`);
      }
    }
    setMoveBusy(false);
    setMoving(null);
    setSelected([]);
    data.reload();
    const where = toFolder === '' ? 'в начало' : `в папку «${toFolder.split('/').pop() ?? ''}»`;
    if (problems.length > 0) {
      toast.showError(
        `${done > 0 ? `Перемещено ${where}: ${things(done)}. ` : ''}Не удалось: ${problems.join('; ')}`,
      );
    } else {
      toast.showOk(`Перемещено ${where}: ${things(done)}.`);
    }
  }

  const fileUrl = (entry: FileEntry, inline: boolean) =>
    `/api/storage/files/file?${storageQuery(target, { path: joinPath(path, entry.name) })}${inline ? '&inline=1' : ''}`;

  const toggle = (name: string) =>
    setSelected((all) => (all.includes(name) ? all.filter((one) => one !== name) : [...all, name]));

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
        {entries.length === 0 ? (
          <p class="section-lead">Здесь пока пусто. Загрузите файлы или создайте папку.</p>
        ) : (
          <>
            {picked.length > 0 ? (
              <fieldset class="bulk-bar">
                <legend class="visually-hidden">Действия с выбранным</legend>
                <strong>Выбрано: {things(picked.length)}</strong>
                <button
                  type="button"
                  class="button button--secondary"
                  onClick={() => setMoving(picked.map((entry) => entry.name))}
                >
                  <FolderInput size={18} aria-hidden="true" />
                  Переместить…
                </button>
                <button
                  type="button"
                  class="button button--secondary"
                  onClick={() => void trash(picked.map((entry) => entry.name))}
                >
                  <Trash2 size={18} aria-hidden="true" />В корзину
                </button>
                <button type="button" class="button button--quiet" onClick={() => setSelected([])}>
                  Снять выбор
                </button>
              </fieldset>
            ) : (
              <p class="meta">
                Отметьте галочками несколько файлов, чтобы переместить их или убрать в корзину разом.
              </p>
            )}
            <ul class="files">
              {entries.map((entry) => (
                <li key={entry.name} class="files__item">
                  <div class="files__top">
                    <label class="files__pick">
                      <input
                        type="checkbox"
                        checked={selected.includes(entry.name)}
                        onChange={() => toggle(entry.name)}
                        aria-label={`Выбрать «${entry.name}»`}
                      />
                    </label>
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
                  </div>
                  <p class="meta files__meta">
                    {entry.sizeBytes !== null ? `${formatBytes(entry.sizeBytes)} · ` : ''}
                    {formatDateTime(entry.modifiedAt)}
                  </p>
                  <div class="files__actions">
                    {entry.type === 'file' && viewKindOf(entry.name) !== null ? (
                      <button type="button" class="button button--quiet" onClick={() => setViewing(entry)}>
                        <Eye size={18} aria-hidden="true" />
                        Открыть<span class="visually-hidden"> «{entry.name}»</span>
                      </button>
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
                    <button
                      type="button"
                      class="button button--quiet"
                      onClick={() => setMoving([entry.name])}
                    >
                      <FolderInput size={18} aria-hidden="true" />
                      Переместить<span class="visually-hidden"> «{entry.name}»</span>
                    </button>
                    <button
                      type="button"
                      class="button button--quiet"
                      onClick={() => void trash([entry.name])}
                    >
                      <Trash2 size={18} aria-hidden="true" />В корзину
                      <span class="visually-hidden"> «{entry.name}»</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
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
          onChange={(event) => onFiles(event.currentTarget.files)}
        />
        <button type="button" class="button button--secondary" onClick={() => void newFolder()}>
          <FolderPlus size={20} aria-hidden="true" />
          Новая папка
        </button>
        <button type="button" class="button button--secondary" onClick={() => setTrashOpen(true)}>
          <Undo2 size={20} aria-hidden="true" />
          Корзина
        </button>
      </div>
      <QuotaNote quota={data.data?.quota} />
      {data.data?.freeBytes != null ? (
        <p class="meta">
          Свободно на сервере: {formatBytes(data.data.freeBytes)}.{' '}
          {data.data.maxUploadBytes >= 1e15
            ? 'Размер файла не ограничен.'
            : `Один файл — до ${formatBytes(data.data.maxUploadBytes)}.`}{' '}
          Файл с тем же именем не заменяет прежний: рядом сохраняется копия с номером.
        </p>
      ) : null}

      <UploadPanel
        snapshot={snapshot}
        onStop={() => uploader.stop()}
        onRetry={() => void uploader.retry()}
        onUploadSkipped={() => void uploader.uploadSkipped()}
        onClear={() => uploader.clearFinished()}
      />
      <section class="page-section" aria-label="Содержимое папки" aria-busy={data.loading && !data.data}>
        <h2 ref={heading} class="section-title" tabIndex={-1}>
          {folderTitle}
        </h2>
        {content}
      </section>
      {viewing ? (
        <FileViewer
          name={viewing.name}
          sizeBytes={viewing.sizeBytes}
          inlineUrl={fileUrl(viewing, true)}
          downloadUrl={fileUrl(viewing, false)}
          onClose={() => setViewing(null)}
        />
      ) : null}
      {moving ? (
        <MoveDialog
          root="files"
          space={space}
          names={moving}
          fromPath={path}
          busy={moveBusy}
          onMove={(to) => void moveTo(to)}
          onClose={() => setMoving(null)}
        />
      ) : null}
      {trashOpen ? (
        <TrashDialog
          root="files"
          space={space}
          onClose={() => setTrashOpen(false)}
          onRestored={(message) => {
            toast.showOk(message);
            data.reload();
          }}
        />
      ) : null}
      <ToastRegion toast={toast} />
    </div>
  );
}
