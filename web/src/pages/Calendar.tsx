import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Lock,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type {
  CalendarEventInput,
  CalendarEventView,
  CalendarOccurrence,
  CalendarRepeat,
  CalendarResponse,
} from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { useResource } from '../hooks/useResource.ts';
import {
  addDays,
  addMonths,
  dayLabel,
  gridDays,
  isDay,
  isMonth,
  monthLabel,
  monthOf,
  shortDayLabel,
  todayLocal,
} from '../lib/dates.ts';
import { readParam, withQuery } from '../lib/query.ts';
import { navigate, useLocation } from '../router.ts';
import { useSession } from '../state.tsx';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const REPEAT_LABEL: Record<CalendarRepeat, string> = {
  none: 'Не повторять',
  weekly: 'Каждую неделю',
  monthly: 'Каждый месяц',
  yearly: 'Каждый год',
};
const UPCOMING_DAYS = 14;

const address = (month: string | null, day: string | null) =>
  withQuery('/calendar', { month: month ?? '', day: day ?? '' });

function timeText(event: CalendarEventView): string {
  if (!event.time) return 'Весь день';
  return event.endTime ? `${event.time}–${event.endTime}` : event.time;
}

function groupByDay(list: readonly CalendarOccurrence[]): Map<string, CalendarOccurrence[]> {
  const map = new Map<string, CalendarOccurrence[]>();
  for (const occurrence of list) map.set(occurrence.day, [...(map.get(occurrence.day) ?? []), occurrence]);
  return map;
}

function EventLine(props: {
  occurrence: CalendarOccurrence;
  showDay?: boolean;
  onEdit: (e: CalendarEventView) => void;
}) {
  const { event, day } = props.occurrence;
  const me = useSession().session.user.username;
  return (
    <li class="agenda__item">
      <p class="agenda__time">
        {props.showDay ? `${shortDayLabel(day)}, ` : ''}
        {timeText(event)}
      </p>
      <div class="agenda__body">
        <p class="agenda__title">
          {event.title}
          {event.private ? (
            <span class="agenda__private">
              <Lock size={14} aria-hidden="true" /> только для вас
            </span>
          ) : null}
        </p>
        {event.note ? <p class="agenda__note">{event.note}</p> : null}
        {event.repeat !== 'none' ? <p class="meta">{REPEAT_LABEL[event.repeat]}</p> : null}
        {event.owner !== me ? <p class="meta">Добавил(а): {event.ownerName}</p> : null}
      </div>
      {event.canEdit ? (
        <button type="button" class="button button--quiet" onClick={() => props.onEdit(event)}>
          <Pencil size={18} aria-hidden="true" />
          Изменить<span class="visually-hidden"> «{event.title}»</span>
        </button>
      ) : null}
    </li>
  );
}

function blankEvent(day: string): CalendarEventInput {
  return {
    title: '',
    date: day,
    endDate: null,
    time: null,
    endTime: null,
    repeat: 'none',
    note: '',
    private: false,
  };
}

