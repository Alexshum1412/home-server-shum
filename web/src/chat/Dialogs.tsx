import { LogOut, UserMinus, UserPlus, Users, X } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { ChatConversation, ChatPerson } from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { Avatar } from './Avatar.tsx';

function failureText(error: unknown): string {
  const failure = toFailure(error);
  return failure.unreachable ? NO_CONNECTION : failure.message;
}

/** A dialog that opens itself and tells the page when it is closed (Escape, «Закрыть» or the backdrop). */
function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return { ref, close: () => ref.current?.close(), onClose };
}

/** New conversation: pick a person, or a name and several people for a group. */
export function NewChatDialog(props: {
  people: ChatPerson[];
  onOpened: (conversation: ChatConversation) => void;
  onClose: () => void;
}) {
  const ids = useId();
  const { ref, close } = useDialog(props.onClose);
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [title, setTitle] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function openDirect(person: ChatPerson) {
    setBusy(true);
    setError('');
    try {
      const conversation = await apiPost<ChatConversation>('/api/chat/conversations/direct', {
        userId: person.id,
      });
      props.onOpened(conversation);
      close();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function createGroup(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (title.trim() === '') return setError('Назовите группу.');
    if (chosen.size === 0) return setError('Выберите хотя бы одного человека.');
    setBusy(true);
    setError('');
    try {
      const conversation = await apiPost<ChatConversation>('/api/chat/conversations/group', {
        title: title.trim(),
        memberIds: [...chosen],
      });
      props.onOpened(conversation);
      close();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string, on: boolean) {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  }

  return (
    <dialog ref={ref} class="sheet-dialog" aria-labelledby={`${ids}-title`} onClose={props.onClose}>
      <div class="user-form">
        <div class="sheet-dialog__head">
          <h2 id={`${ids}-title`} class="section-title">
            Новый чат
          </h2>
          <button type="button" class="button button--quiet" onClick={close}>
            <X size={20} aria-hidden="true" />
            Закрыть
          </button>
        </div>
        <fieldset class="segmented segmented--set">
          <legend class="visually-hidden">Тип чата</legend>
          <button
            type="button"
            class="segmented__item"
            aria-pressed={mode === 'direct'}
            onClick={() => setMode('direct')}
          >
            Личный
          </button>
          <button
            type="button"
            class="segmented__item"
            aria-pressed={mode === 'group'}
            onClick={() => setMode('group')}
          >
            Группа
          </button>
        </fieldset>
        {props.people.length === 0 ? (
          <p class="section-lead">
            В семье пока нет других людей. Администратор добавляет их в «Администрирование».
          </p>
        ) : mode === 'direct' ? (
          <ul class="people" aria-label="Кому написать">
            {props.people.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  class="people__row"
                  disabled={busy}
                  onClick={() => void openDirect(person)}
                >
                  <Avatar id={person.id} name={person.displayName} />
                  <span>{person.displayName}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <form class="user-form" onSubmit={createGroup} noValidate>
            <div class="field">
              <label class="field__label" htmlFor={`${ids}-name`}>
                Название группы
              </label>
              <input
                id={`${ids}-name`}
                class="field__input"
                maxLength={60}
                value={title}
                onInput={(e) => setTitle(e.currentTarget.value)}
              />
            </div>
            <fieldset class="people-fieldset">
              <legend class="field__label">Кто в группе</legend>
              {props.people.map((person) => (
                <label key={person.id} class="people__check">
                  <input
                    type="checkbox"
                    checked={chosen.has(person.id)}
                    onChange={(e) => toggle(person.id, e.currentTarget.checked)}
                  />
                  <Avatar id={person.id} name={person.displayName} size="sm" />
                  {person.displayName}
                </label>
              ))}
            </fieldset>
            <button type="submit" class="button button--primary" disabled={busy}>
              <Users size={18} aria-hidden="true" />
              {busy ? 'Создаём…' : 'Создать группу'}
            </button>
          </form>
        )}
        {error ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </dialog>
  );
}

/** Members and settings of a group (and the list of people in the family room). */
export function GroupDialog(props: {
  conversation: ChatConversation;
  people: ChatPerson[];
  me: ChatPerson;
  onChanged: () => void;
  onLeft: () => void;
  onClose: () => void;
}) {
  const ids = useId();
  const { ref, close } = useDialog(props.onClose);
  const { conversation } = props;
  const [title, setTitle] = useState(conversation.title);
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isGroup = conversation.kind === 'group';
  const memberIds = new Set(conversation.members.map((member) => member.id));
  const candidates = props.people.filter((person) => !memberIds.has(person.id));

  async function run(task: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError('');
    try {
      await task();
      props.onChanged();
      after?.();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/chat/conversations/${conversation.id}`;

  return (
    <dialog ref={ref} class="sheet-dialog" aria-labelledby={`${ids}-title`} onClose={props.onClose}>
      <div class="user-form">
        <div class="sheet-dialog__head">
          <h2 id={`${ids}-title`} class="section-title">
            {isGroup ? 'Группа' : 'Участники'}
          </h2>
          <button type="button" class="button button--quiet" onClick={close}>
            <X size={20} aria-hidden="true" />
            Закрыть
          </button>
        </div>
        {isGroup && conversation.canManage ? (
          <form
            class="field"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim() !== '' && title.trim() !== conversation.title) {
                void run(() => apiPost(`${base}/rename`, { title: title.trim() }));
              }
            }}
          >
            <label class="field__label" htmlFor={`${ids}-name`}>
              Название
            </label>
            <div class="field__with-action">
              <input
                id={`${ids}-name`}
                class="field__input"
                maxLength={60}
                value={title}
                onInput={(e) => setTitle(e.currentTarget.value)}
              />
              <button type="submit" class="button button--secondary" disabled={busy}>
                Сохранить
              </button>
            </div>
          </form>
        ) : null}
        <ul class="people" aria-label="Участники">
          {conversation.members.map((member) => (
            <li key={member.id} class="people__row people__row--static">
              <Avatar id={member.id} name={member.displayName} />
              <span>
                {member.displayName}
                {member.id === props.me.id ? ' (вы)' : ''}
                {member.id === conversation.ownerId ? ' · создатель' : ''}
              </span>
              {isGroup && conversation.canManage && member.id !== props.me.id ? (
                <button
                  type="button"
                  class="button button--quiet"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Убрать ${member.displayName} из группы?`)) {
                      void run(() => apiPost(`${base}/members/remove`, { userId: member.id }));
                    }
                  }}
                >
                  <UserMinus size={18} aria-hidden="true" />
                  Убрать<span class="visually-hidden"> {member.displayName}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {isGroup && conversation.canManage && candidates.length > 0 ? (
          <fieldset class="people-fieldset">
            <legend class="field__label">Добавить в группу</legend>
            {candidates.map((person) => (
              <label key={person.id} class="people__check">
                <input
                  type="checkbox"
                  checked={adding.has(person.id)}
                  onChange={(e) => {
                    const next = new Set(adding);
                    if (e.currentTarget.checked) next.add(person.id);
                    else next.delete(person.id);
                    setAdding(next);
                  }}
                />
                <Avatar id={person.id} name={person.displayName} size="sm" />
                {person.displayName}
              </label>
            ))}
            <button
              type="button"
              class="button button--secondary"
              disabled={busy || adding.size === 0}
              onClick={() =>
                void run(
                  () => apiPost(`${base}/members`, { memberIds: [...adding] }),
                  () => setAdding(new Set()),
                )
              }
            >
              <UserPlus size={18} aria-hidden="true" />
              Добавить
            </button>
          </fieldset>
        ) : null}
        {isGroup ? (
          <button
            type="button"
            class="button button--quiet"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Выйти из группы? Старые сообщения останутся у остальных.')) {
                void run(
                  () => apiPost(`${base}/leave`),
                  () => {
                    close();
                    props.onLeft();
                  },
                );
              }
            }}
          >
            <LogOut size={18} aria-hidden="true" />
            Выйти из группы
          </button>
        ) : null}
        {error ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </dialog>
  );
}
