import { Newspaper, RefreshCw } from 'lucide-preact';
import { useId, useState } from 'preact/hooks';
import type { DigestResponse } from '../../../shared/extras.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatDateTime } from '../lib/format.ts';

/** The digest as cards: the first block is the greeting, every other block has a heading line and bullet lines. */
function DigestView(props: { text: string }) {
  const blocks = props.text.split(/\n{2,}/).filter((block) => block.trim() !== '');
  return (
    <div class="digest">
      {blocks.map((block, index) => {
        const lines = block.split('\n');
        const isSection = lines.length > 1 && (lines[1] ?? '').startsWith('•');
        return isSection ? (
          <section key={index} class="digest__card">
            <h3 class="digest__title">{lines[0]}</h3>
            <ul class="digest__list">
              {lines.slice(1).map((line, i) => (
                <li key={i}>{line.replace(/^•\s*/, '')}</li>
              ))}
            </ul>
          </section>
        ) : (
          <p key={index} class="digest__plain">
            {block}
          </p>
        );
      })}
    </div>
  );
}

interface GuestRow {
  chatId: string;
  name: string;
  username: string;
  note: string;
  joinedAt: string;
  lastAt: string;
  subscribed: boolean;
  topics: string[];
  city: string;
  blocked: boolean;
  chat: boolean;
  total: number;
}

