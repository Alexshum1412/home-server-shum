import {
  ArrowLeft,
  Download,
  FileText,
  FolderOpen,
  SendHorizontal,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type {
  DownloadCheckResponse,
  DownloadDestination,
  DownloadTaskView,
  OliviaAnswer,
  OliviaCard,
} from '../../../shared/api.ts';
import { apiGet, apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { PosterCard } from '../cinema/Poster.tsx';
import { formatBytes } from '../lib/format.ts';
import { navigate } from '../router.ts';

interface Turn {
  id: number;
  from: 'me' | 'olivia';
  text: string;
  streaming?: boolean;
  at?: string;
  cards?: OliviaCard[];
  via?: OliviaAnswer['via'];
  note?: string | null;
}

const WELCOME =
  'Здравствуйте! Я Оливия. Со мной можно просто поговорить: посоветую рецепт, объясню тему, помогу с домашним заданием и текстом, перескажу страницу, если пришлёте ссылку. Напишите «найди в интернете …» или «что в новостях» — посмотрю свежие данные. А ещё я знаю про сервер: найду фильм, фото или файл, покажу место на диске, загрузки и календарь, проверю ссылку для загрузки. Сама ничего не удаляю и не скачиваю — важное делаете вы кнопкой.';

const SUGGESTIONS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: 'Что приготовить на ужин?',
    text: 'Посоветуй, что приготовить на ужин из курицы и картошки, с рецептом',
  },
  { label: 'Что в новостях?', text: 'Что в новостях сегодня?' },
  {
    label: 'Помоги с уроками',
    text: 'Помоги решить задачу: у Пети 12 яблок, он отдал треть друзьям. Сколько осталось? Объясни по шагам',
  },
  { label: 'Найди в интернете…', text: 'Найди в интернете, как выбрать хороший телевизор' },
  { label: 'Сколько места на диске?', text: 'Сколько места на диске?' },
  { label: 'Что умеешь?', text: 'Что ты умеешь?' },
];
const STATE: Record<DownloadTaskView['state'], string> = {
  queued: 'в очереди',
  downloading: 'скачивается',
  paused: 'на паузе',
  completed: 'готово',
  failed: 'ошибка',
  canceled: 'отменено',
};

