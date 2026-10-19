import { CircleCheck, CircleX, Clock, Lightbulb, Send, Undo2, X } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type {
  CatalogSuggestion,
  CatalogSuggestionsResponse,
  CatalogSuggestionStatus,
} from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useResource } from '../hooks/useResource.ts';
import { SUGGESTION_STATUS, waitingLabel, whenLabel } from './lists.ts';

const TITLE_MAX = 120;
const NOTE_MAX = 300;

const STATUS_ICON: Record<CatalogSuggestionStatus, typeof Clock> = {
  open: Clock,
  added: CircleCheck,
  declined: CircleX,
};

function problemText(error: unknown): string {
  const failure = toFailure(error);
  return failure.unreachable ? NO_CONNECTION : failure.message;
}

function StatusPill(props: { status: CatalogSuggestionStatus }) {
  const view = SUGGESTION_STATUS[props.status];
  const Icon = STATUS_ICON[props.status];
  return (
    <span class={`badge badge--${view.tone}`}>
      <Icon class="badge__icon" size={16} aria-hidden="true" />
      {view.label}
    </span>
  );
}

function Row(props: {
  suggestion: CatalogSuggestion;
  canModerate: boolean;
  busy: boolean;
  onDecide: (status: CatalogSuggestionStatus) => void;
  onWithdraw: () => void;
}) {
  const { suggestion } = props;
  const open = suggestion.status === 'open';
  return (
    <li class="suggestion">
      <div class="suggestion__main">
        <p class="suggestion__title">{suggestion.title}</p>
        <p class="meta">
          Предлагает: {suggestion.byName}
          {suggestion.mine ? ' (вы)' : ''} · {whenLabel(suggestion.at)}
        </p>
        {suggestion.note ? <p class="suggestion__note">{suggestion.note}</p> : null}
      </div>
      <StatusPill status={suggestion.status} />
      {props.canModerate || (suggestion.mine && open) ? (
        <div class="suggestion__actions">
          {props.canModerate && suggestion.status !== 'added' ? (
            <button type="button" class="button button--secondary" disabled={props.busy} onClick={() => props.onDecide('added')}>
              <CircleCheck size={18} aria-hidden="true" />
              Добавлено<span class="visually-hidden">: {suggestion.title}</span>
            </button>
          ) : null}
          {props.canModerate && suggestion.status !== 'declined' ? (
            <button type="button" class="button button--secondary" disabled={props.busy} onClick={() => props.onDecide('declined')}>
              <CircleX size={18} aria-hidden="true" />
              Отклонено<span class="visually-hidden">: {suggestion.title}</span>
            </button>
          ) : null}
          {props.canModerate && !open ? (
            <button type="button" class="button button--quiet" disabled={props.busy} onClick={() => props.onDecide('open')}>
              <Undo2 size={18} aria-hidden="true" />
              Вернуть на рассмотрение<span class="visually-hidden">: {suggestion.title}</span>
            </button>
          ) : null}
          {suggestion.mine && open ? (
            <button type="button" class="button button--quiet" disabled={props.busy} onClick={props.onWithdraw}>
              <X size={18} aria-hidden="true" />
              Отозвать<span class="visually-hidden">: {suggestion.title}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** «Предложить фильм»: a short form and the whole family's list; administrators answer here. */
function SuggestionsDialog(props: { onClose: () => void; onChanged: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const list = useResource<CatalogSuggestionsResponse>('/api/catalog/suggestions');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    titleRef.current?.focus();
  }, []);

  async function send(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (title.trim() === '') {
      setProblem('Напишите название фильма или сериала.');
      setDone('');
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setProblem('');
    setDone('');
    try {
      await apiPost<CatalogSuggestion>('/api/catalog/suggestions', {
        title: title.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setTitle('');
      setNote('');
      setDone('Спасибо! Предложение добавлено в список, администратор его увидит.');
      list.reload();
      props.onChanged();
      titleRef.current?.focus();
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  }

  async function change(action: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true);
    setProblem('');
    setDone('');
    try {
      await action();
      setDone(message);
      list.reload();
      props.onChanged();
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  }

  const data = list.data;
  return (
    <dialog ref={ref} class="sheet-dialog suggestions-dialog" aria-labelledby={`${ids}-title`} onClose={props.onClose}>
      <div class="sheet-dialog__head">
        <h2 id={`${ids}-title`} class="section-title">
          Предложить фильм
        </h2>
        <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
          <X size={20} aria-hidden="true" />
          Закрыть
        </button>
      </div>
      <p class="meta">
        Напишите, что хотите видеть в медиатеке. Предложения видит вся семья, а администратор отвечает на них: «добавлено»
        или «отклонено».
      </p>
      <form class="user-form" onSubmit={send} noValidate>
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-name`}>
            Название фильма или сериала
          </label>
          <input
            ref={titleRef}
            id={`${ids}-name`}
            class="field__input"
            maxLength={TITLE_MAX}
            value={title}
            autoComplete="off"
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-note`}>
            Пояснение (необязательно)
          </label>
          <textarea
            id={`${ids}-note`}
            class="field__input suggestions-dialog__note"
            rows={3}
            maxLength={NOTE_MAX}
            value={note}
            onInput={(event) => setNote(event.currentTarget.value)}
          />
          <p class="field__hint">Например: год, кто снял или почему хочется посмотреть.</p>
        </div>
        <button type="submit" class="button button--primary" disabled={busy}>
          <Send size={18} aria-hidden="true" />
          {busy ? 'Отправляем…' : 'Отправить предложение'}
        </button>
      </form>
      <p class={done === '' ? 'banner banner--ok visually-hidden' : 'banner banner--ok suggestions-dialog__message'} role="status">
        {done}
      </p>
      <p class={problem === '' ? 'banner banner--bad visually-hidden' : 'banner banner--bad suggestions-dialog__message'} role="alert">
        {problem}
      </p>
      <h3 class="suggestions-dialog__subtitle">Предложения семьи</h3>
      {list.error && !data ? <ErrorState failure={list.error} onRetry={list.reload} busy={list.loading} level={3} /> : null}
      {!data && !list.error ? <Loading label="Загружаем список…" /> : null}
      {data && data.suggestions.length === 0 ? <p class="meta">Пока никто ничего не предложил.</p> : null}
      {data && data.suggestions.length > 0 ? (
        <ul class="suggestion-list" aria-label="Предложения семьи">
          {data.suggestions.map((suggestion) => (
            <Row
              key={suggestion.id}
              suggestion={suggestion}
              canModerate={data.canModerate}
              busy={busy}
              onDecide={(status) =>
                void change(
                  () => apiPost(`/api/admin/catalog/suggestions/${suggestion.id}`, { status }),
                  status === 'added'
                    ? 'Отмечено: добавлено.'
                    : status === 'declined'
                      ? 'Отмечено: отклонено.'
                      : 'Предложение возвращено на рассмотрение.',
                )
              }
              onWithdraw={() =>
                void change(
                  () => apiPost(`/api/catalog/suggestions/${suggestion.id}/withdraw`),
                  'Предложение отозвано.',
                )
              }
            />
          ))}
        </ul>
      ) : null}
    </dialog>
  );
}

/** The button «Предложить фильм» (with how many wait for an answer) and, when it is open, the window. */
export function SuggestEntry(props: {
  open: boolean;
  waiting: number;
  onOpen: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <>
      <div class="suggest-entry">
        <button type="button" class="button button--secondary" onClick={props.onOpen}>
          <Lightbulb size={18} aria-hidden="true" />
          Предложить фильм
        </button>
        {props.waiting > 0 ? <span class="meta">{waitingLabel(props.waiting)}</span> : null}
      </div>
      {props.open ? <SuggestionsDialog onClose={props.onClose} onChanged={props.onChanged} /> : null}
    </>
  );
}
