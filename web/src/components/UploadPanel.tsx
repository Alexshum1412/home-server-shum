import { CircleCheck, CircleX, Copy, RotateCcw, Square, Trash2 } from 'lucide-preact';
import { formatBytes } from '../lib/format.ts';
import type { UploadSnapshot } from '../lib/uploader.ts';

const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};

const files = (n: number) => plural(n, 'файл', 'файла', 'файлов');

/** What the queue says in one sentence. */
export function summaryOf(snapshot: UploadSnapshot): string {
  const { items, running, doneCount, skippedCount, failedCount, leftCount, checking } = snapshot;
  if (checking) return `Проверяю, нет ли этих файлов на сервере: ${checking.done} из ${checking.total}.`;
  if (running) {
    const total = items.length - skippedCount;
    return `Загружаем: готово ${doneCount} из ${total}${leftCount > 0 ? `, осталось ${files(leftCount)}` : ''}.`;
  }
  const parts: string[] = [];
  if (doneCount > 0) parts.push(`загружено ${files(doneCount)}`);
  if (skippedCount > 0) parts.push(`пропущено ${files(skippedCount)} (уже есть на сервере)`);
  if (failedCount > 0) parts.push(`не удалось ${files(failedCount)}`);
  if (leftCount > 0) parts.push(`осталось ${files(leftCount)}`);
  const text = parts.join(', ');
  return text === '' ? 'Нечего загружать.' : `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The upload queue on a page: one sentence, one bar, the file in flight, and buttons that do the one thing each —
 * stop, try the failed ones again, upload the skipped ones anyway, clear the list. Never colour alone: every state
 * has a word and an icon.
 */
export function UploadPanel(props: {
  snapshot: UploadSnapshot;
  onStop: () => void;
  onRetry: () => void;
  onUploadSkipped: () => void;
  onClear: () => void;
}) {
  const { snapshot } = props;
  if (snapshot.items.length === 0) return null;
  const current = snapshot.items.find((item) => item.status === 'uploading');
  const failed = snapshot.items.filter((item) => item.status === 'failed' || item.status === 'stopped');
  const skipped = snapshot.items.filter((item) => item.status === 'skipped');
  const percent =
    snapshot.bytesTotal > 0
      ? Math.min(100, Math.round((snapshot.bytesSent / snapshot.bytesTotal) * 100))
      : 100;
  const ownPercent =
    current && current.size > 0 ? Math.min(100, Math.round((current.sentBytes / current.size) * 100)) : 0;
  const attention = !snapshot.running && (snapshot.failedCount > 0 || snapshot.leftCount > 0);
  return (
    <section
      class={attention ? 'upload-panel upload-panel--warn' : 'upload-panel'}
      aria-label="Загрузка на сервер"
    >
      <p class="upload-panel__summary" role="status">
        {summaryOf(snapshot)}
        {snapshot.running
          ? ' Не закрывайте страницу: иначе загрузка остановится (отправленное сохранится на сутки).'
          : ''}
      </p>
      {snapshot.running && !snapshot.checking && snapshot.bytesTotal > 0 ? (
        <>
          <progress
            class="upload-panel__bar"
            max={100}
            value={percent}
            aria-label={`Всего загружено: ${percent} %`}
          />
          <p class="meta">
            {formatBytes(snapshot.bytesSent)} из {formatBytes(snapshot.bytesTotal)} · {percent} %
          </p>
        </>
      ) : null}
      {current ? (
        <p class="upload-panel__current">
          <span class="upload-panel__name">{current.name}</span>
          <progress max={100} value={ownPercent} aria-label={`${current.name}: ${ownPercent} %`} />
          <span class="meta">
            {ownPercent} %{current.note ? ` · ${current.note}` : ''}
          </span>
        </p>
      ) : null}
      {snapshot.partialCheck ? (
        <p class="meta">
          Сервер ещё проверяет старые фотографии, поэтому часть повторов могла остаться незамеченной.
        </p>
      ) : null}
      {failed.length > 0 && !snapshot.running ? (
        <ul class="upload-panel__list" aria-label="Не загрузились">
          {failed.map((item) => (
            <li key={item.id} class="upload-panel__row">
              <CircleX size={18} aria-hidden="true" />
              <span>
                <strong>{item.name}</strong>: {item.note || 'остановлено'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {skipped.length > 0 && !snapshot.running ? (
        <details class="upload-panel__skipped">
          <summary>Уже есть на сервере: {files(skipped.length)}</summary>
          <ul class="upload-panel__list">
            {skipped.map((item) => (
              <li key={item.id} class="upload-panel__row">
                <Copy size={18} aria-hidden="true" />
                <span>{item.name}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div class="action-row">
        {snapshot.running ? (
          <button type="button" class="button button--secondary" onClick={props.onStop}>
            <Square size={18} aria-hidden="true" />
            Остановить
          </button>
        ) : null}
        {!snapshot.running && (snapshot.failedCount > 0 || snapshot.leftCount > 0) ? (
          <button type="button" class="button button--primary" onClick={props.onRetry}>
            <RotateCcw size={18} aria-hidden="true" />
            Повторить ({snapshot.failedCount + snapshot.leftCount})
          </button>
        ) : null}
        {!snapshot.running && snapshot.skippedCount > 0 ? (
          <button type="button" class="button button--secondary" onClick={props.onUploadSkipped}>
            <Copy size={18} aria-hidden="true" />
            Всё равно загрузить повторы
          </button>
        ) : null}
        {!snapshot.running ? (
          <button type="button" class="button button--quiet" onClick={props.onClear}>
            {snapshot.failedCount === 0 && snapshot.leftCount === 0 ? (
              <CircleCheck size={18} aria-hidden="true" />
            ) : (
              <Trash2 size={18} aria-hidden="true" />
            )}
            Убрать из списка
          </button>
        ) : null}
      </div>
    </section>
  );
}
