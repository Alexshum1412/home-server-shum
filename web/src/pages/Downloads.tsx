import { CircleCheck, Download, FolderOpen, Link2, Pause, Play, Trash2, X } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type {
  DownloadCheckResponse,
  DownloadState,
  DownloadsResponse,
  DownloadTaskView,
} from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { usePolling } from '../hooks/usePolling.ts';
import { formatBytes } from '../lib/format.ts';
import { withQuery } from '../lib/query.ts';
import { useIsAdmin, useSession } from '../state.tsx';

const ACTIVE: ReadonlySet<DownloadState> = new Set(['queued', 'downloading']);

const STATE_LABEL: Record<DownloadState, string> = {
  queued: 'В очереди',
  downloading: 'Скачивается',
  paused: 'На паузе',
  completed: 'Готово',
  failed: 'Ошибка',
  canceled: 'Отменено',
};

function percent(task: DownloadTaskView): number | null {
  if (!task.sizeBytes) return null;
  return Math.min(100, Math.round((task.receivedBytes / task.sizeBytes) * 100));
}

function TaskRow(props: { task: DownloadTaskView; showOwner: boolean; onChanged: () => void }) {
  const { task } = props;
  const { session } = useSession();
  // Personal folders are private: a finished file can be opened only by the one who downloaded it.
  const mine = task.owner === session.user.username;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = percent(task);

  async function act(action: 'pause' | 'resume' | 'cancel' | 'remove') {
    if (
      action === 'cancel' &&
      !window.confirm(`Отменить загрузку «${task.fileName}»? Скачанная часть будет удалена.`)
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await apiPost(`/api/downloads/${task.id}/${action}`);
      props.onChanged();
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  const progressText =
    task.state === 'completed'
      ? formatBytes(task.receivedBytes)
      : `${formatBytes(task.receivedBytes)}${task.sizeBytes ? ` из ${formatBytes(task.sizeBytes)}` : ''}${
          task.state === 'downloading' && task.speedBps ? ` · ${formatBytes(task.speedBps)}/с` : ''
        }`;

  return (
    <li class={`download download--${task.state}`}>
      <div class="download__head">
        <p class="download__name">{task.fileName}</p>
        <p class="download__state">{STATE_LABEL[task.state]}</p>
      </div>
      <p class="meta download__meta">
        {task.host}
        {props.showOwner ? ` · ${task.owner}` : ''} · {progressText}
      </p>
      {task.state !== 'completed' && task.state !== 'canceled' && task.state !== 'failed' ? (
        <progress
          class="download__bar"
          max={100}
          value={p ?? undefined}
          aria-label={`Загрузка «${task.fileName}»: ${p === null ? 'размер неизвестен' : `${p} %`}`}
        />
      ) : null}
      {task.error ? <p class="download__error">{task.error}</p> : null}
      {error ? (
        <p class="download__error" role="alert">
          {error}
        </p>
      ) : null}
      <div class="download__actions">
        {task.state === 'completed' && mine ? (
          <>
            <a
              class="button button--secondary"
              href={`/api/storage/files/file?${new URLSearchParams({ space: 'personal', path: `Загрузки/${task.fileName}` }).toString()}`}
              download={task.fileName}
            >
              <Download size={18} aria-hidden="true" />
              Скачать на это устройство<span class="visually-hidden"> «{task.fileName}»</span>
            </a>
            <a class="button button--quiet" href={withQuery('/files', { path: 'Загрузки' })}>
              <FolderOpen size={18} aria-hidden="true" />
              Открыть в «Файлах»
            </a>
          </>
        ) : null}
        {task.state === 'downloading' || task.state === 'queued' ? (
          <button
            type="button"
            class="button button--quiet"
            disabled={busy}
            onClick={() => void act('pause')}
          >
            <Pause size={18} aria-hidden="true" />
            Пауза
          </button>
        ) : null}
        {task.state === 'paused' || task.state === 'failed' ? (
          <button
            type="button"
            class="button button--quiet"
            disabled={busy}
            onClick={() => void act('resume')}
          >
            <Play size={18} aria-hidden="true" />
            {task.state === 'failed' ? 'Повторить' : 'Продолжить'}
          </button>
        ) : null}
        {ACTIVE.has(task.state) || task.state === 'paused' ? (
          <button
            type="button"
            class="button button--quiet"
            disabled={busy}
            onClick={() => void act('cancel')}
          >
            <X size={18} aria-hidden="true" />
            Отменить
          </button>
        ) : null}
        {task.state === 'completed' || task.state === 'canceled' || task.state === 'failed' ? (
          <button
            type="button"
            class="button button--quiet"
            disabled={busy}
            onClick={() => void act('remove')}
          >
            <Trash2 size={18} aria-hidden="true" />
            Убрать из списка
          </button>
        ) : null}
      </div>
    </li>
  );
}

function AddForm(props: { onAdded: () => void; folderLabel: string }) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [check, setCheck] = useState<DownloadCheckResponse | null>(null);
  const [added, setAdded] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (check) confirmRef.current?.focus();
  }, [check]);

  async function submitCheck(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (!url.trim()) {
      setError('Вставьте ссылку на файл.');
      urlRef.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    setAdded('');
    try {
      setCheck(await apiPost<DownloadCheckResponse>('/api/downloads/check', { url: url.trim() }));
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.unreachable ? NO_CONNECTION : failure.message);
      urlRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!check || busy) return;
    setBusy(true);
    setError('');
    try {
      await apiPost('/api/downloads', { checkId: check.checkId });
      setAdded(
        `«${check.fileName}» добавлен в очередь. Готовый файл появится в разделе ${props.folderLabel}.`,
      );
      setCheck(null);
      setUrl('');
      props.onAdded();
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.unreachable ? NO_CONNECTION : failure.message);
      setCheck(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="page-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} class="section-title">
        <Link2 class="section-title__icon" size={20} aria-hidden="true" />
        Скачать по ссылке
      </h2>
      <form class="download-form" onSubmit={submitCheck} noValidate>
        <div class="field">
          <label class="field__label" htmlFor={`${id}-url`}>
            Прямая ссылка на файл
          </label>
          <input
            ref={urlRef}
            id={`${id}-url`}
            class="field__input"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellcheck={false}
            placeholder="https://example.com/film.mkv"
            value={url}
            onInput={(event) => {
              setUrl(event.currentTarget.value);
              setCheck(null);
            }}
          />
        </div>
        <p class="form-error" role="alert">
          {error}
        </p>
        <button type="submit" class="button button--secondary" disabled={busy}>
          {busy && !check ? 'Проверяем…' : 'Проверить ссылку'}
        </button>
      </form>
      {check ? (
        <fieldset class="download-confirm">
          <legend class="visually-hidden">Подтверждение загрузки</legend>
          <p class="download-confirm__title">Скачать этот файл?</p>
          <dl class="facts">
            <div class="facts__row">
              <dt>Файл</dt>
              <dd>{check.fileName}</dd>
            </div>
            <div class="facts__row">
              <dt>Размер</dt>
              <dd>{check.sizeBytes === null ? 'сайт не сообщает' : formatBytes(check.sizeBytes)}</dd>
            </div>
            <div class="facts__row">
              <dt>Сайт</dt>
              <dd>{check.host}</dd>
            </div>
            <div class="facts__row">
              <dt>Пауза и продолжение</dt>
              <dd>
                {check.resumable ? 'поддерживаются' : 'сайт не поддерживает — при паузе начнётся заново'}
              </dd>
            </div>
          </dl>
          <div class="action-row">
            <button
              ref={confirmRef}
              type="button"
              class="button button--primary"
              disabled={busy}
              onClick={() => void confirm()}
            >
              <Download size={20} aria-hidden="true" />
              Скачать
            </button>
            <button type="button" class="button button--quiet" disabled={busy} onClick={() => setCheck(null)}>
              Не скачивать
            </button>
          </div>
        </fieldset>
      ) : null}
      {added ? (
        <p class="banner banner--ok" role="status">
          <CircleCheck size={20} aria-hidden="true" />
          {added}
        </p>
      ) : null}
    </section>
  );
}