/** Dialog for adding and changing an event. */
function EventDialog(props: {
  event: CalendarEventView | null;
  day: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const ids = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const start = props.event ?? blankEvent(props.day);
  const [title, setTitle] = useState(start.title);
  const [date, setDate] = useState(start.date);
  const [endDate, setEndDate] = useState(start.endDate ?? '');
  const [allDay, setAllDay] = useState(start.time === null);
  const [time, setTime] = useState(start.time ?? '09:00');
  const [endTime, setEndTime] = useState(start.endTime ?? '');
  const [repeat, setRepeat] = useState<CalendarRepeat>(start.repeat);
  const [note, setNote] = useState(start.note);
  const [priv, setPriv] = useState(start.private);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    titleRef.current?.focus();
  }, []);

  async function submit(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) {
      setError('Напишите название события.');
      titleRef.current?.focus();
      return;
    }
    const body: CalendarEventInput = {
      title: title.trim(),
      date,
      endDate: repeat === 'none' && endDate && endDate !== date ? endDate : null,
      time: allDay ? null : time,
      endTime: allDay || !endTime ? null : endTime,
      repeat,
      note: note.trim(),
      private: priv,
    };
    setBusy(true);
    setError('');
    try {
      await apiPost(props.event ? `/api/calendar/${props.event.id}/update` : '/api/calendar', body);
      props.onSaved(props.event ? 'Событие изменено.' : 'Событие добавлено.');
      ref.current?.close();
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!props.event || busy) return;
    if (
      !window.confirm(
        `Удалить событие «${props.event.title}»${props.event.repeat !== 'none' ? ' вместе со всеми повторами' : ''}?`,
      )
    )
      return;
    setBusy(true);
    try {
      await apiPost(`/api/calendar/${props.event.id}/delete`);
      props.onSaved('Событие удалено.');
      ref.current?.close();
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} class="sheet-dialog" aria-labelledby={`${ids}-title`} onClose={props.onClose}>
      <form class="user-form" onSubmit={submit} noValidate>
        <div class="sheet-dialog__head">
          <h2 id={`${ids}-title`} class="section-title">
            {props.event ? 'Изменить событие' : 'Новое событие'}
          </h2>
          <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
            <X size={20} aria-hidden="true" />
            Закрыть
          </button>
        </div>
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-name`}>
            Название
          </label>
          <input
            ref={titleRef}
            id={`${ids}-name`}
            class="field__input"
            maxLength={120}
            required
            value={title}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-date`}>
            {repeat === 'none' ? 'Дата' : 'Первая дата'}
          </label>
          <input
            id={`${ids}-date`}
            class="field__input"
            type="date"
            required
            value={date}
            onInput={(e) => setDate(e.currentTarget.value)}
          />
        </div>
        <label class="check">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.currentTarget.checked)} />
          Весь день
        </label>
        {allDay ? null : (
          <div class="user-form__row">
            <div class="field">
              <label class="field__label" htmlFor={`${ids}-time`}>
                Начало
              </label>
              <input
                id={`${ids}-time`}
                class="field__input field__input--short"
                type="time"
                value={time}
                onInput={(e) => setTime(e.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label class="field__label" htmlFor={`${ids}-end`}>
                Конец (необязательно)
              </label>
              <input
                id={`${ids}-end`}
                class="field__input field__input--short"
                type="time"
                value={endTime}
                onInput={(e) => setEndTime(e.currentTarget.value)}
              />
            </div>
          </div>
        )}
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-repeat`}>
            Повторять
          </label>
          <select
            id={`${ids}-repeat`}
            class="field__input"
            value={repeat}
            onChange={(e) => setRepeat(e.currentTarget.value as CalendarRepeat)}
          >
            {(Object.keys(REPEAT_LABEL) as CalendarRepeat[]).map((key) => (
              <option key={key} value={key}>
                {REPEAT_LABEL[key]}
              </option>
            ))}
          </select>
          {repeat === 'monthly' || repeat === 'yearly' ? (
            <p class="field__hint">
              Если выбрано 29, 30 или 31 число (или 29 февраля), событие будет только в тех месяцах и годах,
              где такая дата есть.
            </p>
          ) : null}
        </div>
        {repeat === 'none' ? (
          <div class="field">
            <label class="field__label" htmlFor={`${ids}-last`}>
              Последний день (если событие на несколько дней)
            </label>
            <input
              id={`${ids}-last`}
              class="field__input"
              type="date"
              min={date}
              value={endDate}
              onInput={(e) => setEndDate(e.currentTarget.value)}
            />
          </div>
        ) : null}
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-note`}>
            Заметка (необязательно)
          </label>
          <textarea
            id={`${ids}-note`}
            class="field__input"
            rows={3}
            maxLength={1000}
            value={note}
            onInput={(e) => setNote(e.currentTarget.value)}
          />
        </div>
        <label class="check">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.currentTarget.checked)} />
          Только для меня (остальные не увидят это событие)
        </label>
        {error ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div class="action-row">
          <button type="submit" class="button button--primary" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
          {props.event ? (
            <button type="button" class="button button--quiet" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={18} aria-hidden="true" />
              Удалить
            </button>
          ) : null}
        </div>
      </form>
    </dialog>
  );
}

