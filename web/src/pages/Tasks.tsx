import {
  Bell,
  CalendarClock,
  CircleCheck,
  Eraser,
  ListChecks,
  ListPlus,
  ListTodo,
  Lock,
  Pencil,
  Plus,
  Repeat,
  ShoppingCart,
  Trash2,
  TriangleAlert,
  Undo2,
  UserRound,
  X,
} from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type {
  ClearDoneResponse,
  CreateManyTasksResponse,
  DeleteTaskListResponse,
  TaskInput,
  TaskListInput,
  TaskListKind,
  TaskListView,
  TaskPerson,
  TaskRepeat,
  TasksResponse,
  TaskView,
} from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { dayLabel, formatClock } from '../chat/format.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { useNow } from '../hooks/useNow.ts';
import { usePolling } from '../hooks/usePolling.ts';
import { readParam, withQuery } from '../lib/query.ts';
import {
  dueText,
  GROUP_TITLE,
  groupTasks,
  isOverdue,
  REMIND_CHOICES,
  REPEAT_LABEL,
  remindLabel,
  splitLines,
  type TaskGroupId,
  tasksOfView,
  type WallMoment,
  wallMoment,
} from '../lib/tasks.ts';
import { navigate, useLocation } from '../router.ts';
import { useSession } from '../state.tsx';

/** Somebody may be shopping with the list open: what the others tick shows up within this time. */
const REFRESH_MS = 20_000;
const MAX_MANY = 50;

const failureText = (error: unknown): string => {
  const failure = toFailure(error);
  return failure.unreachable ? NO_CONNECTION : failure.message;
};

const when = (iso: string): string => `${dayLabel(iso)}, ${formatClock(iso)}`;

// --- one row ------------------------------------------------------------------------------------

function TaskRow(props: {
  task: TaskView;
  now: WallMoment;
  me: string;
  /** Shown in the «all» view for a task that lives in a list. */
  listName: string | null;
  shopping: boolean;
  busy: boolean;
  onTick: (task: TaskView, done: boolean) => void;
  onEdit: (task: TaskView) => void;
}) {
  const { task, now } = props;
  const ids = useId();
  const overdue = isOverdue(task, now);
  const due = dueText(task, now.day);
  const classes = ['task'];
  if (task.done) classes.push('task--done');
  if (overdue) classes.push('task--overdue');
  const repeating = task.repeat !== 'none';
  return (
    <li class={classes.join(' ')}>
      <label class="task__check">
        <input
          type="checkbox"
          checked={task.done}
          disabled={props.busy}
          aria-labelledby={`${ids}-title`}
          aria-describedby={`${ids}-meta`}
          onChange={(e) => {
            // A repeating task is never «done»: ticking it moves it to its next date, so the box stays empty.
            props.onTick(task, e.currentTarget.checked);
            if (repeating) e.currentTarget.checked = false;
          }}
        />
      </label>
      <div class="task__body">
        <p id={`${ids}-title`} class="task__title">
          {task.title}
        </p>
        <p id={`${ids}-meta`} class="task__meta">
          {task.done ? (
            <span class="task__chip task__chip--ok">
              <CircleCheck size={16} aria-hidden="true" />
              {props.shopping ? 'Куплено' : 'Сделано'}
              {task.doneByName && task.doneAt ? `: ${task.doneByName}, ${when(task.doneAt)}` : ''}
            </span>
          ) : null}
          {!task.done && due ? (
            overdue ? (
              <span class="task__chip task__chip--bad">
                <TriangleAlert size={16} aria-hidden="true" />
                Просрочено: {due}
              </span>
            ) : (
              <span class="task__chip">
                <CalendarClock size={16} aria-hidden="true" />
                {due}
              </span>
            )
          ) : null}
          {repeating ? (
            <span class="task__chip">
              <Repeat size={16} aria-hidden="true" />
              {REPEAT_LABEL[task.repeat]}
            </span>
          ) : null}
          {task.remindBefore !== null && !task.done ? (
            <span class="task__chip">
              <Bell size={16} aria-hidden="true" />
              {remindLabel(task.remindBefore)}
            </span>
          ) : null}
          {task.assigneeName ? (
            <span class="task__chip">
              <UserRound size={16} aria-hidden="true" />
              {task.assignee === props.me ? 'Поручено вам' : `Поручено: ${task.assigneeName}`}
            </span>
          ) : null}
          {props.listName ? (
            <span class="task__chip">
              <ListTodo size={16} aria-hidden="true" />
              {props.listName}
            </span>
          ) : null}
          {task.private ? (
            <span class="task__chip">
              <Lock size={16} aria-hidden="true" />
              Только для вас
            </span>
          ) : null}
          {task.owner !== props.me && !props.shopping ? (
            <span class="task__chip">Добавил(а): {task.ownerName}</span>
          ) : null}
        </p>
        {task.note ? <p class="task__note">{task.note}</p> : null}
        {repeating && task.lastDoneAt && task.lastDoneByName ? (
          <p class="meta">
            В прошлый раз сделал(а): {task.lastDoneByName}, {when(task.lastDoneAt)}
          </p>
        ) : null}
      </div>
      <div class="task__actions">
        {task.canUndo ? (
          <button
            type="button"
            class="button button--quiet"
            disabled={props.busy}
            onClick={() => props.onTick(task, false)}
          >
            <Undo2 size={18} aria-hidden="true" />
            Вернуть<span class="visually-hidden"> «{task.title}» на прежний срок</span>
          </button>
        ) : null}
        {task.canEdit ? (
          <button type="button" class="button button--quiet" onClick={() => props.onEdit(task)}>
            <Pencil size={18} aria-hidden="true" />
            Изменить<span class="visually-hidden"> «{task.title}»</span>
          </button>
        ) : null}
      </div>
    </li>
  );
}

