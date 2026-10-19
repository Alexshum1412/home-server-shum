import { ChevronRight, Folder, FolderInput, X } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { FileListResponse, StorageRoot, StorageSpace } from '../../../shared/api.ts';
import { useResource } from '../hooks/useResource.ts';
import { joinPath } from '../lib/query.ts';
import { storageQuery } from '../lib/upload.ts';
import { ErrorState } from './ErrorState.tsx';
import { Loading } from './Skeleton.tsx';

/** «Переместить»: pick the folder (looking through the folders of this space) and say «Переместить сюда». */
export function MoveDialog(props: {
  root: StorageRoot;
  space: StorageSpace;
  /** What is moved, for the title and so that a folder is not offered as its own destination. */
  names: string[];
  fromPath: string;
  busy: boolean;
  onMove: (toFolder: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const [at, setAt] = useState(props.fromPath);
  const list = useResource<FileListResponse>(
    `/api/storage/${props.root}/list?${storageQuery({ root: props.root, space: props.space, path: at })}`,
  );
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const moving = new Set(props.names.map((name) => joinPath(props.fromPath, name)));
  const crumbs = at === '' ? [] : at.split('/');
  const folders = (list.data?.entries ?? []).filter(
    (entry) => entry.type === 'dir' && !moving.has(joinPath(at, entry.name)),
  );
  return (
    <dialog ref={ref} class="sheet-dialog" aria-labelledby={`${ids}-title`} onClose={props.onClose}>
      <div class="sheet-dialog__head">
        <h2 id={`${ids}-title`} class="section-title">
          Куда переместить:{' '}
          {props.names.length === 1 ? `«${props.names[0]}»` : `выбранное (${props.names.length})`}
        </h2>
        <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
          <X size={20} aria-hidden="true" />
          Закрыть
        </button>
      </div>
      <nav class="crumbs" aria-label="Выбранная папка">
        <button
          type="button"
          class="crumbs__item"
          onClick={() => setAt('')}
          aria-current={at === '' ? 'page' : undefined}
        >
          Начало
        </button>
        {crumbs.map((part, index) => (
          <span key={`${index}-${part}`} class="crumbs__part">
            <ChevronRight size={16} aria-hidden="true" />
            <button
              type="button"
              class="crumbs__item"
              aria-current={index === crumbs.length - 1 ? 'page' : undefined}
              onClick={() => setAt(crumbs.slice(0, index + 1).join('/'))}
            >
              {part}
            </button>
          </span>
        ))}
      </nav>
      {list.error && !list.data ? (
        <ErrorState failure={list.error} onRetry={list.reload} busy={list.loading} level={3} />
      ) : null}
      {!list.data && !list.error ? <Loading label="Открываем папку…" /> : null}
      {list.data ? (
        folders.length === 0 ? (
          <p class="meta">В этой папке нет вложенных папок.</p>
        ) : (
          <ul class="files">
            {folders.map((folder) => (
              <li key={folder.name} class="files__item">
                <button
                  type="button"
                  class="files__name files__name--dir"
                  onClick={() => setAt(joinPath(at, folder.name))}
                >
                  <Folder size={20} aria-hidden="true" />
                  <span>{folder.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      <div class="action-row">
        <button
          type="button"
          class="button button--primary"
          disabled={props.busy || at === props.fromPath}
          onClick={() => props.onMove(at)}
        >
          <FolderInput size={18} aria-hidden="true" />
          {props.busy
            ? 'Перемещаю…'
            : `Переместить сюда: ${at === '' ? 'в начало' : `«${crumbs[crumbs.length - 1] ?? ''}»`}`}
        </button>
      </div>
      {at === props.fromPath ? (
        <p class="meta">Выбрана та папка, где файлы уже лежат: откройте другую.</p>
      ) : null}
    </dialog>
  );
}