export function CalendarPage() {
  const { search } = useLocation();
  const today = todayLocal();
  const rawDay = readParam(search, 'day');
  const day = isDay(rawDay) ? rawDay : null;
  const rawMonth = readParam(search, 'month');
  const month = isMonth(rawMonth) ? rawMonth : monthOf(day ?? today);
  const selected = day ?? (monthOf(today) === month ? today : `${month}-01`);
  const toast = useToast();
  const [editing, setEditing] = useState<{ event: CalendarEventView | null } | null>(null);
  const days = gridDays(month);
  const first = days[0] ?? `${month}-01`;
  const last = days[41] ?? first;
  const grid = useResource<CalendarResponse>(`/api/calendar?from=${first}&to=${last}`);
  const upcoming = useResource<CalendarResponse>(
    `/api/calendar?from=${today}&to=${addDays(today, UPCOMING_DAYS - 1)}`,
  );

  const byDay = groupByDay(grid.data?.occurrences ?? []);
  const selectedList = byDay.get(selected) ?? [];

  function saved(message: string) {
    toast.showOk(message);
    grid.reload();
    upcoming.reload();
  }

  let upcomingContent = null;
  if (upcoming.data) {
    const grouped = upcoming.data.occurrences;
    upcomingContent =
      grouped.length === 0 ? (
        <p class="section-lead">В ближайшие две недели событий нет.</p>
      ) : (
        <ul class="agenda">
          {grouped.map((occurrence) => (
            <EventLine
              key={`${occurrence.day}-${occurrence.event.id}`}
              occurrence={occurrence}
              showDay
              onEdit={(event) => setEditing({ event })}
            />
          ))}
        </ul>
      );
  } else if (upcoming.error) {
    upcomingContent = (
      <ErrorState failure={upcoming.error} onRetry={upcoming.reload} busy={upcoming.loading} level={3} />
    );
  } else {
    upcomingContent = <Loading label="Загружаем ближайшие события…" />;
  }

  return (
    <div class="page">
      <PageHeader
        title="Календарь"
        icon={CalendarDays}
        lead="Общие планы семьи: врачи, школа, дни рождения. Можно добавить и личные события — их видите только вы."
      />
      <div class="action-row">
        <button type="button" class="button button--primary" onClick={() => setEditing({ event: null })}>
          <Plus size={20} aria-hidden="true" />
          Добавить событие
        </button>
        <a class="button button--secondary" href="/api/calendar/export.ics" download>
          <Download size={18} aria-hidden="true" />
          Скачать календарь (.ics)
        </a>
      </div>
      <p class="meta">
        Файл .ics открывается в календаре телефона или компьютера. Он остаётся у вас, даже если портал
        недоступен.
      </p>

      <section class="page-section" aria-labelledby="cal-upcoming">
        <h2 id="cal-upcoming" class="section-title">
          Ближайшие две недели
        </h2>
        {upcomingContent}
      </section>

      <section class="page-section" aria-labelledby="cal-month">
        <div class="cal__nav">
          <button
            type="button"
            class="button button--secondary"
            onClick={() => navigate(address(addMonths(month, -1), null))}
          >
            <ChevronLeft size={20} aria-hidden="true" />
            <span class="visually-hidden">Предыдущий месяц</span>
          </button>
          <h2 id="cal-month" class="section-title cal__month">
            {monthLabel(month)}
          </h2>
          <button
            type="button"
            class="button button--secondary"
            onClick={() => navigate(address(addMonths(month, 1), null))}
          >
            <ChevronRight size={20} aria-hidden="true" />
            <span class="visually-hidden">Следующий месяц</span>
          </button>
          <button type="button" class="button button--quiet" onClick={() => navigate(address(null, null))}>
            Сегодня
          </button>
        </div>
        {grid.error && !grid.data ? (
          <ErrorState failure={grid.error} onRetry={grid.reload} busy={grid.loading} level={3} />
        ) : (
          <div class="cal" aria-busy={grid.loading && !grid.data}>
            {WEEKDAYS.map((name) => (
              <span key={name} class="cal__weekday" aria-hidden="true">
                {name}
              </span>
            ))}
            {days.map((d) => {
              const events = byDay.get(d) ?? [];
              const classes = ['cal__day'];
              if (monthOf(d) !== month) classes.push('cal__day--other');
              if (d === today) classes.push('cal__day--today');
              if (d === selected) classes.push('cal__day--selected');
              return (
                <button
                  key={d}
                  type="button"
                  class={classes.join(' ')}
                  aria-pressed={d === selected}
                  aria-label={`${dayLabel(d)}${d === today ? ', сегодня' : ''}, событий: ${events.length}`}
                  onClick={() => navigate(address(month, d), { replace: true })}
                >
                  <span class="cal__num">{Number(d.slice(8))}</span>
                  {events.length > 0 ? (
                    <span class="cal__dots" aria-hidden="true">
                      {events.slice(0, 3).map((o) => (
                        <span
                          key={o.event.id}
                          class={o.event.private ? 'cal__dot cal__dot--private' : 'cal__dot'}
                        />
                      ))}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
        <h3 class="section-title">{dayLabel(selected)}</h3>
        {selectedList.length === 0 ? (
          <p class="section-lead">В этот день событий нет.</p>
        ) : (
          <ul class="agenda">
            {selectedList.map((occurrence) => (
              <EventLine
                key={occurrence.event.id}
                occurrence={occurrence}
                onEdit={(event) => setEditing({ event })}
              />
            ))}
          </ul>
        )}
        <div class="action-row">
          <button type="button" class="button button--secondary" onClick={() => setEditing({ event: null })}>
            <Plus size={18} aria-hidden="true" />
            Добавить на этот день
          </button>
        </div>
      </section>

      {editing ? (
        <EventDialog
          key={editing.event?.id ?? `new-${selected}`}
          event={editing.event}
          day={selected}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      ) : null}
      <ToastRegion toast={toast} />
    </div>
  );
}