/** A download she prepared: the same check and the same button as in «Загрузки». Nothing starts without the click. */
function DownloadCheckCard(props: { first: DownloadCheckResponse }) {
  const [check, setCheck] = useState(props.first);
  const [destination, setDestination] = useState<DownloadDestination>('personal');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (check.status !== 'pending') return;
    const timer = setInterval(async () => {
      try {
        const next = await apiGet<DownloadCheckResponse>(`/api/downloads/check/${check.checkId}`);
        if (!alive.current) return;
        if (next.status !== 'pending') {
          clearInterval(timer);
          setCheck(next);
        }
      } catch {
        clearInterval(timer);
        if (alive.current) setMessage('Проверка не удалась. Повторите вопрос.');
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [check]);

  async function start() {
    setBusy(true);
    setMessage('');
    try {
      const task = await apiPost<DownloadTaskView>('/api/downloads', { checkId: check.checkId, destination });
      setDone(true);
      setMessage(`Добавлено в очередь. Готовые файлы: ${task.destinationLabel}.`);
    } catch (error) {
      const failure = toFailure(error);
      setMessage(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  const skipped = check.files.filter((file) => file.skipped).length;
  return (
    <div class="olivia-card olivia-card--check">
      {check.status === 'pending' ? <p>Узнаю, что внутри раздачи… (до минуты)</p> : null}
      {check.status === 'failed' ? <p class="download__error">{check.error}</p> : null}
      {check.status === 'ready' ? (
        <>
          <p class="olivia-card__title">{check.fileName}</p>
          <p class="meta">
            {check.willDownload
              ? `${formatBytes(check.willDownload.sizeBytes)}, файлов: ${check.willDownload.files}${skipped > 0 ? ` (программы и скрипты пропущены: ${skipped})` : ''}`
              : check.sizeBytes === null
                ? 'размер сайт не сообщает'
                : formatBytes(check.sizeBytes)}
            {check.kind === 'link' ? ` · ${check.host}` : ''}
          </p>
          {check.kind === 'torrent' && !done ? (
            <fieldset class="user-form__group">
              <legend class="field__label">Куда сохранить</legend>
              {check.destinations.map((option) => (
                <label key={option.id} class="check">
                  <input
                    type="radio"
                    name={`dest-${check.checkId}`}
                    checked={destination === option.id}
                    onChange={() => setDestination(option.id)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          ) : null}
          {!done ? (
            <button type="button" class="button button--primary" disabled={busy} onClick={() => void start()}>
              <Download size={18} aria-hidden="true" />
              Скачать
            </button>
          ) : null}
        </>
      ) : null}
      {message ? (
        <p class="action-message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function Card(props: { card: OliviaCard }) {
  const { card } = props;
  switch (card.kind) {
    case 'link':
      return (
        <a class="button button--secondary" href={card.href}>
          {card.label}
        </a>
      );
    case 'media':
      return (
        <div class="olivia-card olivia-card--poster">
          <PosterCard item={card.item} href={card.href} compact />
        </div>
      );
    case 'file':
      return (
        <a class="olivia-card olivia-card--file" href={card.href}>
          <FolderOpen size={20} aria-hidden="true" />
          <span class="olivia-card__text">
            <span class="olivia-card__title">{card.name}</span>
            <span class="meta">
              {card.where}
              {card.sizeBytes !== null ? ` · ${formatBytes(card.sizeBytes)}` : ''}
            </span>
          </span>
        </a>
      );
    case 'task':
      return (
        <a class="olivia-card olivia-card--file" href="/downloads">
          <Download size={20} aria-hidden="true" />
          <span class="olivia-card__text">
            <span class="olivia-card__title">{card.task.fileName}</span>
            <span class="meta">
              {STATE[card.task.state]}
              {card.task.sizeBytes
                ? ` · ${Math.min(100, Math.round((card.task.receivedBytes / card.task.sizeBytes) * 100))} %`
                : ''}
              {card.task.error ? ` · ${card.task.error}` : ''}
            </span>
          </span>
        </a>
      );
    case 'event':
      return (
        <p class="olivia-card olivia-card--event">
          <span class="meta">{card.when}</span>
          <span class="olivia-card__title">{card.title}</span>
        </p>
      );
    case 'download-check':
      return <DownloadCheckCard first={card.check} />;
    case 'report':
      return (
        <div class="olivia-card olivia-card--report">
          <a href={card.png} target="_blank" rel="noopener noreferrer">
            <img class="report__image" src={card.png} alt={card.title} loading="lazy" />
          </a>
          <a class="button button--secondary" href={card.pdf} download>
            <FileText size={18} aria-hidden="true" />
            Скачать документ (PDF)
          </a>
        </div>
      );
  }
}

interface ChatInfo {
  turns: Array<{ role: 'user' | 'assistant'; text: string; at?: string }>;
  models: { quick: boolean; smart: { available: boolean; running: boolean } };
  /** The question that is being answered right now (the page was left and opened again). */
  pending?: { text: string; at: string } | null;
}

type StreamEvent =
  | { t: 'status'; text: string }
  | { t: 'token'; text: string }
  | { t: 'answer'; answer: OliviaAnswer }
  | { t: 'end'; model: string; text: string }
  | { t: 'error'; message: string };

const clock = (date: Date) => date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** The conversation with Olivia, drawn exactly like a conversation with a person (same bubbles, same bar). */
export function OliviaThread(props: { onBack: () => void }) {
  const ids = useId();
  const [turns, setTurns] = useState<Turn[]>([
    { id: 0, from: 'olivia', text: WELCOME, at: clock(new Date()) },
  ]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState('');
  const [smart, setSmart] = useState(true);
  const [info, setInfo] = useState<ChatInfo | null>(null);
  const next = useRef(1);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  const touchOnly = useRef(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);

  // The talk is kept on the server: a person who left in the middle of an answer finds it here when they come back.
  // While the server is still writing, the question is shown with «печатает…» and the page asks again every 2 seconds.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (loaded: ChatInfo) => {
      setInfo(loaded);
      const list: Turn[] = [{ id: 0, from: 'olivia', text: WELCOME, at: '' }];
      for (const turn of loaded.turns) {
        list.push({
          id: next.current++,
          from: turn.role === 'user' ? 'me' : 'olivia',
          text: turn.text,
          at: turn.at ? clock(new Date(turn.at)) : '',
        });
      }
      if (loaded.pending) {
        list.push({
          id: next.current++,
          from: 'me',
          text: loaded.pending.text,
          at: clock(new Date(loaded.pending.at)),
        });
        list.push({ id: next.current++, from: 'olivia', text: '', streaming: true, at: '' });
      }
      setTurns(list);
      setBusy(loaded.pending != null);
      setWorking(loaded.pending ? 'печатает…' : '');
    };
    const load = () =>
      apiGet<ChatInfo>('/api/olivia/chat').then(
        (loaded) => {
          if (!alive) return;
          // While this page itself is receiving an answer, it is not redrawn from the server.
          if (!abort.current) show(loaded);
          if (loaded.pending) timer = setTimeout(load, 2000);
        },
        () => undefined,
      );
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  // Scrolls the conversation itself (not the page) to its last line while the text arrives.
  useEffect(() => {
    const box = log.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns, busy, working]);

  async function ask(message: string) {
    const question = message.trim();
    if (question === '' || busy) return;
    setText('');
    if (field.current) field.current.style.height = 'auto';
    const answerId = next.current + 1;
    next.current += 2;
    const now = clock(new Date());
    setTurns((current) => [
      ...current,
      { id: answerId - 1, from: 'me', text: question, at: now },
      { id: answerId, from: 'olivia', text: '', streaming: true, at: now },
    ]);
    setBusy(true);
    setWorking('печатает…');
    const controller = new AbortController();
    abort.current = controller;
    const patch = (change: Partial<Turn>) =>
      setTurns((current) => current.map((turn) => (turn.id === answerId ? { ...turn, ...change } : turn)));
    try {
      const response = await fetch('/api/olivia/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ message: question, smart }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        patch({ text: body.message ?? 'Не получилось ответить. Попробуйте ещё раз.', streaming: false });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let shown = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (line === '') continue;
          const event = JSON.parse(line) as StreamEvent;
          if (event.t === 'status') setWorking(event.text);
          else if (event.t === 'token') {
            shown += event.text;
            setWorking('');
            patch({ text: shown });
          } else if (event.t === 'answer')
            patch({
              text: event.answer.reply,
              cards: event.answer.cards,
              via: event.answer.via,
              note: event.answer.note,
              streaming: false,
            });
          else if (event.t === 'end') patch({ text: event.text, streaming: false });
          else if (event.t === 'error') patch({ text: event.message, streaming: false });
        }
      }
      patch({ streaming: false });
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') patch({ streaming: false });
      else {
        const failure = toFailure(error);
        patch({
          text: failure.unreachable ? `${NO_CONNECTION}. Попробуйте чуть позже.` : failure.message,
          streaming: false,
        });
      }
    } finally {
      setBusy(false);
      setWorking('');
      abort.current = null;
      field.current?.focus();
    }
  }

  async function clear() {
    if (!window.confirm('Начать разговор заново? Оливия забудет прежние сообщения.')) return;
    try {
      await apiPost('/api/olivia/chat/clear', {});
    } catch {
      // the screen is cleared anyway
    }
    setTurns([{ id: 0, from: 'olivia', text: WELCOME, at: '' }]);
  }

  const grow = (element: HTMLTextAreaElement) => {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  };

  return (
    <section class="thread thread--olivia" aria-label="Чат: Оливия">
      <header class="thread__head">
        <button type="button" class="button button--quiet thread__back" onClick={props.onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
          <span class="visually-hidden">К списку чатов</span>
        </button>
        <span class="avatar avatar--olivia" aria-hidden="true">
          <Sparkles size={20} />
        </span>
        <div class="thread__title">
          <h2 class="thread__name">Оливия</h2>
          <p class="thread__members" role="status">
            {busy ? (working !== '' ? working : 'печатает…') : 'помощница семьи · на домашнем компьютере'}
          </p>
        </div>
        <div class="thread__actions">
          {info?.models.smart.available ? (
            <label
              class="thread__smart"
              title="Умный режим: большая модель отвечает лучше и подробнее, но медленнее"
            >
              <input
                type="checkbox"
                checked={smart}
                disabled={busy}
                onChange={(event) => setSmart(event.currentTarget.checked)}
              />
              <span>Умный режим</span>
            </label>
          ) : null}
          <button type="button" class="button button--quiet" disabled={busy} onClick={() => void clear()}>
            <Trash2 size={20} aria-hidden="true" />
            <span class="thread__action-text">Начать заново</span>
          </button>
        </div>
      </header>

      <div
        ref={log}
        class="thread__scroll"
        role="log"
        aria-label="Разговор с Оливией"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable from the keyboard
        tabIndex={0}
        aria-live="polite"
        aria-relevant="additions"
      >
        <ol class="msgs" aria-label="Сообщения">
          {turns.map((turn, index) => {
            const previous = turns[index - 1];
            const grouped = !!previous && previous.from === turn.from;
            const mine = turn.from === 'me';
            return (
              <li key={turn.id} class="msgs__item olivia-turn">
                <div class={`msg${mine ? ' msg--mine' : ''}${grouped ? ' msg--grouped' : ''}`}>
                  <div class="msg__bubble">
                    <p class="msg__text">
                      {turn.text}
                      {turn.streaming && turn.text === '' ? (
                        <span class="typing" aria-label="Оливия печатает">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : null}
                    </p>
                    {turn.cards && turn.cards.length > 0 ? (
                      <div class="olivia-turn__cards">
                        {turn.cards.map((card, cardIndex) => (
                          <Card key={cardIndex} card={card} />
                        ))}
                      </div>
                    ) : null}
                    {turn.via === 'model' ? (
                      <p class="msg__note">
                        Вопрос разобрала локальная модель; ответ составлен по готовым данным.
                      </p>
                    ) : null}
                    {turn.note ? (
                      <p class="msg__note">Модель не помогла ({turn.note}) — поняла по готовым правилам.</p>
                    ) : null}
                    {turn.at ? (
                      <p class="msg__meta">
                        <time>{turn.at}</time>
                        {mine ? <span class="msg__ticks">✓✓</span> : null}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <fieldset class="chips chips--set chips--bar">
        <legend class="visually-hidden">Подсказки</legend>
        {SUGGESTIONS.map((item) => (
          <button
            key={item.label}
            type="button"
            class="chip"
            disabled={busy}
            onClick={() => void ask(item.text)}
          >
            {item.label}
          </button>
        ))}
      </fieldset>
      <form
        class="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(text);
        }}
      >
        <label class="visually-hidden" htmlFor={`${ids}-q`}>
          Сообщение Оливии
        </label>
        <textarea
          ref={field}
          id={`${ids}-q`}
          class="field__input composer__input"
          rows={1}
          maxLength={2000}
          placeholder="Сообщение"
          value={text}
          onInput={(event) => {
            setText(event.currentTarget.value);
            grow(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !touchOnly.current && !event.isComposing) {
              event.preventDefault();
              void ask(text);
            }
          }}
        />
        {busy ? (
          <button
            type="button"
            class="button button--primary composer__send"
            onClick={() => {
              void apiPost('/api/olivia/chat/stop', {}).catch(() => undefined);
              abort.current?.abort();
            }}
          >
            <Square size={20} aria-hidden="true" />
            <span class="visually-hidden">Стоп</span>
          </button>
        ) : (
          <button type="submit" class="button button--primary composer__send" disabled={text.trim() === ''}>
            <SendHorizontal size={22} aria-hidden="true" />
            <span class="visually-hidden">Отправить</span>
          </button>
        )}
      </form>
    </section>
  );
}

/** The old address: Olivia lives in «Чат» now. */
export function OliviaPage() {
  useEffect(() => navigate('/chat?c=olivia', { replace: true }), []);
  return null;
}
