import { File, Folder, Undo2, X } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { StorageRoot, StorageSpace } from '../../../shared/api.ts';
import type { TrashResponse } from '../../../shared/storage-extras.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes, formatDateTime } from '../lib/format.ts';
import { ErrorState } from './ErrorState.tsx';
import { Loading } from './Skeleton.tsx';

/**
 * «Корзина»: what was deleted from this space, newest first, with «Вернуть». The portal never deletes for good:
 * emptying the trash is something only the owner does, at the server itself.
 */
export function TrashDialog(props: {
  root: StorageRoot;
  space: StorageSpace;
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const list = useResource<TrashResponse>(`/api/storage/${props.root}/trash?space=${props.space}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function restore(id: string, name: string) {
    setBusy(id);
    setProblem('');
    try {
      const result = await apiPost<{ name: string; folder: string }>(`/api/storage/${props.root}/restore`, {
        space: props.space,
        id,
      });
      props.onRestored(
        `«${result.name}» возвращён${result.folder === '' ? ' в начало' : ` в папку «${result.folder}»`}${result.name === name ? '' : ' (имя уже было занято)'}.`,
      );
      list.reload();
    } catch (error) {
      const failure = toFailure(error);
      setProblem(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <dialog ref={ref} class="sheet-dialog" aria-labelledby={`${ids}-title`} onClose={props.onClose}>
      <div class="sheet-dialog__head">
        <h2 id={`${ids}-title`} class="section-title">
          Корзина
        </h2>
        <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
          <X size={20} aria-hidden="true" />
          Закрыть
        </button>
      </div>
      <p class="meta">
        Удалённое сначала попадает сюда и лежит, пока администратор не очистит корзину на самом сервере:
        портал ничего не стирает навсегда. Отсюда можно вернуть файл или папку на место.
      </p>
      {problem ? (
        <p class="banner banner--bad" role="alert">
          {problem}
        </p>
      ) : null}
      {list.error && !list.data ? (
        <ErrorState failure={list.error} onRetry={list.reload} busy={list.loading} level={3} />
      ) : null}
      {!list.data && !list.error ? <Loading label="Открываем корзину…" /> : null}
      {list.data && list.data.entries.length === 0 ? <p class="section-lead">Корзина пуста.</p> : null}
      {list.data && list.data.entries.length > 0 ? (
        <ul class="trash-list" aria-label="Что лежит в корзине">
          {list.data.entries.map((entry) => (
            <li key={entry.id} class="trash-list__item">
              {entry.type === 'dir' ? (
                <Folder size={20} aria-hidden="true" />
              ) : (
                <File size={20} aria-hidden="true" />
              )}
              <span class="trash-list__text">
                <span class="trash-list__name">{entry.name}</span>
                <span class="meta">
                  {entry.sizeBytes !== null ? `${formatBytes(entry.sizeBytes)} · ` : ''}
                  {entry.deletedAt ? `удалено ${formatDateTime(entry.deletedAt)}` : ''}
                  {entry.from ? ` · из папки «${entry.from}»` : ''}
                </span>
              </span>
              <button
                type="button"
                class="button button--secondary"
                disabled={busy !== null}
                onClick={() => void restore(entry.id, entry.name)}
              >
                <Undo2 size={18} aria-hidden="true" />
                {busy === entry.id ? 'Возвращаю…' : 'Вернуть'}
                <span class="visually-hidden"> «{entry.name}»</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </dialog>
  );
}
