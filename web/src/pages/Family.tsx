import { Heart, Mic, Paperclip, RefreshCw, Square, Trash2 } from 'lucide-preact';
import { useId, useRef, useState } from 'preact/hooks';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatDateTime } from '../lib/format.ts';

interface Media {
  file: string;
  name: string;
  kind: 'audio' | 'video' | 'image';
  size: number;
  transcript?: string;
}
interface Entry {
  id: string;
  username: string;
  question: string;
  theme: string;
  text: string;
  media: Media[];
  at: string;
}
interface FamilyState {
  enabled: boolean;
  current: { question: { id: string; theme: string; text: string }; askedAt: string } | null;
  entries: Entry[];
  remaining: number;
  nextAt: string | null;
  total: number;
  themes: Record<string, string>;
  copies: { total: number; ok: number; lastAt: string | null; problems: string[] } | null;
  isAdmin: boolean;
}
interface Archive {
  people: Array<{
    username: string;
    entries: number;
    media: number;
    lastAt: string | null;
    enabled: boolean;
    waiting: boolean;
  }>;
  entries: Entry[];
  copies: { total: number; ok: number; lastAt: string | null; problems: string[] };
}

/** A raw upload of one file to an entry of the archive (the same rule as other uploads: PUT, octet-stream, X-Upload). */
async function putMedia(entry: string, blob: Blob, name: string): Promise<void> {
  const query = new URLSearchParams({ entry, name, size: String(blob.size) });
  const response = await fetch(`/api/family/media?${query.toString()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Upload': '1' },
    body: blob,
  });
  if (!response.ok) {
    let message = `Ошибка ${response.status}`;
    try {
      message = ((await response.json()) as { message?: string }).message ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
}

const mediaUrl = (entry: Entry, media: Media) => `/api/family/media/${entry.id}/${media.file}`;

function MediaView(props: { entry: Entry }) {
  return (
    <div class="family__media">
      {props.entry.media.map((media) =>
        media.kind === 'audio' ? (
          // biome-ignore lint/a11y/useMediaCaption: a family voice recording has no captions
          <audio key={media.file} controls preload="none" src={mediaUrl(props.entry, media)} />
        ) : media.kind === 'video' ? (
          // biome-ignore lint/a11y/useMediaCaption: a family video has no captions
          <video key={media.file} controls preload="none" src={mediaUrl(props.entry, media)} />
        ) : (
          <a key={media.file} href={mediaUrl(props.entry, media)} target="_blank" rel="noopener noreferrer">
            <img src={mediaUrl(props.entry, media)} alt={media.name} loading="lazy" />
          </a>
        ),
      )}
    </div>
  );
}

function EntryCard(props: { entry: Entry; onDelete?: () => void; who?: string }) {
  const { entry } = props;
  return (
    <article class="family__entry">
      <p class="meta">
        {props.who ? `${props.who} · ` : ''}
        {entry.theme} · {formatDateTime(entry.at)}
      </p>
      <h3 class="family__question">{entry.question}</h3>
      {entry.text ? <p class="family__text">{entry.text}</p> : null}
      <MediaView entry={entry} />
      {entry.media
        .filter((media) => media.transcript)
        .map((media) => (
          <p key={media.file} class="family__transcript">
            <span class="meta">Расшифровка записи: </span>
            {media.transcript}
          </p>
        ))}
      {props.onDelete ? (
        <button type="button" class="button button--quiet" onClick={props.onDelete}>
          <Trash2 size={16} aria-hidden="true" />
          Удалить
        </button>
      ) : null}
    </article>
  );
}

/** «Семейный архив»: Olivia's questions about life, the answers (words, voice, photos) kept for the family. */
export function FamilyPage() {
  const ids = useId();
  const toast = useToast();
  const data = useResource<FamilyState>('/api/family');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Array<{ blob: Blob; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const archive = useResource<Archive>(
    data.data?.isAdmin === true
      ? `/api/family/archive${who ? `?user=${encodeURIComponent(who)}` : ''}`
      : null,
  );

  async function run<T>(job: () => Promise<T>, ok: string) {
    setBusy(true);
    try {
      await job();
      if (ok) toast.showOk(ok);
      data.reload();
    } catch (error) {
      const failure = toFailure(error);
      toast.showError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';
      const rec = new MediaRecorder(stream, { mimeType: type });
      const chunks: Blob[] = [];
      rec.ondataavailable = (event) => chunks.push(event.data);
      rec.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        const blob = new Blob(chunks, { type });
        setFiles((list) => [
          ...list,
          { blob, name: `golos-${Date.now()}.${type === 'audio/mp4' ? 'm4a' : 'weba'}` },
        ]);
        setRecording(false);
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch {
      toast.showError(
        'Не получилось включить микрофон: разрешите доступ в браузере или загрузите запись файлом.',
      );
    }
  }

  const d = data.data;

  async function save() {
    await run(async () => {
      const entry = await apiPost<Entry>('/api/family/answer', { text });
      for (const file of files) await putMedia(entry.id, file.blob, file.name);
      setText('');
      setFiles([]);
    }, 'Ответ сохранён в семейном архиве.');
  }

  return (
    <div class="page">
      <PageHeader
        title="Семейный архив"
        icon={Heart}
        lead="Раз в несколько дней Оливия задаёт один вопрос — о жизни, о близких или о важном. Ответьте текстом, голосом или фото: так через годы останутся живые воспоминания."
      />
      {data.error && !d ? (
        <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />
      ) : null}
      {!d && !data.error ? <Loading label="Загружаем…" /> : null}
      {d ? (
        <>
          <p class="banner banner--info">
            Ваши ответы видите вы и администратор семьи; они хранятся на этом компьютере и копируются на
            другие диски. Наружу они не уходят.
          </p>
          <section class="page-section" aria-labelledby={`${ids}-q`}>
            <h2 id={`${ids}-q`} class="section-title">
              Вопрос для вас
            </h2>
            {d.current ? (
              <>
                <p class="family__ask">{d.current.question.text}</p>
                <p class="meta">
                  Тема: {d.themes[d.current.question.theme] ?? d.current.question.theme}. Не обязательно
                  отвечать сразу: можно вернуться позже.
                </p>
                <label class="field__label" htmlFor={`${ids}-text`}>
                  Ваш ответ
                </label>
                <textarea
                  id={`${ids}-text`}
                  class="field__input"
                  rows={6}
                  maxLength={20000}
                  value={text}
                  onInput={(e) => setText(e.currentTarget.value)}
                />
                <div class="action-row">
                  {recording ? (
                    <button
                      type="button"
                      class="button button--secondary"
                      onClick={() => recorder.current?.stop()}
                    >
                      <Square size={16} aria-hidden="true" />
                      Остановить запись
                    </button>
                  ) : (
                    <button
                      type="button"
                      class="button button--secondary"
                      disabled={busy}
                      onClick={() => void startRecording()}
                    >
                      <Mic size={16} aria-hidden="true" />
                      Записать голос
                    </button>
                  )}
                  <label class="button button--secondary">
                    <Paperclip size={16} aria-hidden="true" />
                    Добавить фото, видео, запись
                    <input
                      type="file"
                      class="visually-hidden"
                      multiple
                      accept="audio/*,video/*,image/*"
                      onChange={(e) =>
                        setFiles((list) => [
                          ...list,
                          ...Array.from(e.currentTarget.files ?? []).map((file) => ({
                            blob: file,
                            name: file.name,
                          })),
                        ])
                      }
                    />
                  </label>
                </div>
                {files.length > 0 ? (
                  <ul class="meta">
                    {files.map((file, index) => (
                      <li key={`${file.name}-${index}`}>
                        {file.name} ({Math.max(1, Math.round(file.blob.size / 1024))} КБ){' '}
                        <button
                          type="button"
                          class="button button--quiet"
                          onClick={() => setFiles((list) => list.filter((_, i) => i !== index))}
                        >
                          Убрать
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div class="action-row">
                  <button
                    type="button"
                    class="button button--primary"
                    disabled={busy || recording || (text.trim() === '' && files.length === 0)}
                    onClick={() => void save()}
                  >
                    Сохранить ответ
                  </button>
                  <button
                    type="button"
                    class="button button--quiet"
                    disabled={busy}
                    onClick={() =>
                      void run(() => apiPost('/api/family/ask', { another: true }), 'Другой вопрос готов.')
                    }
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    Другой вопрос
                  </button>
                  <button
                    type="button"
                    class="button button--quiet"
                    disabled={busy}
                    onClick={() =>
                      void run(() => apiPost('/api/family/skip', {}), 'Пропустили, спросим другое позже.')
                    }
                  >
                    Не сейчас
                  </button>
                </div>
              </>
            ) : (
              <>
                <p class="section-lead">
                  {d.enabled
                    ? d.remaining === 0
                      ? 'Все вопросы уже заданы — спасибо, что отвечали!'
                      : `Сейчас вопроса нет. Следующий придёт ${d.nextAt ? `около ${formatDateTime(d.nextAt)}` : 'в течение нескольких дней'} (уведомлением и в Telegram).`
                    : 'Вопросы выключены.'}
                </p>
                <div class="action-row">
                  <button
                    type="button"
                    class="button button--primary"
                    disabled={busy || !d.enabled || d.remaining === 0}
                    onClick={() => void run(() => apiPost('/api/family/ask', {}), '')}
                  >
                    Хочу вопрос сейчас
                  </button>
                </div>
              </>
            )}
            <label class="check">
              <input
                type="checkbox"
                checked={d.enabled}
                disabled={busy}
                onChange={(e) =>
                  void run(
                    () => apiPost('/api/family/settings', { enabled: e.currentTarget.checked }),
                    e.currentTarget.checked ? 'Вопросы включены.' : 'Вопросы выключены.',
                  )
                }
              />
              Оливия задаёт мне вопросы раз в 3–7 дней (осталось незаданных: {d.remaining} из {d.total})
            </label>
          </section>

          <section class="page-section" aria-labelledby={`${ids}-mine`}>
            <h2 id={`${ids}-mine`} class="section-title">
              Мои ответы ({d.entries.length})
            </h2>
            {d.entries.length === 0 ? (
              <p class="section-lead">Пока пусто — первый ответ станет началом.</p>
            ) : null}
            {d.entries.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                onDelete={() => {
                  if (confirm('Удалить этот ответ вместе с записями?'))
                    void run(() => apiPost(`/api/family/entries/${entry.id}/delete`, {}), 'Удалено.');
                }}
              />
            ))}
          </section>

          {d.isAdmin ? (
            <section class="page-section" aria-labelledby={`${ids}-adm`}>
              <h2 id={`${ids}-adm`} class="section-title">
                Архив семьи (для администратора)
              </h2>
              {archive.data ? (
                <>
                  <p class="meta">
                    Копии на других дисках: {archive.data.copies.ok} из {archive.data.copies.total}
                    {archive.data.copies.lastAt
                      ? `, обновлено ${formatDateTime(archive.data.copies.lastAt)}`
                      : ''}
                    .
                    {archive.data.copies.problems.length > 0
                      ? ` Не вышло: ${archive.data.copies.problems.join('; ')}`
                      : ''}
                  </p>
                  <div class="action-row">
                    <button
                      type="button"
                      class="button button--secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(() => apiPost('/api/family/copy', {}), 'Копии обновлены.').then(() =>
                          archive.reload(),
                        )
                      }
                    >
                      Скопировать на другие диски сейчас
                    </button>
                  </div>
                  <ul class="family__people">
                    {archive.data.people.map((p) => (
                      <li key={p.username}>
                        <button type="button" class="button button--quiet" onClick={() => setWho(p.username)}>
                          {p.username}
                        </button>{' '}
                        <span class="meta">
                          ответов: {p.entries}, записей: {p.media}
                          {p.waiting ? ', ждёт ответа на вопрос' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {archive.data.entries.map((entry) => (
                    <EntryCard key={entry.id} entry={entry} who={entry.username} />
                  ))}
                </>
              ) : (
                <Loading label="Загружаем архив…" />
              )}
            </section>
          ) : null}
        </>
      ) : null}
      <ToastRegion toast={toast} />
    </div>
  );
}
