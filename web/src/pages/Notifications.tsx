import { Bell, BellOff, BellRing, CircleCheck, Smartphone } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { NotificationKind, NotificationPrefs, NotificationsResponse } from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { useChat } from '../chat/ChatProvider.tsx';
import { dayLabel, formatClock } from '../chat/format.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { disablePush, enablePush, pushSupport, thisDeviceSubscription } from '../lib/push.ts';

const KIND_LABEL: Record<NotificationKind, string> = {
  message: 'Сообщение',
  call: 'Звонок',
  download: 'Загрузка',
  backup: 'Резервная копия',
  disk: 'Место на диске',
  service: 'Сервис',
  print: 'Печать',
  system: 'Сервер',
};

const PREF_LABEL: ReadonlyArray<{ key: keyof NotificationPrefs; label: string; hint: string }> = [
  { key: 'messages', label: 'Новые сообщения', hint: 'Когда вам пишут в чате.' },
  { key: 'calls', label: 'Звонки', hint: 'Входящие и пропущенные звонки.' },
  { key: 'downloads', label: 'Загрузки', hint: 'Когда загрузка закончилась или не удалась.' },
  { key: 'alerts', label: 'Проблемы сервера', hint: 'Мало места, сбой копирования, остановился сервис.' },
  { key: 'print', label: 'Печать', hint: 'Когда документ напечатан.' },
  {
    key: 'previews',
    label: 'Показывать текст сообщений',
    hint: 'Если выключить, в уведомлении будет только «Новое сообщение». Так надёжнее, если экран видят другие.',
  },
];

function failureText(error: unknown): string {
  const failure = toFailure(error);
  return failure.unreachable ? NO_CONNECTION : failure.message;
}

