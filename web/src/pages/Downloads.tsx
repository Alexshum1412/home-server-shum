import {
  CircleCheck,
  Download,
  FileUp,
  FolderOpen,
  Link2,
  LoaderCircle,
  Pause,
  Play,
  RotateCw,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type {
  DownloadCheckResponse,
  DownloadDestination,
  DownloadState,
  DownloadsResponse,
  DownloadTaskView,
  TorrentEngineView,
} from '../../../shared/api.ts';
import { ApiFailure, apiGet, apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { usePolling } from '../hooks/usePolling.ts';
import { formatBytes } from '../lib/format.ts';
import { withQuery } from '../lib/query.ts';
import { putRaw } from '../lib/upload.ts';
import { useIsAdmin, useSession } from '../state.tsx';

const ACTIVE: ReadonlySet<DownloadState> = new Set(['queued', 'downloading']);
const CHECK_POLL_MS = 2000;
const CHECK_GIVE_UP_MS = 100_000;

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

function etaText(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, seconds)} с`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  const hours = Math.floor(seconds / 3600);
  return `${hours} ч ${Math.round((seconds % 3600) / 60)} мин`;
}

function stateLabel(task: DownloadTaskView): string {
  if (task.state === 'completed' && task.torrent?.seeding) return 'Готово, раздаётся';
  return STATE_LABEL[task.state];
}

function failureText(error: unknown): string {
  const failure = toFailure(error);
  return failure.unreachable ? NO_CONNECTION : failure.message;
}

function TaskRow(props: { task: DownloadTaskView; showOwner: boolean; onChanged: () => void }) {
  const { task } = props;
  const { session } = useSession();
  // Personal folders are private: a finished file can be opened only by the one who downloaded it.
  const mine = task.owner === session.user.username;
  const torrent = task.torrent;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = percent(task);

  async function act(action: 'pause' | 'resume' | 'cancel' | 'remove' | 'retry') {
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
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  const progressText =
    task.state === 'completed'
      ? formatBytes(task.receivedBytes)
      : `${formatBytes(task.receivedBytes)}${task.sizeBytes ? ` из ${formatBytes(task.sizeBytes)}` : ''}${
          task.state === 'downloading' && task.speedBps ? ` · ↓ ${formatBytes(task.speedBps)}/с` : ''
        }`;
  const torrentText = torrent
    ? [
        torrent.uploadSpeedBps ? `↑ ${formatBytes(torrent.uploadSpeedBps)}/с` : '',
        task.state === 'downloading' && torrent.etaSec !== null ? `осталось ${etaText(torrent.etaSec)}` : '',
        torrent.seeders !== null && task.state === 'downloading' ? `раздающих: ${torrent.seeders}` : '',
        torrent.seeding || torrent.uploadedBytes > 0 ? `отдано ${formatBytes(torrent.uploadedBytes)}` : '',
      ]
        .filter((part) => part !== '')
        .join(' · ')
    : '';
  const finished = task.state === 'completed' || task.state === 'canceled' || task.state === 'failed';

  return (
    <li class={`download download--${task.state}`}>
      <div class="download__head">
        <p class="download__name">{task.fileName}</p>
        <p class="download__state">{stateLabel(task)}</p>
      </div>
      <p class="meta download__meta">
        {task.kind === 'torrent' ? 'торрент' : task.host}
        {props.showOwner ? ` · ${task.owner}` : ''} · {progressText}
        {torrentText ? ` · ${torrentText}` : ''}
      </p>
      <p class="meta download__meta">Сохраняется: {task.destinationLabel}</p>
      {!finished ? (
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
        {task.state === 'completed' && task.kind === 'link' && mine ? (
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
        {task.state === 'completed' && task.kind === 'torrent' ? (
          task.inLibrary ? (
            <a class="button button--secondary" href="/cinema">
              <Play size={18} aria-hidden="true" />
              Открыть в кинотеатре
            </a>
          ) : mine ? (
            <a class="button button--quiet" href={withQuery('/files', { path: 'Загрузки' })}>
              <FolderOpen size={18} aria-hidden="true" />
              Открыть в «Файлах»
            </a>
          ) : null
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
        {task.state === 'paused' ? (
          <button
            type="button"
            class="button button--quiet"
            disabled={busy}
            onClick={() => void act('resume')}
          >
            <Play size={18} aria-hidden="true" />
            Продолжить
          </button>
        ) : null}
        {task.state === 'failed' ? (
          <button
            type="button"
            class="button button--quiet"
            disabled={busy}
            onClick={() => void act(task.kind === 'torrent' ? 'retry' : 'resume')}
          >
            <RotateCw size={18} aria-hidden="true" />
            Повторить
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
        {finished ? (
          <button
            type="button"
            class="button button--quiet"
            disabled={busy}
            onClick={() => void act('remove')}
          >
            <Trash2 size={18} aria-hidden="true" />
            {task.state === 'completed' && torrent?.seeding
              ? 'Закончить раздачу и убрать'
              : 'Убрать из списка'}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function EngineNote(props: { engine: TorrentEngineView }) {
  if (props.engine.state === 'ok') return null;
  return (
    <p class="banner banner--info" role="status">
      <TriangleAlert size={20} aria-hidden="true" />
      <span>
        <strong>Торренты сейчас недоступны.</strong> {props.engine.message} {props.engine.hint ?? ''}{' '}
        Скачивание по обычной ссылке работает.
      </span>
    </p>
  );
}

const DESTINATION_HINT: Record<DownloadDestination, string> = {
  personal: 'видите только вы',
  movies: 'увидит вся семья в кинотеатре',
  series: 'увидит вся семья в кинотеатре',
  cartoons: 'увидит вся семья в кинотеатре',
  music: 'увидит вся семья в кинотеатре',
};

function AddForm(props: { onAdded: () => void; folderLabel: string; engine: TorrentEngineView }) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [check, setCheck] = useState<DownloadCheckResponse | null>(null);
  const [destination, setDestination] = useState<DownloadDestination>('personal');
  const [added, setAdded] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const ready = check?.status === 'ready';
  const torrentOk = props.engine.state === 'ok';

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (ready) confirmRef.current?.focus();
  }, [ready]);

  // A magnet link needs a moment to learn what it contains.
  useEffect(() => {
    if (check?.status !== 'pending') return;
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const next = await apiGet<DownloadCheckResponse>(`/api/downloads/check/${check.checkId}`);
        if (!alive.current) return;
        if (next.status !== 'pending') {
          clearInterval(timer);
          setCheck(next);
          if (next.status === 'failed') setError(next.error ?? 'Раздача не прошла проверку.');
        } else if (Date.now() - started > CHECK_GIVE_UP_MS) {
          clearInterval(timer);
          setCheck(null);
          setError(
            'Не удалось узнать состав раздачи: сейчас нет раздающих. Попробуйте позже или найдите другую ссылку.',
          );
        }
      } catch (err) {
        clearInterval(timer);
        if (alive.current) {
          setCheck(null);
          setError(failureText(err));
        }
      }
    }, CHECK_POLL_MS);
    return () => clearInterval(timer);
  }, [check]);

  function accept(result: DownloadCheckResponse) {
    setDestination('personal');
    if (result.status === 'failed') {
      setCheck(null);
      setError(result.error ?? 'Раздача не прошла проверку.');
    } else {
      setCheck(result);
    }
  }

  async function submitCheck(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (!url.trim()) {
      setError('Вставьте ссылку на файл или магнитную ссылку.');
      urlRef.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    setAdded('');
    try {
      accept(await apiPost<DownloadCheckResponse>('/api/downloads/check', { url: url.trim() }));
    } catch (err) {
      setError(failureText(err));
      urlRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function chooseTorrentFile(file: File | undefined) {
    if (fileRef.current) fileRef.current.value = '';
    if (!file || busy) return;
    if (file.size > 4 * 1024 * 1024) {
      setError('Файл .torrent должен быть не больше 4 МБ.');
      return;
    }
    setBusy(true);
    setError('');
    setAdded('');
    try {
      const text = await putRaw(
        `/api/downloads/torrent-file?${new URLSearchParams({ name: file.name }).toString()}`,
        file,
      );
      accept(JSON.parse(text) as DownloadCheckResponse);
    } catch (err) {
      setError(err instanceof ApiFailure ? failureText(err) : 'Не удалось прочитать файл .torrent.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (check?.status !== 'ready' || busy) return;
    setBusy(true);
    setError('');
    try {
      const task = await apiPost<DownloadTaskView>('/api/downloads', { checkId: check.checkId, destination });
      setAdded(
        `«${check.fileName}» добавлен в очередь. Готовые файлы появятся здесь: ${task.destinationLabel}.`,
      );
      setCheck(null);
      setUrl('');
      props.onAdded();
    } catch (err) {
      setError(failureText(err));
      setCheck(null);
    } finally {
      setBusy(false);
    }
  }

  const skipped = check?.files.filter((file) => file.skipped) ?? [];
  return (
    <section class="page-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} class="section-title">
        <Link2 class="section-title__icon" size={20} aria-hidden="true" />
        Добавить загрузку
      </h2>
      <EngineNote engine={props.engine} />
      <form class="download-form" onSubmit={submitCheck} noValidate>
        <div class="field">
          <label class="field__label" htmlFor={`${id}-url`}>
            Ссылка на файл или магнитная ссылка
          </label>
          <input
            ref={urlRef}
            id={`${id}-url`}
            class="field__input"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellcheck={false}
            placeholder="https://example.com/film.mkv или magnet:?xt=…"
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
        <div class="action-row">
          <button type="submit" class="button button--secondary" disabled={busy}>
            {busy && !check ? 'Проверяем…' : 'Проверить'}
          </button>
          <input
            ref={fileRef}
            class="visually-hidden"
            id={`${id}-file`}
            type="file"
            accept=".torrent,application/x-bittorrent"
            tabIndex={-1}
            onChange={(event) => void chooseTorrentFile(event.currentTarget.files?.[0])}
          />
          {torrentOk ? (
            <label class="button button--quiet" htmlFor={`${id}-file`}>
              <FileUp size={18} aria-hidden="true" />
              Выбрать файл .torrent
            </label>
          ) : (
            <span class="button button--quiet button--disabled" role="note">
              <FileUp size={18} aria-hidden="true" />
              Файлы .torrent сейчас недоступны
            </span>
          )}
        </div>
      </form>
      {check?.status === 'pending' ? (
        <p class="banner banner--info" role="status">
          <LoaderCircle size={20} aria-hidden="true" class="spin" />
          Узнаём, что внутри раздачи. Это может занять до минуты.
        </p>
      ) : null}
      {check?.status === 'ready' ? (
        <fieldset class="download-confirm">
          <legend class="visually-hidden">Подтверждение загрузки</legend>
          <p class="download-confirm__title">
            {check.kind === 'torrent' ? 'Скачать эту раздачу?' : 'Скачать этот файл?'}
          </p>
          <dl class="facts">
            <div class="facts__row">
              <dt>{check.kind === 'torrent' ? 'Название' : 'Файл'}</dt>
              <dd>{check.fileName}</dd>
            </div>
            <div class="facts__row">
              <dt>Размер</dt>
              <dd>
                {check.willDownload
                  ? `${formatBytes(check.willDownload.sizeBytes)} (файлов: ${check.willDownload.files})`
                  : check.sizeBytes === null
                    ? 'сайт не сообщает'
                    : formatBytes(check.sizeBytes)}
              </dd>
            </div>
            {check.kind === 'link' ? (
              <>
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
              </>
            ) : null}
          </dl>
          {check.kind === 'torrent' ? (
            <>
              {skipped.length > 0 ? (
                <p class="banner banner--warn">
                  <TriangleAlert size={20} aria-hidden="true" />
                  Программы и скрипты не скачиваются: пропущено файлов — {skipped.length}.
                </p>
              ) : null}
              <details class="disclosure">
                <summary class="disclosure__summary">Что внутри ({check.files.length})</summary>
                <ul class="torrent-files">
                  {check.files.map((file) => (
                    <li
                      key={file.path}
                      class={
                        file.skipped ? 'torrent-files__row torrent-files__row--skipped' : 'torrent-files__row'
                      }
                    >
                      <span class="torrent-files__name">{file.path}</span>
                      <span class="meta">
                        {file.skipped ? 'не будет скачан' : formatBytes(file.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
              <fieldset class="user-form__group">
                <legend class="field__label">Куда сохранить</legend>
                {check.destinations.map((option) => (
                  <label key={option.id} class="check">
                    <input
                      type="radio"
                      name={`${id}-dest`}
                      checked={destination === option.id}
                      onChange={() => setDestination(option.id)}
                    />
                    <span>
                      {option.label} <span class="meta">— {DESTINATION_HINT[option.id]}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <p class="field__hint">
                Торрент — это обмен с другими людьми: пока файл скачивается (и некоторое время после), сервер
                раздаёт его другим. Скачивайте только то, что вам можно: свои, бесплатные и свободные
                материалы.
              </p>
            </>
          ) : null}
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
        <AddForm
          onAdded={data.refresh}
          folderLabel={`«${data.data.folderLabel}»`}
          engine={data.data.torrentEngine}
        />
        <section class="page-section" aria-labelledby="downloads-list">
          <h2 id="downloads-list" class="section-title">
            {isAdmin ? 'Все загрузки семьи' : 'Мои загрузки'}
          </h2>
          {data.data.limits.freeBytes !== null ? (
            <p class="section-lead">
              Свободно на диске сервера: {formatBytes(data.data.limits.freeBytes)}. Одна загрузка — не больше{' '}
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
        lead="Скачивайте файлы по ссылке, магнитной ссылке или файлу .torrent на домашний сервер: в свои файлы или сразу в общую медиатеку. Только законные материалы. Программы (.exe и т. п.) не сохраняются."
      />
      {content}
    </div>
  );
}
