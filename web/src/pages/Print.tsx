import { CircleCheck, FileUp, Printer, X } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type {
  PrintColorMode,
  PrinterIppStatus,
  PrintJobState,
  PrintJobView,
  PrintResponse,
  PrintSides,
} from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { usePolling } from '../hooks/usePolling.ts';
import { formatBytes } from '../lib/format.ts';
import { PRINTER_STATE, type StatusView } from '../lib/labels.ts';
import { putRaw } from '../lib/upload.ts';
import { useData, useIsAdmin } from '../state.tsx';

const SIDES: Record<PrintSides, string> = {
  'one-sided': 'Односторонняя',
  'two-sided-long-edge': 'Двусторонняя (как книга)',
  'two-sided-short-edge': 'Двусторонняя (как блокнот)',
};
const COLORS: Record<PrintColorMode, string> = {
  auto: 'Как в файле',
  monochrome: 'Чёрно-белая',
  color: 'Цветная',
};
const STATE: Record<PrintJobState, string> = {
  checked: 'Ждёт подтверждения',
  sent: 'Отправлено на принтер',
  printing: 'Печатается',
  completed: 'Напечатано',
  canceled: 'Отменено',
  failed: 'Ошибка',
  expired: 'Не подтверждено',
};
const ACTIVE: ReadonlySet<PrintJobState> = new Set(['sent', 'printing']);

function ippView(p: PrinterIppStatus): StatusView {
  if (!p.configured) return { label: 'Не настроено', tone: 'neutral', icon: 'dashed' };
  if (p.reachable === null) return { label: 'Проверяем', tone: 'neutral', icon: 'busy' };
  if (!p.reachable) return { label: 'Не отвечает', tone: 'bad', icon: 'bad' };
  if (p.state === 'stopped' || p.acceptingJobs === false)
    return { label: 'Остановлен', tone: 'warn', icon: 'warn' };
  if (p.state === 'processing') return { label: 'Печатает', tone: 'info', icon: 'busy' };
  return { label: 'Готов к печати', tone: 'ok', icon: 'ok' };
}