// --- dialogs ------------------------------------------------------------------------------------

interface Draft {
  title: string;
  listId: string | null;
  private: boolean;
}

/** Dialog for adding and changing a task. */
function TaskDialog(props: {
  task: TaskView | null;
  draft: Draft;
  lists: readonly TaskListView[];
  people: readonly TaskPerson[];
  me: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const ids = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const start = props.task;
  const [title, setTitle] = useState(start?.title ?? props.draft.title);
  const [note, setNote] = useState(start?.note ?? '');
  const [due, setDue] = useState(start?.due ?? '');
  const [dueTime, setDueTime] = useState(start?.dueTime ?? '');
  const [repeat, setRepeat] = useState<TaskRepeat>(start?.repeat ?? 'none');
  const [remind, setRemind] = useState(start?.remindBefore == null ? '' : String(start.remindBefore));
  const [listId, setListId] = useState(start ? (start.listId ?? '') : (props.draft.listId ?? ''));
  const [assignee, setAssignee] = useState(start?.assignee ?? '');
  const [priv, setPriv] = useState(start?.private ?? props.draft.private);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const list = props.lists.find((item) => item.id === listId) ?? null;
  // A task is private exactly when its list is; without a list the author decides.
  const isPrivate = list ? list.private : priv;
  const mine = start === null || start.owner === props.me;
  const remindChoices = [...REMIND_CHOICES];
  if (start?.remindBefore != null && !remindChoices.includes(start.remindBefore)) {
    remindChoices.push(start.remindBefore);
  }

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    titleRef.current?.focus();
  }, []);

  async function submit(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) {
      setError('Напишите, что нужно сделать.');
      titleRef.current?.focus();
      return;
    }
    const body: TaskInput = {
      title: title.trim(),
      note: note.trim(),
      due: due || null,
      dueTime: due && dueTime ? dueTime : null,
      repeat: due ? repeat : 'none',
      assignee: isPrivate || !assignee ? null : assignee,
      remindBefore: due && remind !== '' ? Number(remind) : null,
      private: isPrivate,
      listId: listId || null,
    };
    setBusy(true);
    setError('');
    try {
      await apiPost(start ? `/api/tasks/${start.id}/update` : '/api/tasks', body);
      props.onSaved(start ? 'Дело изменено.' : 'Дело добавлено.');
      ref.current?.close();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!start || busy) return;
    const more = start.repeat !== 'none' ? ' Оно повторяется — исчезнут и все следующие разы.' : '';
    if (!window.confirm(`Удалить дело «${start.title}»?${more}`)) return;
    setBusy(true);
    try {
      await apiPost(`/api/tasks/${start.id}/delete`);
      props.onSaved('Дело удалено.');
      ref.current?.close();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} class="sheet-dialog" aria-labelledby={`${ids}-heading`} onClose={props.onClose}>
      <form class="user-form" onSubmit={submit} noValidate>
        <div class="sheet-dialog__head">
          <h2 id={`${ids}-heading`} class="section-title">
            {start ? 'Изменить дело' : 'Новое дело'}
          </h2>
          <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
            <X size={20} aria-hidden="true" />
            Закрыть
          </button>
        </div>
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-title`}>
            Что нужно сделать
          </label>
          <input
            ref={titleRef}
            id={`${ids}-title`}
            class="field__input"
            maxLength={120}
            required
            value={title}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </div>
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
        <div class="user-form__row">
          <div class="field">
            <label class="field__label" htmlFor={`${ids}-due`}>
              Срок (необязательно)
            </label>
            <input
              id={`${ids}-due`}
              class="field__input"
              type="date"
              value={due}
              onInput={(e) => {
                setDue(e.currentTarget.value);
                if (!e.currentTarget.value) {
                  setDueTime('');
                  setRepeat('none');
                  setRemind('');
                }
              }}
            />
          </div>
          <div class="field">
            <label class="field__label" htmlFor={`${ids}-time`}>
              Время (необязательно)
            </label>
            <input
              id={`${ids}-time`}
              class="field__input field__input--short"
              type="time"
              disabled={!due}
              value={dueTime}
              onInput={(e) => setDueTime(e.currentTarget.value)}
            />
          </div>
        </div>
        {due ? null : (
          <p class="field__hint">Чтобы дело повторялось и о нём напоминали, сначала выберите срок.</p>
        )}
        <div class="user-form__row">
          <div class="field">
            <label class="field__label" htmlFor={`${ids}-repeat`}>
              Повторять
            </label>
            <select
              id={`${ids}-repeat`}
              class="field__input"
              disabled={!due}
              value={repeat}
              onChange={(e) => setRepeat(e.currentTarget.value as TaskRepeat)}
            >
              {(Object.keys(REPEAT_LABEL) as TaskRepeat[]).map((key) => (
                <option key={key} value={key}>
                  {REPEAT_LABEL[key]}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label class="field__label" htmlFor={`${ids}-remind`}>
              Напомнить
            </label>
            <select
              id={`${ids}-remind`}
              class="field__input"
              disabled={!due}
              value={remind}
              onChange={(e) => setRemind(e.currentTarget.value)}
            >
              {remindChoices.map((minutes) => (
                <option key={minutes ?? 'never'} value={minutes === null ? '' : String(minutes)}>
                  {remindLabel(minutes)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {repeat === 'monthly' || repeat === 'yearly' ? (
          <p class="field__hint">
            Если срок — 29, 30 или 31 число (или 29 февраля), в коротком месяце дело придёт в его последний
            день.
          </p>
        ) : null}
        {due && remind !== '' && !dueTime ? (
          <p class="field__hint">Если время не указано, напоминание придёт утром, около 9:00.</p>
        ) : null}
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-list`}>
            Список
          </label>
          <select
            id={`${ids}-list`}
            class="field__input"
            value={listId}
            onChange={(e) => setListId(e.currentTarget.value)}
          >
            <option value="">Без списка</option>
            {props.lists.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.private ? ' (личный)' : ''}
              </option>
            ))}
          </select>
        </div>
        {isPrivate ? null : (
          <div class="field">
            <label class="field__label" htmlFor={`${ids}-who`}>
              Кому поручить
            </label>
            <select
              id={`${ids}-who`}
              class="field__input"
              value={assignee}
              onChange={(e) => setAssignee(e.currentTarget.value)}
            >
              <option value="">Никому</option>
              {props.people.map((person) => (
                <option key={person.username} value={person.username}>
                  {person.username === props.me ? `${person.displayName} (я)` : person.displayName}
                </option>
              ))}
            </select>
          </div>
        )}
        {mine ? (
          <label class="check">
            <input
              type="checkbox"
              checked={isPrivate}
              disabled={list !== null}
              onChange={(e) => {
                setPriv(e.currentTarget.checked);
                if (e.currentTarget.checked) setAssignee('');
              }}
            />
            Только для меня (остальные не увидят это дело)
          </label>
        ) : null}
        {list ? (
          <p class="field__hint">
            {list.private
              ? 'Список личный, поэтому и дело видите только вы.'
              : 'Список общий, поэтому дело видит вся семья.'}
          </p>
        ) : null}
        {error ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div class="action-row">
          <button type="submit" class="button button--primary" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
          {start?.canEdit ? (
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

/** Dialog for making a list or renaming one. */
function ListDialog(props: {
  list: TaskListView | null;
  onClose: () => void;
  onSaved: (message: string, list: TaskListView) => void;
}) {
  const ids = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(props.list?.name ?? '');
  const [kind, setKind] = useState<TaskListKind>('shopping');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    nameRef.current?.focus();
  }, []);

  async function submit(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError('Дайте списку название.');
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      let saved: TaskListView;
      if (props.list) {
        saved = await apiPost<TaskListView>(`/api/tasks/lists/${props.list.id}/rename`, {
          name: name.trim(),
        });
      } else {
        const body: TaskListInput = { name: name.trim(), kind, private: priv };
        saved = await apiPost<TaskListView>('/api/tasks/lists', body);
      }
      props.onSaved(props.list ? 'Список переименован.' : 'Список создан.', saved);
      ref.current?.close();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} class="sheet-dialog" aria-labelledby={`${ids}-heading`} onClose={props.onClose}>
      <form class="user-form" onSubmit={submit} noValidate>
        <div class="sheet-dialog__head">
          <h2 id={`${ids}-heading`} class="section-title">
            {props.list ? 'Переименовать список' : 'Новый список'}
          </h2>
          <button type="button" class="button button--quiet" onClick={() => ref.current?.close()}>
            <X size={20} aria-hidden="true" />
            Закрыть
          </button>
        </div>
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-name`}>
            Название списка
          </label>
          <input
            ref={nameRef}
            id={`${ids}-name`}
            class="field__input"
            maxLength={60}
            required
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </div>
        {props.list ? null : (
          <>
            <fieldset class="task-kind">
              <legend class="field__label">Какой это список</legend>
              <label class="check">
                <input
                  type="radio"
                  name={`${ids}-kind`}
                  checked={kind === 'shopping'}
                  onChange={() => setKind('shopping')}
                />
                Покупки: можно добавить сразу много пунктов, отметка — «куплено»
              </label>
              <label class="check">
                <input
                  type="radio"
                  name={`${ids}-kind`}
                  checked={kind === 'todo'}
                  onChange={() => setKind('todo')}
                />
                Дела: обычный список дел со сроками и напоминаниями
              </label>
            </fieldset>
            <label class="check">
              <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.currentTarget.checked)} />
              Только для меня (остальные не увидят список и его пункты)
            </label>
          </>
        )}
        {error ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div class="action-row">
          <button type="submit" class="button button--primary" disabled={busy}>
            {busy ? 'Сохраняем…' : props.list ? 'Сохранить' : 'Создать список'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

// --- the page -----------------------------------------------------------------------------------

type Dialog =
  | { kind: 'task'; task: TaskView | null; draft: Draft }
  | { kind: 'list'; list: TaskListView | null }
  | null;

export function TasksPage() {
  const { search } = useLocation();
  const { session } = useSession();
  const me = session.user.username;
  const data = usePolling<TasksResponse>('/api/tasks', REFRESH_MS);
  const nowMs = useNow(30_000);
  const now = wallMoment(new Date(nowMs));
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [quick, setQuick] = useState('');
  const [quickPrivate, setQuickPrivate] = useState(false);
  const [many, setMany] = useState('');
  const [adding, setAdding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const ids = useId();

  const loaded = data.data;
  const lists = loaded?.lists ?? [];
  const allTasks = loaded?.tasks ?? [];
  const wanted = readParam(search, 'list');
  const active = lists.find((list) => list.id === wanted) ?? null;
  const shopping = active?.kind === 'shopping';
  const listName = new Map(lists.map((list) => [list.id, list.name]));
  const viewTasks = tasksOfView(allTasks, lists, active?.id ?? null);
  const openCount = (listId: string | null) =>
    tasksOfView(allTasks, lists, listId).filter((t) => !t.done).length;

  function replaceTask(updated: TaskView) {
    if (!loaded) return;
    data.replace({ ...loaded, tasks: loaded.tasks.map((task) => (task.id === updated.id ? updated : task)) });
  }

  async function tick(task: TaskView, done: boolean) {
    if (busyIds.has(task.id)) return;
    setBusyIds(new Set([...busyIds, task.id]));
    try {
      const updated = await apiPost<TaskView>(`/api/tasks/${task.id}/done`, {
        done,
        occurrence: task.repeat !== 'none' && done ? task.due : null,
      });
      replaceTask(updated);
      if (task.repeat !== 'none' && done) {
        toast.showOk(`Готово. Следующий раз: ${dueText(updated, now.day)?.toLowerCase() ?? 'позже'}.`);
      }
    } catch (error) {
      toast.showError(failureText(error));
      data.refresh();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  }

  function saved(message: string) {
    toast.showOk(message);
    data.refresh();
  }

  async function addQuick(event: Event) {
    event.preventDefault();
    if (adding) return;
    const title = quick.trim();
    if (!title) {
      toast.showError('Напишите, что нужно сделать.');
      return;
    }
    setAdding(true);
    try {
      await apiPost('/api/tasks', {
        title,
        listId: active?.id ?? null,
        private: active ? active.private : quickPrivate,
      });
      setQuick('');
      saved('Дело добавлено.');
    } catch (error) {
      toast.showError(failureText(error));
    } finally {
      setAdding(false);
    }
  }

  async function addMany(event: Event) {
    event.preventDefault();
    if (adding || !active) return;
    const titles = splitLines(many);
    if (titles.length === 0) {
      toast.showError('Напишите, что нужно купить: по одному пункту на строке.');
      return;
    }
    if (titles.length > MAX_MANY) {
      toast.showError(`За один раз можно добавить не больше ${MAX_MANY} пунктов.`);
      return;
    }
    setAdding(true);
    try {
      const made = await apiPost<CreateManyTasksResponse>('/api/tasks/many', { listId: active.id, titles });
      setMany('');
      saved(`Добавлено пунктов: ${made.tasks.length}.`);
    } catch (error) {
      toast.showError(failureText(error));
    } finally {
      setAdding(false);
    }
  }

  async function clearDone() {
    if (clearing) return;
    // «All» clears the finished tasks that are in no list and in the to-do lists; a list clears itself.
    const targets: Array<string | null> = active
      ? [active.id]
      : [
          null,
          ...lists
            .filter((list) => list.kind === 'todo' && allTasks.some((t) => t.listId === list.id && t.done))
            .map((list) => list.id),
        ];
    setClearing(true);
    try {
      let removed = 0;
      let kept = 0;
      for (const target of targets) {
        const result = await apiPost<ClearDoneResponse>(
          target === null ? '/api/tasks/clear-done' : `/api/tasks/lists/${target}/clear-done`,
        );
        removed += result.removed;
        kept += result.kept;
      }
      saved(
        kept > 0
          ? `Убрано: ${removed}. Осталось ${kept}: их убирает тот, кто добавил, или создатель списка.`
          : `Убрано: ${removed}.`,
      );
    } catch (error) {
      toast.showError(failureText(error));
    } finally {
      setClearing(false);
    }
  }

  async function removeList() {
    if (!active) return;
    const count = allTasks.filter((task) => task.listId === active.id).length;
    const what = count > 0 ? ` вместе с пунктами (${count})` : '';
    if (!window.confirm(`Удалить список «${active.name}»${what}? Вернуть его будет нельзя.`)) return;
    try {
      await apiPost<DeleteTaskListResponse>(`/api/tasks/lists/${active.id}/delete`);
      navigate('/tasks', { replace: true });
      saved('Список удалён.');
    } catch (error) {
      toast.showError(failureText(error));
    }
  }

  const doneCount = viewTasks.filter((task) => task.done).length;
  const groups = groupTasks(viewTasks, now);
  const groupTitle = (id: TaskGroupId): string => {
    if (shopping && id === 'done') return 'Куплено';
    if (shopping && id === 'nodate') return 'Нужно купить';
    return GROUP_TITLE[id];
  };

  const views: Array<{
    id: string | null;
    name: string;
    icon: typeof ListTodo;
    priv: boolean;
    kind: string;
  }> = [
    { id: null, name: 'Все дела', icon: ListChecks, priv: false, kind: '' },
    ...lists.map((list) => ({
      id: list.id,
      name: list.name,
      icon: list.kind === 'shopping' ? ShoppingCart : ListTodo,
      priv: list.private,
      kind: list.kind === 'shopping' ? 'список покупок' : 'список дел',
    })),
  ];

  return (
    <div class="page">
      <PageHeader
        title="Дела"
        icon={ListChecks}
        lead="Дела семьи, списки покупок и напоминания. Общее видят все, личное — только вы."
      />

      {data.error && !loaded ? (
        <ErrorState failure={data.error} onRetry={data.refresh} busy={data.loading} />
      ) : !loaded ? (
        <Loading label="Загружаем дела…" />
      ) : (
        <>
          <nav aria-label="Списки дел" class="task-nav">
            <ul class="task-views">
              {views.map((view) => {
                const Icon = view.icon;
                const current = (view.id ?? '') === (active?.id ?? '');
                return (
                  <li key={view.id ?? 'all'}>
                    <a
                      class="task-view"
                      href={withQuery('/tasks', { list: view.id ?? '' })}
                      aria-current={current ? 'page' : undefined}
                    >
                      <Icon size={18} aria-hidden="true" />
                      <span>{view.name}</span>
                      {view.priv ? (
                        <>
                          <Lock size={14} aria-hidden="true" />
                          <span class="visually-hidden"> (личный)</span>
                        </>
                      ) : null}
                      {view.kind ? <span class="visually-hidden">, {view.kind}</span> : null}
                      <span class="task-view__count">
                        <span class="visually-hidden">, осталось: </span>
                        {openCount(view.id)}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              class="button button--secondary"
              onClick={() => setDialog({ kind: 'list', list: null })}
            >
              <ListPlus size={18} aria-hidden="true" />
              Новый список
            </button>
          </nav>

          {active ? (
            <div class="section-head task-list-head">
              <h2 class="section-title">
                {shopping ? (
                  <ShoppingCart class="section-title__icon" size={20} aria-hidden="true" />
                ) : (
                  <ListTodo class="section-title__icon" size={20} aria-hidden="true" />
                )}
                {active.name}
              </h2>
              <p class="meta">
                {shopping ? 'Список покупок' : 'Список дел'} ·{' '}
                {active.private ? 'только для вас' : `видит вся семья, создал(а): ${active.ownerName}`}
              </p>
            </div>
          ) : null}

          {shopping && active ? (
            <form class="task-add" onSubmit={addMany}>
              <div class="field">
                <label class="field__label" htmlFor={`${ids}-many`}>
                  Что купить
                </label>
                <textarea
                  id={`${ids}-many`}
                  class="field__input"
                  rows={3}
                  placeholder={'молоко\nхлеб\nяйца'}
                  value={many}
                  onInput={(e) => setMany(e.currentTarget.value)}
                />
                <p class="field__hint">По одному пункту на строке. Можно вставить список целиком.</p>
              </div>
              <div class="task-add__buttons">
                <button type="submit" class="button button--primary" disabled={adding}>
                  <Plus size={20} aria-hidden="true" />
                  Добавить в список
                </button>
              </div>
            </form>
          ) : (
            <form class="task-add" onSubmit={addQuick}>
              <div class="field">
                <label class="field__label" htmlFor={`${ids}-quick`}>
                  Новое дело
                </label>
                <input
                  id={`${ids}-quick`}
                  class="field__input"
                  maxLength={120}
                  placeholder="Например: записаться к врачу"
                  value={quick}
                  onInput={(e) => setQuick(e.currentTarget.value)}
                />
              </div>
              <div class="task-add__buttons">
                <button type="submit" class="button button--primary" disabled={adding}>
                  <Plus size={20} aria-hidden="true" />
                  Добавить
                </button>
                <button
                  type="button"
                  class="button button--secondary"
                  onClick={() =>
                    setDialog({
                      kind: 'task',
                      task: null,
                      draft: { title: quick, listId: active?.id ?? null, private: quickPrivate },
                    })
                  }
                >
                  Срок и напоминание
                </button>
              </div>
              {active ? null : (
                <label class="check task-add__private">
                  <input
                    type="checkbox"
                    checked={quickPrivate}
                    onChange={(e) => setQuickPrivate(e.currentTarget.checked)}
                  />
                  Только для меня
                </label>
              )}
            </form>
          )}

          {groups.length === 0 ? (
            <EmptyState
              icon={shopping ? ShoppingCart : ListChecks}
              title={shopping ? 'Список пока пуст' : 'Дел пока нет'}
            >
              {shopping
                ? 'Впишите покупки выше: по одному пункту на строке.'
                : 'Впишите первое дело выше. Если у него есть срок, портал напомнит о нём.'}
            </EmptyState>
          ) : (
            groups.map((group) => (
              <section key={group.id} class="page-section" aria-labelledby={`${ids}-${group.id}`}>
                <div class="section-head">
                  <h2 id={`${ids}-${group.id}`} class="section-title">
                    {groupTitle(group.id)}
                    <span class="task-count">
                      <span class="visually-hidden">: </span>
                      {group.tasks.length}
                    </span>
                  </h2>
                  {group.id === 'done' && doneCount > 0 ? (
                    <button
                      type="button"
                      class="button button--quiet"
                      disabled={clearing}
                      onClick={() => void clearDone()}
                    >
                      <Eraser size={18} aria-hidden="true" />
                      {shopping ? 'Убрать купленное' : 'Убрать выполненное'}
                    </button>
                  ) : null}
                </div>
                <ul class="tasks">
                  {group.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      now={now}
                      me={me}
                      listName={active ? null : (listName.get(task.listId ?? '') ?? null)}
                      shopping={shopping}
                      busy={busyIds.has(task.id)}
                      onTick={(item, done) => void tick(item, done)}
                      onEdit={(item) => setDialog({ kind: 'task', task: item, draft: blankDraft(active) })}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}

          {active ? (
            <div class="action-row task-list-actions">
              {active.canEdit ? (
                <>
                  <button
                    type="button"
                    class="button button--secondary"
                    onClick={() => setDialog({ kind: 'list', list: active })}
                  >
                    <Pencil size={18} aria-hidden="true" />
                    Переименовать список
                  </button>
                  <button type="button" class="button button--quiet" onClick={() => void removeList()}>
                    <Trash2 size={18} aria-hidden="true" />
                    Удалить список
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {dialog?.kind === 'task' ? (
        <TaskDialog
          key={dialog.task?.id ?? 'new'}
          task={dialog.task}
          draft={dialog.draft}
          lists={lists}
          people={loaded?.people ?? []}
          me={me}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            setQuick('');
            saved(message);
          }}
        />
      ) : null}
      {dialog?.kind === 'list' ? (
        <ListDialog
          key={dialog.list?.id ?? 'new-list'}
          list={dialog.list}
          onClose={() => setDialog(null)}
          onSaved={(message, list) => {
            saved(message);
            navigate(withQuery('/tasks', { list: list.id }), { replace: true });
          }}
        />
      ) : null}
      <ToastRegion toast={toast} />
    </div>
  );
}

function blankDraft(active: TaskListView | null): Draft {
  return { title: '', listId: active?.id ?? null, private: false };
}