export function DownloadsPage() {
  const isAdmin = useIsAdmin();
  const [fast, setFast] = useState(false);
  const data = usePolling<DownloadsResponse>('/api/downloads', fast ? 2000 : 15000);
  const tasks = data.data?.tasks ?? [];
  const anyActive = tasks.some((t) => ACTIVE.has(t.state));
  useEffect(() => setFast(anyActive), [anyActive]);

  let content = null;
  if (data.data && !data.data.allowed) {
    content = (
      <p class="banner banner--info">
        Загрузки доступны по разрешению администратора. Попросите его открыть вам доступ к загрузкам.
      </p>
    );
  } else if (data.data) {
    content = (
      <>
        <AddForm onAdded={data.refresh} folderLabel={`«${data.data.folderLabel}»`} />
        <section class="page-section" aria-labelledby="downloads-list">
          <h2 id="downloads-list" class="section-title">
            {isAdmin ? 'Все загрузки семьи' : 'Мои загрузки'}
          </h2>
          {data.data.limits.freeBytes !== null ? (
            <p class="section-lead">
              Свободно на диске сервера: {formatBytes(data.data.limits.freeBytes)}. Один файл — не больше{' '}
              {formatBytes(data.data.limits.maxFileBytes)}.
            </p>
          ) : null}
          {tasks.length === 0 ? (
            <p class="section-lead">Загрузок пока нет.</p>
          ) : (
            <ul class="downloads">
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} showOwner={isAdmin} onChanged={data.refresh} />
              ))}
            </ul>
          )}
        </section>
      </>
    );
  } else if (data.error) {
    content = <ErrorState failure={data.error} onRetry={data.refresh} busy={data.loading} />;
  } else {
    content = <Loading label="Загружаем список загрузок…" />;
  }

  return (
    <div class="page">
      <PageHeader
        title="Загрузки"
        icon={Download}
        lead="Скачивайте файлы по прямой ссылке в свою папку «Загрузки» на домашнем сервере. Только законные файлы: свои, бесплатные или купленные. Программы (.exe и т. п.) не сохраняются."
      />
      {content}
    </div>
  );
}