function PrinterPanel(props: { printer: PrinterIppStatus }) {
  const { printer } = props;
  const { system } = useData();
  const windows = system.data?.printer;
  const levels = printer.markers.filter((m) => m.levelPercent !== null);
  return (
    <div class="service-panel">
      <div class="service-panel__status">
        <StatusBadge status={ippView(printer)} />
        <p class="meta">
          {printer.message}
          {printer.checkedAt ? (
            <>
              , проверено <RelativeTime value={printer.checkedAt} />
            </>
          ) : null}
        </p>
      </div>
      <dl class="facts">
        {windows ? (
          <div class="facts__row">
            <dt>Принтер</dt>
            <dd>{windows.name ?? 'Нет данных'}</dd>
          </div>
        ) : null}
        {printer.reasons.length > 0 ? (
          <div class="facts__row">
            <dt>Сообщает принтер</dt>
            <dd>{printer.reasons.join(', ')}</dd>
          </div>
        ) : null}
        <div class="facts__row">
          <dt>Тонер</dt>
          <dd>
            {levels.length > 0
              ? levels.map((m) => `${m.name}: ${m.levelPercent} %`).join('; ')
              : 'Принтер не сообщает уровень тонера — портал его не угадывает.'}
          </dd>
        </div>
        {windows ? (
          <div class="facts__row">
            <dt>По данным Windows</dt>
            <dd>
              <StatusBadge status={PRINTER_STATE[windows.state]} /> {windows.message}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function JobRow(props: { job: PrintJobView; showOwner: boolean; onChanged: () => void }) {
  const { job } = props;
  const [error, setError] = useState('');
  async function cancel() {
    if (!window.confirm(`Отменить печать «${job.fileName}»?`)) return;
    try {
      await apiPost(`/api/print/jobs/${job.id}/cancel`);
      props.onChanged();
    } catch (err) {
      setError(toFailure(err).message);
    }
  }
  return (
    <li
      class={`download download--${job.state === 'completed' ? 'completed' : job.state === 'failed' ? 'failed' : 'queued'}`}
    >
      <div class="download__head">
        <p class="download__name">{job.fileName}</p>
        <p class="download__state">{STATE[job.state]}</p>
      </div>
      <p class="meta download__meta">
        {props.showOwner ? `${job.owner} · ` : ''}
        {formatBytes(job.sizeBytes)} · копий: {job.copies} · {SIDES[job.sides].toLowerCase()} ·{' '}
        <RelativeTime value={job.createdAt} />
      </p>
      <p class="meta">{job.message}</p>
      {error ? (
        <p class="download__error" role="alert">
          {error}
        </p>
      ) : null}
      {ACTIVE.has(job.state) || job.state === 'checked' ? (
        <div class="download__actions">
          <button type="button" class="button button--quiet" onClick={() => void cancel()}>
            <X size={18} aria-hidden="true" />
            Отменить<span class="visually-hidden"> печать «{job.fileName}»</span>
          </button>
        </div>
      ) : null}
    </li>
  );
}

function PrintForm(props: { maxBytes: number; onChanged: () => void }) {
  const ids = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [copies, setCopies] = useState(1);
  const [sides, setSides] = useState<PrintSides>('one-sided');
  const [color, setColor] = useState<PrintColorMode>('auto');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<PrintJobView | null>(null);
  const [done, setDone] = useState('');

  async function check(event: Event) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Выберите файл PDF или JPG.');
      fileRef.current?.focus();
      return;
    }
    if (file.size > props.maxBytes) {
      setError(`Файл слишком большой: не больше ${formatBytes(props.maxBytes)}.`);
      return;
    }
    setBusy(true);
    setError('');
    setDone('');
    setProgress(0);
    try {
      const query = new URLSearchParams({
        name: file.name,
        size: String(file.size),
        copies: String(copies),
        sides,
        color,
      });
      const text = await putRaw(`/api/print/jobs?${query}`, file, (loaded, total) =>
        setProgress(Math.round((loaded / total) * 100)),
      );
      setChecked(JSON.parse(text) as PrintJobView);
      props.onChanged();
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function print() {
    if (!checked) return;
    setBusy(true);
    try {
      await apiPost(`/api/print/jobs/${checked.id}/print`, { confirm: true });
      setDone(`«${checked.fileName}» отправлен на домашний принтер.`);
      setChecked(null);
      if (fileRef.current) fileRef.current.value = '';
      props.onChanged();
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function dropChecked() {
    if (!checked) return;
    await apiPost(`/api/print/jobs/${checked.id}/cancel`).catch(() => undefined);
    setChecked(null);
    props.onChanged();
  }

  return (
    <section class="page-section" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} class="section-title">
        <FileUp class="section-title__icon" size={20} aria-hidden="true" />
        Напечатать документ
      </h2>
      <p class="section-lead">
        PDF или JPG, до {formatBytes(props.maxBytes)}. Документ Word или Excel сохраните как PDF. Печать идёт
        на домашнем принтере: если вы не дома, листы будут ждать в лотке.
      </p>
      {checked ? (
        <div class="download-confirm" role="status">
          <p class="download-confirm__title">Принтер проверил задание. Напечатать?</p>
          <dl class="facts">
            <div class="facts__row">
              <dt>Файл</dt>
              <dd>{checked.fileName}</dd>
            </div>
            <div class="facts__row">
              <dt>Копий</dt>
              <dd>{checked.copies}</dd>
            </div>
            <div class="facts__row">
              <dt>Печать</dt>
              <dd>
                {SIDES[checked.sides]}, {COLORS[checked.colorMode].toLowerCase()}
              </dd>
            </div>
          </dl>
          <div class="action-row">
            <button type="button" class="button button--primary" disabled={busy} onClick={() => void print()}>
              <Printer size={20} aria-hidden="true" />
              Напечатать
            </button>
            <button
              type="button"
              class="button button--quiet"
              disabled={busy}
              onClick={() => void dropChecked()}
            >
              Не печатать
            </button>
          </div>
        </div>
      ) : (
        <form class="download-form" onSubmit={check} noValidate>
          <div class="field">
            <label class="field__label" htmlFor={`${ids}-file`}>
              Файл
            </label>
            <input
              ref={fileRef}
              id={`${ids}-file`}
              class="field__input"
              type="file"
              accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg"
            />
          </div>
          <div class="field">
            <label class="field__label" htmlFor={`${ids}-copies`}>
              Копий
            </label>
            <input
              id={`${ids}-copies`}
              class="field__input field__input--short"
              type="number"
              inputMode="numeric"
              min={1}
              max={20}
              value={copies}
              onInput={(event) =>
                setCopies(Math.min(20, Math.max(1, Number(event.currentTarget.value) || 1)))
              }
            />
          </div>
          <div class="field">
            <label class="field__label" htmlFor={`${ids}-sides`}>
              Стороны
            </label>
            <select
              id={`${ids}-sides`}
              class="field__input"
              value={sides}
              onChange={(event) => setSides(event.currentTarget.value as PrintSides)}
            >
              {(Object.keys(SIDES) as PrintSides[]).map((key) => (
                <option key={key} value={key}>
                  {SIDES[key]}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label class="field__label" htmlFor={`${ids}-color`}>
              Цвет
            </label>
            <select
              id={`${ids}-color`}
              class="field__input"
              value={color}
              onChange={(event) => setColor(event.currentTarget.value as PrintColorMode)}
            >
              {(Object.keys(COLORS) as PrintColorMode[]).map((key) => (
                <option key={key} value={key}>
                  {COLORS[key]}
                </option>
              ))}
            </select>
          </div>
          {progress !== null ? (
            <progress class="download__bar" max={100} value={progress} aria-label="Передача файла" />
          ) : null}
          <p class="form-error" role="alert">
            {error}
          </p>
          <button type="submit" class="button button--secondary" disabled={busy}>
            {busy ? 'Проверяем на принтере…' : 'Проверить на принтере'}
          </button>
        </form>
      )}
      {done ? (
        <p class="banner banner--ok" role="status">
          <CircleCheck size={20} aria-hidden="true" />
          {done}
        </p>
      ) : null}
    </section>
  );
}

export function PrintPage() {
  const isAdmin = useIsAdmin();
  const [fast, setFast] = useState(false);
  const data = usePolling<PrintResponse>('/api/print', fast ? 3000 : 30000);
  const jobs = data.data?.jobs ?? [];
  // Poll quickly while a job is on its way or the first printer check is still running.
  const checking = data.data?.printer.configured === true && data.data.printer.reachable === null;
  const anyActive = jobs.some((j) => ACTIVE.has(j.state)) || checking;
  useEffect(() => setFast(anyActive), [anyActive]);

  let content = null;
  if (data.data) {
    const { allowed, printer } = data.data;
    content = (
      <>
        <PrinterPanel printer={printer} />
        {!allowed ? (
          <p class="banner banner--info">
            Печать через портал доступна по разрешению администратора. Попросите его открыть вам доступ к
            печати.
          </p>
        ) : !printer.configured ? (
          <p class="banner banner--info">Печать через портал не настроена на домашнем компьютере.</p>
        ) : (
          <>
            <PrintForm maxBytes={data.data.maxBytes} onChanged={data.refresh} />
            <section class="page-section" aria-labelledby="print-jobs">
              <h2 id="print-jobs" class="section-title">
                {isAdmin ? 'Задания печати семьи' : 'Мои задания печати'}
              </h2>
              {jobs.length === 0 ? (
                <p class="section-lead">Заданий пока нет.</p>
              ) : (
                <ul class="downloads">
                  {jobs.map((job) => (
                    <JobRow key={job.id} job={job} showOwner={isAdmin} onChanged={data.refresh} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </>
    );
  } else if (data.error) {
    content = <ErrorState failure={data.error} onRetry={data.refresh} busy={data.loading} />;
  } else {
    content = <Loading label="Узнаём, готов ли принтер…" />;
  }

  return (
    <div class="page">
      <PageHeader
        title="Печать"
        icon={Printer}
        lead="Отправьте PDF или фото на домашний принтер — из дома или издалека."
      />
      {content}
    </div>
  );
}
