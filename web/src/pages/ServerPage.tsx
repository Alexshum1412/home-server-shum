import {
  Copy,
  Database,
  Download,
  FileDown,
  HardDrive,
  Lock,
  Play,
  Power,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import type {
  ProgramId,
  ProgramView,
  ServerActionResponse,
  ServerPageResponse,
  ServerReportResponse,
} from '../../../shared/server-page.ts';
import { apiGet, apiPost, toFailure } from '../api.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { type ToastApi, ToastRegion, useToast } from '../components/Toast.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatBytes, formatDateTime } from '../lib/format.ts';
import { BACKUP_STATE, LOW_SPACE, PROGRAM_STATE, SPACE_OK } from '../lib/labels.ts';
import { useIsAdmin } from '../state.tsx';

const REFRESH_MS = 10_000;

const CONFIRM: Record<'stop' | 'restart', Record<ProgramId, string>> = {
  stop: {
    dashboard:
      'Остановить сам портал?\n\nЭта страница и весь семейный портал перестанут отвечать. Включить снова можно только кнопкой «Включить сервер» на рабочем столе компьютера.',
    jellyfin: 'Остановить кинотеатр (Jellyfin)? Те, кто смотрит фильм, увидят остановку.',
    aria2: 'Остановить торрент-клиент? Идущие раздачи и скачивания остановятся.',
    llama: 'Остановить языковую модель? «Оливия» будет понимать вопросы по готовым правилам.',
  },
  restart: {
    dashboard: 'Перезапустить портал?\n\nСтраница пропадёт примерно на полминуты, идущие звонки оборвутся.',
    jellyfin: 'Перезапустить кинотеатр (Jellyfin)? Кто сейчас смотрит фильм, увидит паузу на полминуты.',
    aria2: 'Перезапустить торрент-клиент? Раздачи на минуту остановятся.',
    llama: 'Перезапустить языковую модель? Загрузка занимает до минуты.',
  },
};

