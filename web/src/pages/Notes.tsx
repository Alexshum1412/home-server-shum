import { ArrowLeft, FolderOpen, NotebookPen, Plus, Save, Trash2 } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type {
  NoteResponse,
  NotesResponse,
  SaveNoteRequest,
  SaveNoteResponse,
  StorageSpace,
} from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { useBeforeUnload } from '../hooks/useBeforeUnload.ts';
import { useResource } from '../hooks/useResource.ts';
import { readParam, withQuery } from '../lib/query.ts';
import { navigate, useLocation } from '../router.ts';

const SPACES: ReadonlyArray<{ id: StorageSpace; label: string; lead: string }> = [
  { id: 'shared', label: 'Общие', lead: 'Видит вся семья: списки покупок, расписания, дела по дому.' },
  { id: 'personal', label: 'Мои', lead: 'Видите только вы.' },
];
/** Not a valid note title (a colon is forbidden), so it can never clash with a real note. */
const NEW = ':new';

const address = (space: StorageSpace, note: string | null) =>
  withQuery('/notes', { space: space === 'personal' ? 'personal' : '', note: note ?? '' });

/** One note: its title is the file name, its text the file content. */
function Editor(props: {
  space: StorageSpace;
  name: string | null;
  onBack: () => void;
  onSaved: (name: string, message: string) => void;
  onDeleted: (message: string) => void;
}) {
  const ids = useId();
  const isNew = props.name === null;
  const loaded = useResource<NoteResponse>(
    isNew ? null : `/api/notes/read?${new URLSearchParams({ space: props.space, name: props.name ?? '' })}`,
  );
  const [title, setTitle] = useState(props.name ?? '');
  const [text, setText] = useState('');
  const [revision, setRevision] = useState<string | null>(null);
  const [synced, setSynced] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Once the note arrived, its text and version are taken over (and never again on a quiet reload).
  useEffect(() => {
    if (loaded.data && synced !== loaded.data.revision && revision === null) {
      setText(loaded.data.text);
      setRevision(loaded.data.revision);
      setSynced(loaded.data.revision);
    }
  }, [loaded.data, revision, synced]);
  useEffect(() => {
    (isNew ? titleRef : textRef).current?.focus();
  }, [isNew]);

  const original = isNew ? '' : (loaded.data?.text ?? '');
  const dirty = isNew ? text !== '' || title !== '' : loaded.data !== null && text !== original;
  useBeforeUnload(dirty);

  async function save() {
    if (busy) return;
    if (isNew && !title.trim()) {
      setError('Дайте заметке название.');
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body: SaveNoteRequest = {
        space: props.space,
        name: (props.name ?? title).trim(),
        text,
        revision,
      };
      const saved = await apiPost<SaveNoteResponse>('/api/notes/save', body);
      props.onSaved(saved.name, isNew ? 'Заметка создана.' : 'Заметка сохранена.');
      if (!isNew) {
        setRevision(saved.revision);
        loaded.reload();
      }
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (props.name === null || busy) return;
    if (!window.confirm(`Убрать заметку «${props.name}» в корзину? Вернуть её сможет администратор.`)) return;
    setBusy(true);
    try {
      await apiPost('/api/notes/delete', { space: props.space, name: props.name });
      props.onDeleted(`Заметка «${props.name}» перемещена в корзину.`);
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.unreachable ? NO_CONNECTION : failure.message);
      setBusy(false);
    }
  }

  if (!isNew && loaded.error && !loaded.data) {
    return <ErrorState failure={loaded.error} onRetry={loaded.reload} busy={loaded.loading} level={3} />;
  }
  if (!isNew && !loaded.data) return <Loading label="Открываем заметку…" />;

  return (
    <section class="page-section" aria-label="Заметка">
      <div class="action-row">
        <button type="button" class="button button--quiet" onClick={props.onBack}>
          <ArrowLeft size={18} aria-hidden="true" />К списку заметок
        </button>
      </div>
      {isNew ? (
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-title`}>
            Название
          </label>
          <input
            ref={titleRef}
            id={`${ids}-title`}
            class="field__input"
            maxLength={100}
            value={title}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </div>
      ) : (
        <h2 class="section-title">{props.name}</h2>
      )}
      <div class="field">
        <label class="field__label" htmlFor={`${ids}-text`}>
          Текст
        </label>
        <textarea
          ref={textRef}
          id={`${ids}-text`}
          class="field__input notes__text"
          rows={14}
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </div>
      {error ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div class="action-row">
        <button
          type="button"
          class="button button--primary"
          disabled={busy || (!isNew && !dirty)}
          onClick={() => void save()}
        >
          <Save size={20} aria-hidden="true" />
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
        {!isNew ? (
          <button type="button" class="button button--quiet" disabled={busy} onClick={() => void remove()}>
            <Trash2 size={18} aria-hidden="true" />В корзину
          </button>
        ) : null}
      </div>
      {dirty ? <p class="meta">Есть несохранённые изменения.</p> : null}
    </section>
  );
}

export function NotesPage() {
  const { search } = useLocation();
  const space: StorageSpace = readParam(search, 'space') === 'personal' ? 'personal' : 'shared';
  const noteParam = readParam(search, 'note');
  const toast = useToast();
  const list = useResource<NotesResponse>(`/api/notes?space=${space}`);
  const current = SPACES.find((s) => s.id === space) ?? SPACES[0];
  const opened = noteParam === '' ? undefined : noteParam;

  let content = null;
  if (opened !== undefined) {
    content = (
      <Editor
        key={`${space}/${opened}`}
        space={space}
        name={opened === NEW ? null : opened}
        onBack={() => navigate(address(space, null))}
        onSaved={(name, message) => {
          toast.showOk(message);
          list.reload();
          if (opened === NEW) navigate(address(space, name), { replace: true });
        }}
        onDeleted={(message) => {
          toast.showOk(message);
          list.reload();
          navigate(address(space, null), { replace: true });
        }}
      />
    );
  } else if (list.error && !list.data) {
    content = <ErrorState failure={list.error} onRetry={list.reload} busy={list.loading} level={3} />;
  } else if (list.data) {
    content =
      list.data.notes.length === 0 ? (
        <p class="section-lead">Заметок пока нет. Нажмите «Новая заметка».</p>
      ) : (
        <ul class="files">
          {list.data.notes.map((note) => (
            <li key={note.name} class="files__item">
              <a class="files__name" href={address(space, note.name)}>
                <NotebookPen size={20} aria-hidden="true" />
                <span>{note.name}</span>
              </a>
              <p class="meta files__meta">
                <RelativeTime value={note.modifiedAt} />
                {note.preview ? ` · ${note.preview}` : ''}
              </p>
            </li>
          ))}
        </ul>
      );
  } else {
    content = <Loading label="Загружаем заметки…" />;
  }

  return (
    <div class="page">
      <PageHeader
        title="Заметки"
        icon={NotebookPen}
        lead="Короткие тексты для всей семьи или только для вас: списки, расписания, напоминания."
      />
      <fieldset class="segmented">
        <legend class="visually-hidden">Чьи заметки</legend>
        {SPACES.map((s) => (
          <button
            key={s.id}
            type="button"
            class="segmented__item"
            aria-pressed={space === s.id}
            onClick={() => navigate(address(s.id, null), { replace: true })}
          >
            {s.label}
          </button>
        ))}
      </fieldset>
      <p class="section-lead">{current?.lead}</p>
      {opened === undefined ? (
        <div class="action-row">
          <button type="button" class="button button--primary" onClick={() => navigate(address(space, NEW))}>
            <Plus size={20} aria-hidden="true" />
            Новая заметка
          </button>
        </div>
      ) : null}
      {content}
      <p class="meta">
        <FolderOpen size={16} aria-hidden="true" /> Заметки хранятся обычными текстовыми файлами в папке
        «Заметки» (раздел «Файлы» → «{space === 'shared' ? 'Общее' : 'Личное'}»). Если страница заметок не
        открывается, их можно найти там — или в папке на домашнем компьютере.
      </p>
      <ToastRegion toast={toast} />
    </div>
  );
}