/** For the administrator: people from outside the family in the bot. A stranger gets the digest only; the rest is given here. */
function GuestsSection(props: {
  run: <T>(job: () => Promise<T>, ok: string) => Promise<void>;
  busy: boolean;
}) {
  const ids = useId();
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState('');
  const data = useResource<{ guests: GuestRow[] }>(
    `/api/admin/guests${asked ? `?q=${encodeURIComponent(asked)}` : ''}`,
  );
  const list = data.data?.guests ?? [];
  const act = async (path: string, body: object, ok: string) => {
    await props.run(() => apiPost(path, body), ok);
    data.reload();
  };
  return (
    <section class="page-section" aria-labelledby={`${ids}-g`}>
      <h2 id={`${ids}-g`} class="section-title">
        Люди не из семьи (Telegram-бот)
      </h2>
      <p class="meta">
        Любой, кто напишет боту, получает только утренний дайджест: подписка, выбор тем и города. Всё
        остальное — разговор с Оливией — вы разрешаете сами, когда узнаете человека. Подписчиков:{' '}
        {list.filter((g) => g.subscribed).length}, всего: {list.length}. Выключить совсем: «Администрирование»
        → «Функции» → «Бот для людей не из семьи».
      </p>
      <form
        class="action-row"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked(q.trim());
        }}
      >
        <label class="visually-hidden" htmlFor={`${ids}-q`}>
          Поиск по людям: имя, @имя, город, заметка
        </label>
        <input
          id={`${ids}-q`}
          class="field__input"
          placeholder="Найти: имя, @имя в Telegram, город, заметка"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <button type="submit" class="button button--secondary">
          Найти
        </button>
      </form>
      {list.length === 0 ? (
        <p class="section-lead">{asked ? 'Никого не нашлось.' : 'Пока никто не писал.'}</p>
      ) : null}
      <ul class="guests">
        {list.map((g) => (
          <li key={g.chatId} class="guests__item">
            <p>
              <strong>{g.name || 'без имени'}</strong>
              {g.username ? <span class="meta"> @{g.username}</span> : null}{' '}
              <span class="meta">
                · {g.subscribed ? 'подписан на дайджест' : 'не подписан'}
                {g.city ? ` · ${g.city}` : ''}
                {g.topics.length > 0 ? ` · темы: ${g.topics.join(', ')}` : ''}
                {g.blocked ? ' · остановлен' : ''}
              </span>
            </p>
            <p class="meta">
              Первое сообщение: {formatDateTime(g.joinedAt)}; последнее: {formatDateTime(g.lastAt)}; сообщений
              Оливии: {g.total}
            </p>
            <label class="check">
              <input
                type="checkbox"
                checked={g.chat}
                disabled={props.busy}
                onChange={(e) =>
                  void act(
                    '/api/admin/guests/update',
                    { chatId: g.chatId, chat: e.currentTarget.checked },
                    e.currentTarget.checked
                      ? 'Разговор с Оливией разрешён.'
                      : 'Разговор закрыт: только дайджест.',
                  )
                }
              />
              Разрешить разговор с Оливией (иначе — только дайджест)
            </label>
            <label class="visually-hidden" htmlFor={`${ids}-n-${g.chatId}`}>
              Заметка о человеке
            </label>
            <input
              id={`${ids}-n-${g.chatId}`}
              class="field__input"
              placeholder="Заметка: кто это (видите только вы)"
              defaultValue={g.note}
              maxLength={200}
              onChange={(e) =>
                void act(
                  '/api/admin/guests/update',
                  { chatId: g.chatId, note: e.currentTarget.value },
                  'Заметка сохранена.',
                )
              }
            />
            <div class="action-row">
              <button
                type="button"
                class="button button--quiet"
                disabled={props.busy}
                onClick={() =>
                  void act(
                    '/api/admin/guests/block',
                    { chatId: g.chatId, blocked: !g.blocked },
                    g.blocked ? 'Снова можно писать.' : 'Остановлен.',
                  )
                }
              >
                {g.blocked ? 'Вернуть' : 'Остановить'}
              </button>
              <button
                type="button"
                class="button button--quiet"
                disabled={props.busy}
                onClick={() => {
                  if (confirm('Убрать этого человека совсем? Он сможет написать заново.'))
                    void act('/api/admin/guests/remove', { chatId: g.chatId }, 'Убран.');
                }}
              >
                Убрать
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
/** «Утренний дайджест»: a short personal message every morning (portal, and Telegram if it is set up). */
export function DigestPage() {
  const ids = useId();
  const toast = useToast();
  const data = useResource<DigestResponse>('/api/digest');
  const [city, setCity] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run<T>(job: () => Promise<T>, ok: string) {
    setBusy(true);
    try {
      await job();
      toast.showOk(ok);
      data.reload();
    } catch (error) {
      const failure = toFailure(error);
      toast.showError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  const d = data.data;
  return (
    <div class="page">
      <PageHeader
        title="Утренний дайджест"
        icon={Newspaper}
        lead="Каждое утро — короткая сводка именно для вас: дела и события дня, ближайшие сроки, погода, курсы. Пишет её модель на этом компьютере; чужого она не видит."
      />
      {data.error && !d ? (
        <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />
      ) : null}
      {!d && !data.error ? <Loading label="Загружаем…" /> : null}
      {d ? (
        <>
          <section class="page-section" aria-labelledby={`${ids}-last`}>
            <h2 id={`${ids}-last`} class="section-title">
              Последний дайджест
            </h2>
            {d.mine.last ? (
              <>
                <p class="meta">
                  {formatDateTime(d.mine.last.at)} ·{' '}
                  {d.mine.last.how === 'model' ? 'написан моделью' : 'собран по шаблону (модель не ответила)'}
                </p>
                <DigestView text={d.mine.last.text} />
              </>
            ) : (
              <p class="section-lead">
                Пока не было. Нажмите «Сделать сейчас» или дождитесь утра ({d.settings.time}).
              </p>
            )}
            <div class="action-row">
              <button
                type="button"
                class="button button--primary"
                disabled={busy}
                onClick={() => void run(() => apiPost('/api/digest/mine/now', {}), 'Дайджест готов.')}
              >
                <RefreshCw size={18} aria-hidden="true" />
                Сделать сейчас
              </button>
            </div>
          </section>

          <section class="page-section" aria-labelledby={`${ids}-mine`}>
            <h2 id={`${ids}-mine`} class="section-title">
              Для меня
            </h2>
            <label class="check">
              <input
                type="checkbox"
                checked={d.mine.enabled}
                disabled={busy}
                onChange={(e) =>
                  void run(
                    () => apiPost('/api/digest/mine', { enabled: e.currentTarget.checked }),
                    e.currentTarget.checked ? 'Дайджест включён.' : 'Дайджест выключен.',
                  )
                }
              />
              Присылать мне дайджест каждое утро ({d.settings.time})
            </label>
            <p class="meta">
              Город, интересы и привязка Telegram — в разделе «Мой профиль» (вкладка «Профиль»). Бот присылает
              дайджест туда, куда вы его привязали.
            </p>
          </section>

          {d.isAdmin ? <GuestsSection run={run} busy={busy} /> : null}
          {d.isAdmin ? (
            <section class="page-section" aria-labelledby={`${ids}-adm`}>
              <h2 id={`${ids}-adm`} class="section-title">
                Для администратора
              </h2>
              <label class="check">
                <input
                  type="checkbox"
                  checked={d.settings.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    void run(
                      () => apiPost('/api/admin/digest/settings', { enabled: e.currentTarget.checked }),
                      'Сохранено.',
                    )
                  }
                />
                Рассылка включена
              </label>
              <label class="field__label" htmlFor={`${ids}-time`}>
                Время рассылки
              </label>
              <input
                id={`${ids}-time`}
                class="field__input"
                type="time"
                value={d.settings.time}
                disabled={busy}
                onChange={(e) =>
                  void run(
                    () => apiPost('/api/admin/digest/settings', { time: e.currentTarget.value }),
                    'Время сохранено.',
                  )
                }
              />
              <label class="field__label" htmlFor={`${ids}-city`}>
                Город для погоды {d.settings.city ? `(сейчас: ${d.settings.city})` : '(не задан)'}
              </label>
              <input
                id={`${ids}-city`}
                class="field__input"
                placeholder="Например: Минск"
                value={city ?? ''}
                onInput={(e) => setCity(e.currentTarget.value)}
              />
              <div class="action-row">
                <button
                  type="button"
                  class="button button--secondary"
                  disabled={busy || city === null}
                  onClick={() =>
                    void run(
                      () => apiPost('/api/admin/digest/settings', { city: city ?? '' }),
                      'Город сохранён.',
                    )
                  }
                >
                  Сохранить город
                </button>
              </div>
              <label class="check">
                <input
                  type="checkbox"
                  checked={d.settings.currency}
                  disabled={busy}
                  onChange={(e) =>
                    void run(
                      () => apiPost('/api/admin/digest/settings', { currency: e.currentTarget.checked }),
                      'Сохранено.',
                    )
                  }
                />
                Курсы валют (Нацбанк Беларуси)
              </label>
              <p class="meta">
                Ночью для рассылки запускается большая модель на несколько минут (около 4 ГБ памяти); днём
                «Сделать сейчас» использует быструю. Погода и курсы берутся из открытых источников; о семье
                туда ничего не уходит.
              </p>
              <div class="action-row">
                <button
                  type="button"
                  class="button button--secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => apiPost('/api/admin/digest/run', {}),
                      'Рассылка запущена: дайджесты появятся через несколько минут.',
                    )
                  }
                >
                  Разослать всем сейчас
                </button>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
      <ToastRegion toast={toast} />
    </div>
  );
}