function Programs(props: { page: ServerPageResponse; onDone: () => void; toast: ToastApi }) {
  const [busy, setBusy] = useState<string | null>(null);
  const { supervisor } = props.page;

  async function run(program: ProgramView, action: 'start' | 'stop' | 'restart') {
    if (action !== 'start' && !window.confirm(CONFIRM[action][program.id])) return;
    setBusy(`${action}:${program.id}`);
    try {
      const result = await apiPost<ServerActionResponse>('/api/admin/server/action', {
        action,
        program: program.id,
        ...(action === 'start' ? {} : { confirm: true }),
        ...(program.id === 'dashboard' ? { portalConfirmed: true } : {}),
      });
      props.toast.showOk(result.message);
      // The portal goes away for a moment; the page is read again after a short while.
      setTimeout(props.onDone, program.id === 'dashboard' ? 8000 : 1500);
    } catch (error) {
      props.toast.showError(toFailure(error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section class="page-section" aria-labelledby="programs-title">
      <h2 id="programs-title" class="section-title">
        <Power class="section-title__icon" size={20} aria-hidden="true" />
        Программы сервера
      </h2>
      <p class="section-lead">
        {supervisor.running
          ? 'Супервизор следит за программами и сам перезапускает их после сбоя. Отсюда можно включить, остановить или перезапустить каждую.'
          : `${supervisor.message} Пока он не запущен, кнопки ниже не работают: включите сервер кнопкой на рабочем столе компьютера.`}
      </p>
      <ul class="server-programs">
        {props.page.programs.map((program) => {
          const known = program.state !== 'unknown';
          const stopped = program.state === 'stopped';
          const can = supervisor.running && known;
          return (
            <li key={program.id} class="server-program">
              <div class="server-program__head">
                <h3 class="server-program__title">{program.title}</h3>
                <StatusBadge status={PROGRAM_STATE[program.state]} label={program.stateText} />
              </div>
              <p class="meta">
                {program.startedAt ? (
                  <>
                    Последний запуск: <RelativeTime value={program.startedAt} />
                  </>
                ) : (
                  'Время запуска неизвестно'
                )}
                {' · '}
                Перезапусков после сбоя: {program.restarts}
              </p>
              <div class="server-program__actions">
                {program.id !== 'dashboard' ? (
                  <button
                    type="button"
                    class="button button--secondary"
                    disabled={!can || !stopped || busy !== null}
                    onClick={() => void run(program, 'start')}
                  >
                    <Play size={18} aria-hidden="true" />
                    {busy === `start:${program.id}` ? 'Включаю…' : 'Включить'}
                  </button>
                ) : null}
                <button
                  type="button"
                  class="button button--secondary"
                  disabled={!can || stopped || busy !== null}
                  onClick={() => void run(program, 'restart')}
                >
                  <RefreshCw size={18} aria-hidden="true" />
                  {busy === `restart:${program.id}` ? 'Перезапускаю…' : 'Перезапустить'}
                </button>
                <button
                  type="button"
                  class="button button--quiet"
                  disabled={!can || stopped || busy !== null}
                  onClick={() => void run(program, 'stop')}
                >
                  <Power size={18} aria-hidden="true" />
                  {busy === `stop:${program.id}` ? 'Останавливаю…' : 'Остановить'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Disks(props: { page: ServerPageResponse; onDone: () => void; toast: ToastApi }) {
  const { page } = props;
  const [busy, setBusy] = useState(false);

  async function backupNow() {
    if (
      !window.confirm(
        'Сделать резервную копию сейчас? Кинотеатр остановится на несколько секунд, копирование займёт от минуты.',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const result = await apiPost<ServerActionResponse>('/api/admin/server/action', { action: 'backup' });
      props.toast.showOk(result.message);
      setTimeout(props.onDone, 3000);
    } catch (error) {
      props.toast.showError(toFailure(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="page-section" aria-labelledby="disks-title">
      <h2 id="disks-title" class="section-title">
        <HardDrive class="section-title__icon" size={20} aria-hidden="true" />
        Диски и резервные копии
      </h2>
      <ul class="server-list">
        {page.disks.map((disk) => (
          <li key={disk.path} class="server-list__row">
            <strong>Диск {disk.path}</strong>
            {disk.totalBytes === null || disk.freeBytes === null ? (
              <span>Нет данных: {disk.reason ?? 'не удалось измерить'}</span>
            ) : (
              <>
                <span>
                  свободно {formatBytes(disk.freeBytes)} из {formatBytes(disk.totalBytes)}
                </span>
                <StatusBadge status={disk.lowSpace ? LOW_SPACE : SPACE_OK} />
              </>
            )}
          </li>
        ))}
      </ul>
      <div class="server-list__row server-list__row--wide">
        <StatusBadge status={BACKUP_STATE[page.backup.state]} />
        <span>{page.backup.message}</span>
      </div>
      {page.backup.offsite ? (
        <p class="meta">Зашифрованная копия вне дома: {page.backup.offsite.message}</p>
      ) : null}
      {(page.backup.notes ?? []).map((note) => (
        <p key={note} class="meta">
          {note}
        </p>
      ))}
      <div class="action-row">
        <button
          type="button"
          class="button button--secondary"
          disabled={busy || page.backupRunning}
          onClick={() => void backupNow()}
        >
          <Database size={18} aria-hidden="true" />
          {page.backupRunning ? 'Копирование уже идёт' : busy ? 'Запускаю…' : 'Сделать копию сейчас'}
        </button>
      </div>
    </section>
  );
}

function ModelAndDownloads(props: { page: ServerPageResponse }) {
  const { model, downloads } = props.page;
  return (
    <section class="page-section" aria-labelledby="model-title">
      <h2 id="model-title" class="section-title">
        <Sparkles class="section-title__icon" size={20} aria-hidden="true" />
        Языковая модель и загрузки
      </h2>
      <div class="server-list__row server-list__row--wide">
        <StatusBadge
          status={
            !model.configured
              ? { label: 'Не подключена', tone: 'neutral', icon: 'minus' }
              : model.reachable
                ? { label: 'Отвечает', tone: 'ok', icon: 'ok' }
                : { label: 'Не отвечает', tone: 'warn', icon: 'warn' }
          }
        />
        <span>{model.message}</span>
      </div>
      <p class="meta">
        {downloads
          ? `Загрузки: всего ${downloads.total}; идут ${downloads.active}, ждут ${downloads.queued}, на паузе ${downloads.paused}, с ошибкой ${downloads.failed}, готово ${downloads.completed}.`
          : 'Загрузки: нет данных.'}
      </p>
    </section>
  );
}

/** Long text in a box that scrolls inside itself; focusable and labelled, so the keyboard can scroll it too. */
function LogBox(props: { label: string; text: string; tall?: boolean }) {
  return (
    <section
      class={props.tall ? 'server-log__box server-log__box--tall' : 'server-log__box'}
      aria-label={props.label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable from the keyboard
      tabIndex={0}
    >
      <pre class="server-log__lines">{props.text}</pre>
    </section>
  );
}

function Errors(props: { page: ServerPageResponse }) {
  return (
    <section class="page-section" aria-labelledby="errors-title">
      <h2 id="errors-title" class="section-title">
        <ScrollText class="section-title__icon" size={20} aria-hidden="true" />
        Последние ошибки
      </h2>
      <p class="section-lead">
        Последние строки журналов. Пароли, ключи, имена, адреса и папки семьи из них уже убраны.
      </p>
      {props.page.errors.map((block) => (
        <details
          key={block.source}
          class="server-log"
          open={block.lines.length > 0 && block.source !== 'supervisor'}
        >
          <summary>
            {block.label}
            {block.lines.length > 0 ? ` — ${block.lines.length}` : ''}
          </summary>
          {block.lines.length > 0 ? (
            <LogBox label={block.label} text={block.lines.join('\n')} />
          ) : (
            <p class="meta">{block.note ?? 'Нет записей.'}</p>
          )}
        </details>
      ))}
    </section>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // An address without HTTPS has no clipboard API: select the text in a field and copy it.
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    field.remove();
    return ok;
  }
}

function Report(props: { toast: ToastApi }) {
  const [report, setReport] = useState<ServerReportResponse | null>(null);
  const [busy, setBusy] = useState(false);

  async function make() {
    setBusy(true);
    try {
      setReport(await apiGet<ServerReportResponse>('/api/admin/server/report'));
    } catch (error) {
      props.toast.showError(toFailure(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!report) return;
    if (await copyText(report.text)) props.toast.showOk('Отчёт скопирован. Его можно вставить в сообщение.');
    else props.toast.showError('Не удалось скопировать. Выделите текст вручную и нажмите Ctrl+C.');
  }

  function save() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report.text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `otchet-servera-${report.generatedAt.slice(0, 10)}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <section class="page-section" aria-labelledby="report-title">
      <h2 id="report-title" class="section-title">
        <FileDown class="section-title__icon" size={20} aria-hidden="true" />
        Отчёт для помощи
      </h2>
      <p class="section-lead">
        Текст о состоянии сервера, который можно показать тому, кто помогает. В нём нет паролей, ключей, имён
        людей, адресов домашней сети и папок семьи, нет текстов сообщений: всё это убирается автоматически.
      </p>
      <div class="action-row">
        <button type="button" class="button button--secondary" onClick={() => void make()} disabled={busy}>
          <FileDown size={18} aria-hidden="true" />
          {busy ? 'Составляю…' : report ? 'Составить заново' : 'Составить отчёт'}
        </button>
      </div>
      {report ? (
        <>
          <p class="meta" role="status">
            {report.removed.length === 0
              ? 'Убирать было нечего.'
              : `Убрано из отчёта: ${report.removed.map((entry) => `${entry.what} (${entry.count})`).join(', ')}.`}
          </p>
          <div class="action-row">
            <button type="button" class="button button--primary" onClick={() => void copy()}>
              <Copy size={18} aria-hidden="true" />
              Скопировать
            </button>
            <button type="button" class="button button--secondary" onClick={save}>
              <Download size={18} aria-hidden="true" />
              Скачать
            </button>
          </div>
          <LogBox label="Текст отчёта" text={report.text} tall />
        </>
      ) : null}
    </section>
  );
}

export function ServerPage() {
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const data = useResource<ServerPageResponse>(isAdmin ? '/api/admin/server' : null);
  const reload = data.reload;

  // The page keeps itself fresh while it is open.
  useEffect(() => {
    if (!isAdmin) return;
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [isAdmin, reload]);

  if (!isAdmin) {
    return (
      <div class="page">
        <PageHeader title="Сервер" icon={Server} />
        <EmptyState icon={Lock} title="Раздел доступен только администраторам">
          <p>Если сервер нужно включить, выключить или перезапустить, попросите администратора семьи.</p>
        </EmptyState>
      </div>
    );
  }

  let content = null;
  if (data.data) {
    const page = data.data;
    content = (
      <>
        {page.portal.previousRun === 'crashed' ? (
          <div class="banner banner--warn" role="status">
            <TriangleAlert class="banner__icon" size={20} aria-hidden="true" />
            <div class="banner__body">
              <p class="banner__title">Прошлый запуск портала оборвался</p>
              <p class="banner__text">
                Он не был остановлен штатно: сбой, зависание или отключение питания
                {page.portal.previousRunAt
                  ? ` (последний признак жизни — ${formatDateTime(page.portal.previousRunAt)})`
                  : ''}
                . Сейчас всё запущено заново. Если это повторяется, составьте отчёт внизу страницы.
              </p>
            </div>
          </div>
        ) : null}
        <Programs page={page} onDone={reload} toast={toast} />
        <Disks page={page} onDone={reload} toast={toast} />
        <ModelAndDownloads page={page} />
        <Errors page={page} />
      </>
    );
  } else if (data.error) {
    content = <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} />;
  } else {
    content = <Loading label="Смотрим, как дела у сервера…" />;
  }

  return (
    <div class="page">
      <PageHeader
        title="Сервер"
        icon={Server}
        lead="Что запущено, что сломалось и что можно включить или перезапустить. Включить и выключить сервер целиком можно ещё и кнопкой на рабочем столе компьютера."
      />
      {content}
      {data.data ? <Report toast={toast} /> : null}
      <p class="meta">
        <ShieldCheck size={16} aria-hidden="true" class="server-note__icon" /> Отсюда выполняются только
        действия из этого списка, каждое записывается в журнал. Произвольные команды на компьютере недоступны.
      </p>
      <ToastRegion toast={toast} />
    </div>
  );
}
