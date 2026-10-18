import { Download, FolderOpen, Send, Sparkles, TriangleAlert } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type {
  DownloadCheckResponse,
  DownloadDestination,
  DownloadTaskView,
  OliviaAnswer,
  OliviaCard,
  OliviaStatusResponse,
} from '../../../shared/api.ts';
import { apiGet, apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { PosterCard } from '../cinema/Poster.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { formatBytes } from '../lib/format.ts';

interface Turn {
  id: number;
  from: 'me' | 'olivia';
  text: string;
  cards?: OliviaCard[];
  via?: OliviaAnswer['via'];
  note?: string | null;
}

const WELCOME =
  'Здравствуйте! Я Оливия, помощница семейного сервера. Могу найти фильм, фото или файл по названию, рассказать, сколько места на диске и что с резервной копией, показать загрузки и события календаря, объяснить, как пользоваться порталом, и подготовить загрузку по ссылке. Сама я ничего не удаляю и не скачиваю — важное делаете вы кнопкой.';

const SUGGESTIONS: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'Что ты умеешь?', text: 'Что ты умеешь?' },
  { label: 'Сколько места на диске?', text: 'Сколько места на диске?' },
  { label: 'Что с загрузками?', text: 'Что с моими загрузками?' },
  { label: 'Что сегодня в календаре?', text: 'Что у нас сегодня в календаре?' },
  { label: 'Как установить на телефон?', text: 'Как установить портал на телефон?' },
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
  }
}

export function OliviaPage() {
  const ids = useId();
  const [turns, setTurns] = useState<Turn[]>([{ id: 0, from: 'olivia', text: WELCOME }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<OliviaStatusResponse | null>(null);
  const next = useRef(1);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiGet<OliviaStatusResponse>('/api/olivia/status').then(setStatus, () => undefined);
  }, []);
  // Scrolls the conversation itself (not the page) to its last line, and again once posters have loaded and
  // changed the height.
  useEffect(() => {
    const toEnd = () => {
      const box = log.current;
      if (box) box.scrollTop = box.scrollHeight;
    };
    toEnd();
    const later = setTimeout(toEnd, 350);
    return () => clearTimeout(later);
  }, [turns.length, busy]);

  async function ask(message: string) {
    const question = message.trim();
    if (question === '' || busy) return;
    setText('');
    setTurns((current) => [...current, { id: next.current++, from: 'me', text: question }]);
    setBusy(true);
    try {
      const answer = await apiPost<OliviaAnswer>('/api/olivia/ask', { message: question });
      setTurns((current) => [
        ...current,
        {
          id: next.current++,
          from: 'olivia',
          text: answer.reply,
          cards: answer.cards,
          via: answer.via,
          note: answer.note,
        },
      ]);
    } catch (error) {
      const failure = toFailure(error);
      setTurns((current) => [
        ...current,
        {
          id: next.current++,
          from: 'olivia',
          text: failure.unreachable ? `${NO_CONNECTION}. Попробуйте чуть позже.` : failure.message,
        },
      ]);
    } finally {
      setBusy(false);
      field.current?.focus();
    }
  }

  return (
    <div class="page page--narrow">
      <PageHeader
        title="Оливия"
        icon={Sparkles}
        lead="Помощница семейного сервера. Видит только то, что можете видеть вы, и сама ничего не меняет."
      />
      {status ? (
        <p class={status.model.reachable ? 'meta' : 'banner banner--info'} role="status">
          {status.model.reachable ? (
            <Sparkles size={16} aria-hidden="true" />
          ) : (
            <TriangleAlert size={18} aria-hidden="true" />
          )}{' '}
          {status.model.message}
        </p>
      ) : null}
      <section class="olivia" aria-label="Разговор с Оливией">
        <div ref={log} class="olivia__log" role="log" aria-live="polite" aria-relevant="additions">
          {turns.map((turn) => (
            <div key={turn.id} class={turn.from === 'me' ? 'olivia-turn olivia-turn--me' : 'olivia-turn'}>
              <p class="olivia-turn__who">{turn.from === 'me' ? 'Вы' : 'Оливия'}</p>
              <p class="olivia-turn__text">{turn.text}</p>
              {turn.cards && turn.cards.length > 0 ? (
                <div class="olivia-turn__cards">
                  {turn.cards.map((card, index) => (
                    <Card key={index} card={card} />
                  ))}
                </div>
              ) : null}
              {turn.via === 'model' ? (
                <p class="meta">Вопрос разобрала локальная модель; ответ составлен по готовым данным.</p>
              ) : null}
              {turn.note ? (
                <p class="meta">Модель не помогла ({turn.note}) — поняла по готовым правилам.</p>
              ) : null}
            </div>
          ))}
          {busy ? (
            <p class="olivia-turn olivia-turn--wait" role="status">
              Оливия думает…
            </p>
          ) : null}
        </div>
        <fieldset class="chips chips--set">
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
          class="olivia__form"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(text);
          }}
        >
          <label class="visually-hidden" htmlFor={`${ids}-q`}>
            Вопрос Оливии
          </label>
          <input
            ref={field}
            id={`${ids}-q`}
            class="field__input olivia__input"
            type="text"
            maxLength={600}
            autoComplete="off"
            placeholder="Например: найди фильм про каникулы"
            value={text}
            onInput={(event) => setText(event.currentTarget.value)}
          />
          <button type="submit" class="button button--primary" disabled={busy || text.trim() === ''}>
            <Send size={20} aria-hidden="true" />
            Спросить
          </button>
        </form>
      </section>
    </div>
  );
}
