import { CalendarClock, Trash2 } from 'lucide-preact';
import { useId, useState } from 'preact/hooks';
import type { DeadlineInput, DeadlineKind, DeadlinesResponse, DeadlineView } from '../../../shared/extras.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { useResource } from '../hooks/useResource.ts';

const KINDS: ReadonlyArray<[DeadlineKind, string]> = [
  ['document', 'Документ'],
  ['warranty', 'Гарантия'],
  ['subscription', 'Подписка'],
  ['service', 'Обслуживание'],
  ['other', 'Другое'],
];
const REMIND: ReadonlyArray<number> = [90, 30, 14, 7, 1, 0];

const kindName = (kind: DeadlineKind) => KINDS.find(([id]) => id === kind)?.[1] ?? 'Другое';
const leftWords = (n: number) =>
  n < 0
    ? `просрочено на ${-n} дн.`
    : n === 0
      ? 'сегодня последний день'
      : n === 1
        ? 'остался 1 день'
        : `осталось ${n} дн.`;
const EMPTY: DeadlineInput = {
  title: '',
  kind: 'document',
  expires: '',
  remindDays: [30, 7, 1],
  note: '',
  shared: false,
};

/** «Сроки и гарантии»: documents, warranties, subscriptions; a reminder comes before each one ends. */
export function DeadlinesPage() {
  const ids = useId();
  const toast = useToast();
  const list = useResource<DeadlinesResponse>('/api/deadlines');
  const [form, setForm] = useState<DeadlineInput>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: Event) {
    event.preventDefault();
    setBusy(true);
    try {
      if (editing) await apiPost(`/api/deadlines/${editing}`, form);
      else await apiPost('/api/deadlines', form);
      toast.showOk(editing ? 'Срок изменён.' : 'Срок добавлен.');
      setForm(EMPTY);
      setEditing(null);
      list.reload();
    } catch (error) {
      const failure = toFailure(error);
      toast.showError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: DeadlineView) {
    if (!window.confirm(`Убрать срок «${item.title}»?`)) return;
    try {
      await apiPost(`/api/deadlines/${item.id}/delete`, {});
      toast.showOk('Срок убран.');
      list.reload();
    } catch (error) {
      toast.showError(toFailure(error).message);
    }
  }

  const toggleDay = (day: number) =>
    setForm((f) => ({
      ...f,
      remindDays: f.remindDays.includes(day)
        ? f.remindDays.filter((d) => d !== day)
        : [...f.remindDays, day].sort((a, b) => b - a),
    }));

  return (
    <div class="page">
      <PageHeader
        title="Сроки и гарантии"
        icon={CalendarClock}
        lead="Страховка, паспорт, гарантия на технику, подписки: впишите дату окончания, и портал напомнит заранее. Личные сроки видите только вы."
      />
      <form
        class="page-section deadline-form"
        onSubmit={(event) => void save(event)}
        aria-labelledby={`${ids}-h`}
      >
        <h2 id={`${ids}-h`} class="section-title">
          {editing ? 'Изменить срок' : 'Новый срок'}
        </h2>
        <label class="field__label" htmlFor={`${ids}-t`}>
          Что это
        </label>
        <input
          id={`${ids}-t`}
          class="field__input"
          maxLength={120}
          placeholder="Например: страховка машины"
          value={form.title}
          onInput={(e) => setForm({ ...form, title: e.currentTarget.value })}
        />
        <label class="field__label" htmlFor={`${ids}-k`}>
          Вид
        </label>
        <select
          id={`${ids}-k`}
          class="field__input"
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.currentTarget.value as DeadlineKind })}
        >
          {KINDS.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <label class="field__label" htmlFor={`${ids}-d`}>
          Дата окончания
        </label>
        <input
          id={`${ids}-d`}
          class="field__input"
          type="date"
          value={form.expires}
          onInput={(e) => setForm({ ...form, expires: e.currentTarget.value })}
        />
        <fieldset class="deadline-form__remind">
          <legend class="field__label">Напомнить за</legend>
          {REMIND.map((day) => (
            <label key={day} class="check">
              <input
                type="checkbox"
                checked={form.remindDays.includes(day)}
                onChange={() => toggleDay(day)}
              />
              {day === 0 ? 'в день окончания' : `${day} дн.`}
            </label>
          ))}
        </fieldset>
        <label class="field__label" htmlFor={`${ids}-n`}>
          Заметка (необязательно)
        </label>
        <input
          id={`${ids}-n`}
          class="field__input"
          maxLength={300}
          value={form.note}
          onInput={(e) => setForm({ ...form, note: e.currentTarget.value })}
        />
        <label class="check">
          <input
            type="checkbox"
            checked={form.shared}
            onChange={(e) => setForm({ ...form, shared: e.currentTarget.checked })}
          />
          Общий срок: вся семья его видит и получает напоминание
        </label>
        <div class="action-row">
          <button type="submit" class="button button--primary" disabled={busy}>
            {editing ? 'Сохранить' : 'Добавить'}
          </button>
          {editing ? (
            <button
              type="button"
              class="button button--quiet"
              onClick={() => {
                setEditing(null);
                setForm(EMPTY);
              }}
            >
              Отмена
            </button>
          ) : null}
        </div>
      </form>

      <section class="page-section" aria-label="Сроки">
        {list.error && !list.data ? (
          <ErrorState failure={list.error} onRetry={list.reload} busy={list.loading} level={3} />
        ) : null}
        {!list.data && !list.error ? <Loading label="Загружаем сроки…" /> : null}
        {list.data && list.data.deadlines.length === 0 ? <p class="section-lead">Сроков пока нет.</p> : null}
        <ul class="deadlines">
          {(list.data?.deadlines ?? []).map((item) => (
            <li
              key={item.id}
              class={
                item.daysLeft < 0
                  ? 'deadline deadline--late'
                  : item.daysLeft <= 14
                    ? 'deadline deadline--soon'
                    : 'deadline'
              }
            >
              <div>
                <strong>{item.title}</strong>
                <p class="meta">
                  {kindName(item.kind)} · до {item.expires.split('-').reverse().join('.')} ·{' '}
                  {leftWords(item.daysLeft)}
                  {item.shared ? ' · общий' : ' · личный'}
                  {item.shared && !item.mine ? ` · добавил(а) ${item.ownerName}` : ''}
                </p>
                {item.note ? <p class="meta">{item.note}</p> : null}
              </div>
              <div class="files__actions">
                <button
                  type="button"
                  class="button button--quiet"
                  onClick={() => {
                    setEditing(item.id);
                    setForm({
                      title: item.title,
                      kind: item.kind,
                      expires: item.expires,
                      remindDays: item.remindDays,
                      note: item.note,
                      shared: item.shared,
                    });
                    window.scrollTo({ top: 0 });
                  }}
                >
                  Изменить<span class="visually-hidden"> «{item.title}»</span>
                </button>
                <button type="button" class="button button--quiet" onClick={() => void remove(item)}>
                  <Trash2 size={18} aria-hidden="true" />
                  Убрать<span class="visually-hidden"> «{item.title}»</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <ToastRegion toast={toast} />
    </div>
  );
}