function DeviceBlock(props: {
  state: NotificationsResponse;
  onState: (state: NotificationsResponse) => void;
}) {
  const { state } = props;
  const support = pushSupport();
  const [here, setHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [permission, setPermission] = useState(
    typeof Notification === 'undefined' ? 'default' : Notification.permission,
  );

  useEffect(() => {
    let alive = true;
    void thisDeviceSubscription().then((subscription) => {
      if (alive) setHere(subscription !== null);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function turnOn() {
    if (!state.push.publicKey) return;
    setBusy(true);
    setMessage('');
    const result = await enablePush(state.push.publicKey);
    setBusy(false);
    setPermission(typeof Notification === 'undefined' ? 'default' : Notification.permission);
    if (result.ok) {
      props.onState(result.state);
      setHere(true);
      setMessage('Готово. Теперь уведомления придут на это устройство, даже когда портал закрыт.');
    } else {
      setMessage(result.reason);
    }
  }

  async function turnOff() {
    setBusy(true);
    setMessage('');
    try {
      const next = await disablePush();
      if (next) props.onState(next);
      setHere(false);
      setMessage('Уведомления на этом устройстве выключены.');
    } catch (error) {
      setMessage(failureText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="panel" aria-labelledby="push-title">
      <h2 id="push-title" class="section-title">
        <Smartphone class="section-title__icon" size={20} aria-hidden="true" />
        Это устройство
      </h2>
      {!state.push.available ? (
        <p class="section-lead">
          Сервер не смог подготовить ключи для уведомлений. Сообщите администратору: уведомления будут
          приходить только пока портал открыт.
        </p>
      ) : !support.ok ? (
        <p class="section-lead">{support.reason}</p>
      ) : here ? (
        <>
          <p class="section-lead">
            <CircleCheck size={18} aria-hidden="true" /> Уведомления включены. Устройств с уведомлениями у
            вас: {state.push.devices}.
          </p>
          <button
            type="button"
            class="button button--secondary"
            disabled={busy}
            onClick={() => void turnOff()}
          >
            <BellOff size={18} aria-hidden="true" />
            Выключить на этом устройстве
          </button>
        </>
      ) : (
        <>
          <p class="section-lead">
            Включите, чтобы узнавать о сообщениях и звонках, даже когда портал закрыт. Браузер спросит
            разрешение.
            {permission === 'denied'
              ? ' Сейчас уведомления для этого сайта запрещены в настройках браузера.'
              : ''}
          </p>
          <button
            type="button"
            class="button button--primary"
            disabled={busy || here === null}
            onClick={() => void turnOn()}
          >
            <BellRing size={18} aria-hidden="true" />
            {busy ? 'Включаем…' : 'Включить уведомления'}
          </button>
        </>
      )}
      {message ? (
        <p class="action-message" role="status">
          {message}
        </p>
      ) : null}
      <p class="field__hint">
        Уведомления приходят через службу вашего браузера (Google, Apple или Mozilla). Содержимое зашифровано
        так, что прочитать его может только ваше устройство; службе видно лишь, что сервер что-то отправил.
      </p>
    </section>
  );
}

export function NotificationsPage() {
  const { notifications, reloadNotifications } = useChat();
  const [override, setOverride] = useState<NotificationsResponse | null>(null);
  const state = override ?? notifications;
  const ids = useId();
  const [error, setError] = useState('');

  const marked = useRef(false);
  useEffect(() => {
    // Looking at the list means the news is seen; only the first load of the page marks things read.
    if (marked.current || !notifications) return;
    marked.current = true;
    if (notifications.unread > 0) {
      void apiPost('/api/notifications/read', { ids: 'all' })
        .then(() => reloadNotifications())
        .catch(() => undefined);
    }
  }, [notifications, reloadNotifications]);

  async function setPref(key: keyof NotificationPrefs, value: boolean) {
    setError('');
    try {
      const prefs = await apiPost<NotificationPrefs>('/api/notifications/prefs', { [key]: value });
      if (state) setOverride({ ...state, prefs });
      reloadNotifications();
    } catch (failure) {
      setError(failureText(failure));
    }
  }

  return (
    <>
      <PageHeader
        title="Уведомления"
        icon={Bell}
        lead="Что произошло, пока вас не было, и о чём вам сообщать."
      />
      {!state ? <Loading label="Загружаем уведомления…" /> : null}
      {state ? (
        <div class="stack">
          <section class="panel" aria-labelledby={`${ids}-list`}>
            <h2 id={`${ids}-list`} class="section-title">
              Последние
            </h2>
            {state.notifications.length === 0 ? (
              <EmptyState icon={Bell} title="Пока ничего нового" level={3}>
                Здесь появятся завершённые загрузки, пропущенные звонки и сообщения сервера. Новые сообщения в
                чате видны в разделе «Чат».
              </EmptyState>
            ) : (
              <ul class="notes-list">
                {state.notifications.map((item) => (
                  <li key={item.id} class={item.read ? 'note-item' : 'note-item note-item--new'}>
                    <a href={item.url} class="note-item__link">
                      <span class="note-item__kind">{KIND_LABEL[item.kind]}</span>
                      <span class="note-item__title">{item.title}</span>
                      {item.body ? <span class="note-item__body">{item.body}</span> : null}
                      <time class="note-item__time" dateTime={item.at}>
                        {dayLabel(item.at)}, {formatClock(item.at)}
                      </time>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <DeviceBlock state={state} onState={setOverride} />
          <section class="panel" aria-labelledby={`${ids}-prefs`}>
            <h2 id={`${ids}-prefs`} class="section-title">
              О чём сообщать
            </h2>
            <ul class="prefs">
              {PREF_LABEL.map((pref) => (
                <li key={pref.key}>
                  <label class="check prefs__row">
                    <input
                      type="checkbox"
                      checked={state.prefs[pref.key]}
                      onChange={(e) => void setPref(pref.key, e.currentTarget.checked)}
                    />
                    <span>
                      <span class="prefs__label">{pref.label}</span>
                      <span class="field__hint">{pref.hint}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {error ? (
              <p class="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
