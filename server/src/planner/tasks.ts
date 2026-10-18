/**
 * Family tasks, shopping lists and reminders («Дела»): tasks.json in the portal's data folder, so
 * every backup has them. The rules, in one place:
 *
 * - A private task or list is seen only by its author — an administrator is not an exception, and for
 *   everybody else it does not even exist (404, not 403).
 * - A shared task or list is seen by everybody who is signed in, and everybody may tick or untick a
 *   shared task. Changing or deleting it is for its author and for administrators; the person a task
 *   was given to may only change its done state.
 * - A task in a list is private exactly when its list is private (fixed when the list is made).
 * - A repeating task is never «done»: ticking it moves its due date to the next time and remembers
 *   when it was done. The day of the month of the first date is kept, so «31st» survives short months.
 * - A reminder is told once per occurrence: the occurrence that was told is written into the task
 *   before the news goes out, so a restart cannot tell it twice (see task-reminders.ts).
 */
import path from 'node:path';
import { z } from 'zod';
import type {
  ClearDoneResponse,
  TaskInput,
  TaskListInput,
  TaskListView,
  TaskRepeat,
  TaskSearchHit,
  TaskView,
} from '../../../shared/api.ts';
import { normaliseUsername } from '../auth/users.ts';
import { normalise, words } from '../files/search.ts';
import { newId } from '../lib/ids.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import { REMOVED_OWNER } from './calendar.ts';
import { isRealDate, isTime } from './dates.ts';
import { localMoment, nextOccurrence, reminderWindow } from './task-dates.ts';

export class TaskError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const TITLE_MAX = 120;
export const NOTE_MAX = 1000;
export const LIST_NAME_MAX = 60;
export const MAX_TASKS = 5000;
/** One person cannot fill the whole file for everybody (and nobody else can clean it up). */
export const MAX_TASKS_PER_USER = 500;
export const MAX_LISTS = 300;
export const MAX_LISTS_PER_USER = 30;
/** Items added in one go (a shopping trip). */
export const MAX_MANY = 50;
/** A week: reminders further ahead than that are not a reminder any more. */
export const MAX_REMIND_BEFORE = 7 * 24 * 60;

const repeatValues = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const;

const taskSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  ownerName: z.string(),
  assigneeName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string().min(1).max(TITLE_MAX),
  note: z.string().max(NOTE_MAX),
  due: z.string().refine(isRealDate).nullable(),
  dueTime: z.string().refine(isTime).nullable(),
  repeat: z.enum(repeatValues),
  /** First date of a repeating task: the day of the month is taken from it. */
  repeatFrom: z.string().refine(isRealDate).nullable(),
  assignee: z.string().nullable(),
  remindBefore: z.number().int().min(0).max(MAX_REMIND_BEFORE).nullable(),
  /** The occurrence (see occurrenceKey) the reminder was already told for. */
  remindedFor: z.string().nullable(),
  private: z.boolean(),
  listId: z.string().nullable(),
  done: z.boolean(),
  doneAt: z.string().nullable(),
  doneBy: z.string().nullable(),
  doneByName: z.string().nullable(),
  lastDoneAt: z.string().nullable(),
  lastDoneBy: z.string().nullable(),
  lastDoneByName: z.string().nullable(),
  /** What to put back when a person takes back the last tick of a repeating task. */
  undo: z
    .object({
      due: z.string().refine(isRealDate),
      lastDoneAt: z.string().nullable(),
      lastDoneBy: z.string().nullable(),
      lastDoneByName: z.string().nullable(),
    })
    .nullable(),
});

const listSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(LIST_NAME_MAX),
  kind: z.enum(['todo', 'shopping']),
  private: z.boolean(),
  owner: z.string().min(1),
  ownerName: z.string(),
  createdAt: z.string(),
});

const fileSchema = z.object({ version: z.literal(1), tasks: z.array(taskSchema), lists: z.array(listSchema) });

type StoredTask = z.infer<typeof taskSchema>;
type StoredList = z.infer<typeof listSchema>;
interface TasksFile {
  tasks: StoredTask[];
  lists: StoredList[];
}

export interface Viewer {
  username: string;
  isAdmin: boolean;
}
export type Writer = Viewer & { displayName: string };

/** What a request may contain, before it is checked with plain words (see checkTaskInput). */
export interface RawTaskInput {
  title: string;
  note: string;
  due: string | null;
  dueTime: string | null;
  repeat: TaskRepeat;
  assignee: string | null;
  remindBefore: number | null;
  private: boolean;
  listId: string | null;
}

const blank = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim());

/** One line, no control characters. */
function cleanTitle(value: string): string {
  return value.replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

/** Checks the combination of fields; returns a Russian problem or the clean input. */
export function checkTaskInput(raw: RawTaskInput): TaskInput {
  const bad = (message: string) => new TaskError(400, 'bad_task', message);
  const title = cleanTitle(raw.title);
  if (title === '') throw bad('Напишите, что нужно сделать.');
  if (title.length > TITLE_MAX) throw bad(`Название не длиннее ${TITLE_MAX} знаков.`);
  const note = raw.note.replace(/\r\n?/g, '\n').trim();
  if (note.length > NOTE_MAX) throw bad(`Заметка не длиннее ${NOTE_MAX} знаков.`);
  const due = blank(raw.due);
  if (due !== null && !isRealDate(due)) throw bad('Укажите настоящую дату.');
  const dueTime = blank(raw.dueTime);
  if (dueTime !== null) {
    if (due === null) throw bad('Время можно указать только вместе с датой.');
    if (!isTime(dueTime)) throw bad('Время указано неверно (например, 18:30).');
  }
  if (raw.repeat !== 'none' && due === null) throw bad('Чтобы дело повторялось, укажите дату.');
  if (raw.remindBefore !== null) {
    if (due === null) throw bad('Напоминание нужно привязать к сроку: укажите дату.');
    if (!Number.isInteger(raw.remindBefore) || raw.remindBefore < 0 || raw.remindBefore > MAX_REMIND_BEFORE) {
      throw bad('Напомнить можно не раньше, чем за неделю до срока.');
    }
  }
  const assignee = blank(raw.assignee);
  return {
    title,
    note,
    due,
    dueTime,
    repeat: raw.repeat,
    assignee: assignee === null ? null : normaliseUsername(assignee),
    remindBefore: raw.remindBefore,
    private: raw.private,
    listId: blank(raw.listId),
  };
}

export function checkListInput(raw: { name: string; kind: 'todo' | 'shopping'; private: boolean }): TaskListInput {
  const name = cleanTitle(raw.name);
  if (name === '') throw new TaskError(400, 'bad_list', 'Дайте списку название.');
  if (name.length > LIST_NAME_MAX) {
    throw new TaskError(400, 'bad_list', `Название списка не длиннее ${LIST_NAME_MAX} знаков.`);
  }
  return { name, kind: raw.kind, private: raw.private };
}

/** Titles typed one per line (or pasted): clean, no empty ones, no more than a shopping trip needs. */
export function checkManyTitles(titles: readonly string[]): string[] {
  const clean = titles.map(cleanTitle).filter((title) => title !== '');
  if (clean.length === 0) throw new TaskError(400, 'bad_task', 'Напишите, что нужно добавить.');
  if (clean.length > MAX_MANY) {
    throw new TaskError(400, 'bad_task', `За один раз можно добавить не больше ${MAX_MANY} пунктов.`);
  }
  const long = clean.find((title) => title.length > TITLE_MAX);
  if (long !== undefined) {
    throw new TaskError(400, 'bad_task', `Пункт «${long.slice(0, 30)}…» длиннее ${TITLE_MAX} знаков.`);
  }
  return clean;
}

/** A reminder that has become due: what the notification needs to know. */
export interface ReminderJob {
  taskId: string;
  /** The occurrence told about (also written into the task). */
  key: string;
  title: string;
  due: string;
  dueTime: string | null;
  owner: string;
  ownerName: string;
  assignee: string | null;
  private: boolean;
}

export function createTasksStore(dataDir: string, options: { clock: Clock }) {
  const file = path.join(dataDir, 'tasks.json');
  const queue = createSerialQueue();
  const { clock } = options;

  async function read(): Promise<TasksFile> {
    let data: unknown;
    try {
      data = await readJsonFile(file);
    } catch {
      throw new TaskError(
        503,
        'unavailable',
        'Файл с делами на сервере повреждён. Сообщите администратору: портал его не трогает, пока не починят.',
      );
    }
    if (data === undefined) return { tasks: [], lists: [] };
    const parsed = fileSchema.safeParse(data);
    if (!parsed.success) {
      throw new TaskError(
        503,
        'unavailable',
        'Файл с делами на сервере имеет неверный формат. Сообщите администратору.',
      );
    }
    return { tasks: parsed.data.tasks, lists: parsed.data.lists };
  }

  const write = (data: TasksFile) => writeJsonAtomic(file, { version: 1, tasks: data.tasks, lists: data.lists });

  const listsById = (lists: readonly StoredList[]) => new Map(lists.map((list) => [list.id, list]));
  const listVisible = (list: StoredList, viewer: Viewer) => !list.private || list.owner === viewer.username;
  /** A task of a private list stays hidden even if its own flag were wrong: both are checked. */
  const taskVisible = (task: StoredTask, lists: Map<string, StoredList>, viewer: Viewer) => {
    if (task.private && task.owner !== viewer.username) return false;
    const list = task.listId === null ? undefined : lists.get(task.listId);
    return list === undefined || listVisible(list, viewer);
  };
  const mayChange = (task: { owner: string }, viewer: Viewer) => task.owner === viewer.username || viewer.isAdmin;

  const notFoundTask = () => new TaskError(404, 'not_found', 'Такого дела нет.');
  const notFoundList = () => new TaskError(404, 'not_found', 'Такого списка нет.');

  function taskView(task: StoredTask, lists: Map<string, StoredList>, viewer: Viewer): TaskView {
    return {
      id: task.id,
      title: task.title,
      note: task.note,
      due: task.due,
      dueTime: task.dueTime,
      repeat: task.repeat,
      assignee: task.assignee,
      assigneeName: task.assigneeName,
      remindBefore: task.remindBefore,
      private: task.private,
      listId: task.listId !== null && lists.has(task.listId) ? task.listId : null,
      owner: task.owner,
      ownerName: task.ownerName,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      done: task.done,
      doneAt: task.doneAt,
      doneBy: task.doneBy,
      doneByName: task.doneByName,
      lastDoneAt: task.lastDoneAt,
      lastDoneByName: task.lastDoneByName,
      canEdit: mayChange(task, viewer),
      canUndo: task.repeat !== 'none' && task.undo !== null,
    };
  }

  function listView(list: StoredList, viewer: Viewer): TaskListView {
    return {
      id: list.id,
      name: list.name,
      kind: list.kind,
      private: list.private,
      owner: list.owner,
      ownerName: list.ownerName,
      createdAt: list.createdAt,
      canEdit: mayChange(list, viewer),
    };
  }

  /** The list a task is put into: it must be seen by the person and, when private, be the task owner's own. */
  function placeIn(
    lists: Map<string, StoredList>,
    listId: string | null,
    viewer: Viewer,
    taskOwner: string,
  ): StoredList | null {
    if (listId === null) return null;
    const list = lists.get(listId);
    if (!list || !listVisible(list, viewer)) throw new TaskError(400, 'bad_list', 'Такого списка нет.');
    if (list.private && list.owner !== taskOwner) {
      throw new TaskError(400, 'bad_list', 'Это личный список другого человека.');
    }
    return list;
  }

  function checkRoom(data: TasksFile, viewer: Viewer, adding: number): void {
    if (data.tasks.length + adding > MAX_TASKS) {
      throw new TaskError(409, 'too_many', 'В «Делах» слишком много записей. Уберите выполненное.');
    }
    const own = data.tasks.filter((task) => task.owner === viewer.username).length;
    if (own + adding > MAX_TASKS_PER_USER) {
      const left = Math.max(0, MAX_TASKS_PER_USER - own);
      throw new TaskError(
        409,
        'too_many_own',
        left === 0
          ? `У вас уже ${MAX_TASKS_PER_USER} дел. Уберите выполненные, чтобы добавить новые.`
          : `Можно добавить ещё ${left}: больше ${MAX_TASKS_PER_USER} дел у одного человека не бывает. Уберите выполненные.`,
      );
    }
  }

  return {
    file,

    /** Everything this person may see. */
    async list(viewer: Viewer): Promise<{ tasks: TaskView[]; lists: TaskListView[] }> {
      const data = await read();
      const lists = listsById(data.lists);
      return {
        tasks: data.tasks.filter((task) => taskVisible(task, lists, viewer)).map((task) => taskView(task, lists, viewer)),
        lists: data.lists
          .filter((list) => listVisible(list, viewer))
          .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
          .map((list) => listView(list, viewer)),
      };
    },

    create(viewer: Writer, input: TaskInput, assigneeName: string | null): Promise<TaskView> {
      return queue.run(async () => {
        const data = await read();
        checkRoom(data, viewer, 1);
        const lists = listsById(data.lists);
        const list = placeIn(lists, input.listId, viewer, viewer.username);
        const isPrivate = list ? list.private : input.private;
        if (isPrivate && input.assignee !== null) {
          throw new TaskError(400, 'private_assignee', 'Личное дело нельзя поручить другому человеку.');
        }
        const now = isoNow(clock);
        const task: StoredTask = {
          id: newId(),
          owner: viewer.username,
          ownerName: viewer.displayName,
          assigneeName: input.assignee === null ? null : assigneeName,
          createdAt: now,
          updatedAt: now,
          title: input.title,
          note: input.note,
          due: input.due,
          dueTime: input.dueTime,
          repeat: input.repeat,
          repeatFrom: input.repeat === 'none' ? null : input.due,
          assignee: input.assignee,
          remindBefore: input.remindBefore,
          remindedFor: null,
          private: isPrivate,
          listId: input.listId,
          done: false,
          doneAt: null,
          doneBy: null,
          doneByName: null,
          lastDoneAt: null,
          lastDoneBy: null,
          lastDoneByName: null,
          undo: null,
        };
        await write({ ...data, tasks: [...data.tasks, task] });
        return taskView(task, lists, viewer);
      });
    },

    /** Several items of one list at once (a shopping trip): all or none. */
    createMany(viewer: Writer, listId: string, titles: readonly string[]): Promise<TaskView[]> {
      return queue.run(async () => {
        const data = await read();
        const lists = listsById(data.lists);
        const list = lists.get(listId);
        if (!list || !listVisible(list, viewer)) throw notFoundList();
        checkRoom(data, viewer, titles.length);
        const now = isoNow(clock);
        const made: StoredTask[] = titles.map((title) => ({
          id: newId(),
          owner: viewer.username,
          ownerName: viewer.displayName,
          assigneeName: null,
          createdAt: now,
          updatedAt: now,
          title,
          note: '',
          due: null,
          dueTime: null,
          repeat: 'none',
          repeatFrom: null,
          assignee: null,
          remindBefore: null,
          remindedFor: null,
          private: list.private,
          listId: list.id,
          done: false,
          doneAt: null,
          doneBy: null,
          doneByName: null,
          lastDoneAt: null,
          lastDoneBy: null,
          lastDoneByName: null,
          undo: null,
        }));
        await write({ ...data, tasks: [...data.tasks, ...made] });
        return made.map((task) => taskView(task, lists, viewer));
      });
    },

    update(viewer: Writer, id: string, input: TaskInput, assigneeName: string | null): Promise<TaskView> {
      return queue.run(async () => {
        const data = await read();
        const lists = listsById(data.lists);
        const index = data.tasks.findIndex((task) => task.id === id);
        const existing = data.tasks[index];
        if (!existing || !taskVisible(existing, lists, viewer)) throw notFoundTask();
        if (!mayChange(existing, viewer)) {
          throw new TaskError(
            403,
            'forbidden',
            'Изменить дело может только тот, кто его добавил, или администратор.',
          );
        }
        const list = placeIn(lists, input.listId, viewer, existing.owner);
        // Only the author decides who sees a task; an administrator changing it keeps it as it was.
        const isPrivate = list ? list.private : existing.owner === viewer.username ? input.private : existing.private;
        if (isPrivate && input.assignee !== null) {
          throw new TaskError(400, 'private_assignee', 'Личное дело нельзя поручить другому человеку.');
        }
        const repeating = input.repeat !== 'none' && input.due !== null;
        const sameSchedule = existing.repeat === input.repeat && existing.due === input.due;
        const now = isoNow(clock);
        const updated: StoredTask = {
          ...existing,
          title: input.title,
          note: input.note,
          due: input.due,
          dueTime: input.dueTime,
          repeat: input.repeat,
          repeatFrom: !repeating ? null : sameSchedule ? (existing.repeatFrom ?? input.due) : input.due,
          assignee: input.assignee,
          assigneeName: input.assignee === null ? null : assigneeName,
          remindBefore: input.remindBefore,
          // Another person has to hear about it again.
          remindedFor: existing.assignee === input.assignee ? existing.remindedFor : null,
          private: isPrivate,
          listId: input.listId,
          updatedAt: now,
          undo: null,
          // A repeating task is never «done»: it is open again for its next time.
          ...(repeating ? { done: false, doneAt: null, doneBy: null, doneByName: null } : {}),
        };
        const next = data.tasks.slice();
        next[index] = updated;
        await write({ ...data, tasks: next });
        return taskView(updated, lists, viewer);
      });
    },

    /**
     * Ticks or unticks a task. A repeating task is ticked by moving it to its next date (the person who
     * saw the old date sends it as `occurrence`: if somebody was faster, nothing happens twice);
     * «unticking» it takes the last tick back.
     */
    setDone(viewer: Writer, id: string, done: boolean, occurrence?: string | null): Promise<TaskView> {
      return queue.run(async () => {
        const data = await read();
        const lists = listsById(data.lists);
        const index = data.tasks.findIndex((task) => task.id === id);
        const existing = data.tasks[index];
        if (!existing || !taskVisible(existing, lists, viewer)) throw notFoundTask();
        const unchanged = () => taskView(existing, lists, viewer);
        const now = isoNow(clock);
        let updated: StoredTask;
        if (existing.repeat !== 'none' && existing.due !== null) {
          if (done) {
            if (occurrence !== undefined && occurrence !== null && occurrence !== existing.due) return unchanged();
            const today = localMoment(clock()).day;
            const next = nextOccurrence(
              existing.repeatFrom ?? existing.due,
              existing.repeat,
              existing.due > today ? existing.due : today,
            );
            const memo = {
              due: existing.due,
              lastDoneAt: existing.lastDoneAt,
              lastDoneBy: existing.lastDoneBy,
              lastDoneByName: existing.lastDoneByName,
            };
            updated =
              next === null
                ? // No next time within the years the portal knows: the task simply ends.
                  {
                    ...existing,
                    repeat: 'none',
                    repeatFrom: null,
                    done: true,
                    doneAt: now,
                    doneBy: viewer.username,
                    doneByName: viewer.displayName,
                    undo: null,
                    updatedAt: now,
                  }
                : {
                    ...existing,
                    due: next,
                    lastDoneAt: now,
                    lastDoneBy: viewer.username,
                    lastDoneByName: viewer.displayName,
                    undo: memo,
                    updatedAt: now,
                  };
          } else if (existing.undo) {
            updated = {
              ...existing,
              due: existing.undo.due,
              lastDoneAt: existing.undo.lastDoneAt,
              lastDoneBy: existing.undo.lastDoneBy,
              lastDoneByName: existing.undo.lastDoneByName,
              undo: null,
              updatedAt: now,
            };
          } else {
            return unchanged();
          }
        } else if (done === existing.done) {
          return unchanged();
        } else {
          updated = done
            ? { ...existing, done: true, doneAt: now, doneBy: viewer.username, doneByName: viewer.displayName, updatedAt: now }
            : { ...existing, done: false, doneAt: null, doneBy: null, doneByName: null, updatedAt: now };
        }
        const next = data.tasks.slice();
        next[index] = updated;
        await write({ ...data, tasks: next });
        return taskView(updated, lists, viewer);
      });
    },

    remove(viewer: Viewer, id: string): Promise<void> {
      return queue.run(async () => {
        const data = await read();
        const lists = listsById(data.lists);
        const existing = data.tasks.find((task) => task.id === id);
        if (!existing || !taskVisible(existing, lists, viewer)) throw notFoundTask();
        if (!mayChange(existing, viewer)) {
          throw new TaskError(
            403,
            'forbidden',
            'Удалить дело может только тот, кто его добавил, или администратор.',
          );
        }
        await write({ ...data, tasks: data.tasks.filter((task) => task.id !== id) });
      });
    },

    createList(viewer: Writer, input: TaskListInput): Promise<TaskListView> {
      return queue.run(async () => {
        const data = await read();
        if (data.lists.length >= MAX_LISTS) {
          throw new TaskError(409, 'too_many', 'Списков слишком много. Удалите ненужные.');
        }
        if (data.lists.filter((list) => list.owner === viewer.username).length >= MAX_LISTS_PER_USER) {
          throw new TaskError(
            409,
            'too_many_own',
            `У вас уже ${MAX_LISTS_PER_USER} списков. Удалите ненужные, чтобы добавить новый.`,
          );
        }
        assertFreeName(data.lists, viewer, input.name, input.private, null);
        const list: StoredList = {
          id: newId(),
          name: input.name,
          kind: input.kind,
          private: input.private,
          owner: viewer.username,
          ownerName: viewer.displayName,
          createdAt: isoNow(clock),
        };
        await write({ ...data, lists: [...data.lists, list] });
        return listView(list, viewer);
      });
    },

    renameList(viewer: Viewer, id: string, name: string): Promise<TaskListView> {
      return queue.run(async () => {
        const data = await read();
        const index = data.lists.findIndex((list) => list.id === id);
        const existing = data.lists[index];
        if (!existing || !listVisible(existing, viewer)) throw notFoundList();
        if (!mayChange(existing, viewer)) {
          throw new TaskError(
            403,
            'forbidden',
            'Переименовать список может только тот, кто его создал, или администратор.',
          );
        }
        const clean = checkListInput({ name, kind: existing.kind, private: existing.private }).name;
        assertFreeName(data.lists, viewer, clean, existing.private, existing.id);
        const updated = { ...existing, name: clean };
        const next = data.lists.slice();
        next[index] = updated;
        await write({ ...data, lists: next });
        return listView(updated, viewer);
      });
    },

    /** Deletes the list together with everything in it. */
    removeList(viewer: Viewer, id: string): Promise<{ removedTasks: number }> {
      return queue.run(async () => {
        const data = await read();
        const existing = data.lists.find((list) => list.id === id);
        if (!existing || !listVisible(existing, viewer)) throw notFoundList();
        if (!mayChange(existing, viewer)) {
          throw new TaskError(
            403,
            'forbidden',
            'Удалить список может только тот, кто его создал, или администратор.',
          );
        }
        const kept = data.tasks.filter((task) => task.listId !== id);
        await write({ tasks: kept, lists: data.lists.filter((list) => list.id !== id) });
        return { removedTasks: data.tasks.length - kept.length };
      });
    },

    /**
     * Removes the ticked items of a list (listId null — of the tasks that are in no list). Everybody
     * removes the items they added; the author of the list and administrators remove all of them.
     */
    clearDone(viewer: Viewer, listId: string | null): Promise<ClearDoneResponse> {
      return queue.run(async () => {
        const data = await read();
        const lists = listsById(data.lists);
        const list = listId === null ? null : (lists.get(listId) ?? null);
        if (listId !== null && (!list || !listVisible(list, viewer))) throw notFoundList();
        const scope = data.tasks.filter(
          (task) => task.done && task.listId === listId && taskVisible(task, lists, viewer),
        );
        const mayRemove = (task: StoredTask) =>
          viewer.isAdmin || task.owner === viewer.username || (list !== null && list.owner === viewer.username);
        const doomed = new Set(scope.filter(mayRemove).map((task) => task.id));
        if (doomed.size > 0) await write({ ...data, tasks: data.tasks.filter((task) => !doomed.has(task.id)) });
        return { removed: doomed.size, kept: scope.length - doomed.size };
      });
    },

    /**
     * Titles this person may see that contain the words of `query` (for the portal-wide search). Open
     * tasks come first, nearest due date first. Never returns a task the person could not open.
     */
    async searchTasks(viewer: Viewer, query: string, limit = 5): Promise<TaskSearchHit[]> {
      const needed = words(query);
      if (needed.length === 0) return [];
      const data = await read();
      const lists = listsById(data.lists);
      const hits = data.tasks.filter((task) => {
        if (!taskVisible(task, lists, viewer)) return false;
        const text = normalise(`${task.title} ${task.note}`);
        return needed.every((word) => text.includes(word));
      });
      hits.sort(
        (a, b) =>
          Number(a.done) - Number(b.done) ||
          (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
          a.title.localeCompare(b.title, 'ru'),
      );
      return hits.slice(0, Math.min(Math.max(Math.trunc(limit), 1), 50)).map((task) => ({
        id: task.id,
        title: task.title,
        done: task.done,
        due: task.due,
        listName: task.listId === null ? null : (lists.get(task.listId)?.name ?? null),
      }));
    },

    /**
     * Reminders that are due at `now`. Each one is written into its task BEFORE it is handed out, so it
     * can be told once only: not twice by the next minute, not again after a restart.
     */
    dueReminders(now: Date): Promise<ReminderJob[]> {
      return queue.run(async () => {
        const data = await read();
        const jobs: ReminderJob[] = [];
        const tasks = data.tasks.map((task) => {
          if (task.done || task.due === null) return task;
          const window = reminderWindow(task);
          if (!window || task.remindedFor === window.key) return task;
          if (now < window.fireAt || now > window.until) return task;
          jobs.push({
            taskId: task.id,
            key: window.key,
            title: task.title,
            due: task.due,
            dueTime: task.dueTime,
            owner: task.owner,
            ownerName: task.ownerName,
            assignee: task.assignee,
            private: task.private,
          });
          return { ...task, remindedFor: window.key };
        });
        if (jobs.length > 0) await write({ ...data, tasks });
        return jobs;
      });
    },

    /**
     * The account was removed: its private tasks and lists are deleted; its shared ones stay for the
     * family but no longer belong to that login, so a person who gets the same login later does not
     * inherit them. Whatever was given to the removed person becomes «nobody's».
     */
    retireOwner(username: string): Promise<{ deleted: number; kept: number }> {
      return queue.run(async () => {
        const data = await read();
        const mineTasks = data.tasks.filter((task) => task.owner === username);
        const mineLists = data.lists.filter((list) => list.owner === username);
        const given = data.tasks.filter((task) => task.owner !== username && task.assignee === username);
        if (mineTasks.length === 0 && mineLists.length === 0 && given.length === 0) {
          return { deleted: 0, kept: 0 };
        }
        const tasks = data.tasks
          .filter((task) => !(task.owner === username && task.private))
          .map((task) => {
            const base =
              task.assignee === username ? { ...task, assignee: null, assigneeName: null, remindedFor: null } : task;
            return base.owner === username ? { ...base, owner: REMOVED_OWNER } : base;
          });
        const lists = data.lists
          .filter((list) => !(list.owner === username && list.private))
          .map((list) => (list.owner === username ? { ...list, owner: REMOVED_OWNER } : list));
        await write({ tasks, lists });
        return {
          deleted: mineTasks.filter((task) => task.private).length + mineLists.filter((list) => list.private).length,
          kept: mineTasks.filter((task) => !task.private).length + mineLists.filter((list) => !list.private).length,
        };
      });
    },
  };
}

/** Two lists a person sees must not have the same name (the shared ones are one namespace, each person's private ones another). */
function assertFreeName(
  lists: readonly StoredList[],
  viewer: Viewer,
  name: string,
  isPrivate: boolean,
  exceptId: string | null,
): void {
  const same = normalise(name);
  const clash = lists.some(
    (list) =>
      list.id !== exceptId &&
      normalise(list.name) === same &&
      list.private === isPrivate &&
      (!isPrivate || list.owner === viewer.username),
  );
  if (clash) {
    throw new TaskError(
      409,
      'name_taken',
      isPrivate ? 'У вас уже есть личный список с таким названием.' : 'Общий список с таким названием уже есть.',
    );
  }
}

export type TaskStore = ReturnType<typeof createTasksStore>;

/**
 * The helper for the portal-wide search: titles of the tasks `viewer` may see that contain the words
 * of `query` (open ones first). A private task of another person is never among them, administrators
 * included.
 */
export function searchTasks(store: TaskStore, viewer: Viewer, query: string, limit = 5): Promise<TaskSearchHit[]> {
  return store.searchTasks(viewer, query, limit);
}
