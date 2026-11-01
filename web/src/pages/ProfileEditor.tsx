import { Send, Unlink } from 'lucide-preact';
import { useEffect, useId, useState } from 'preact/hooks';
import type { ProfilePatch, ProfileResponse, TelegramLinkResponse } from '../../../shared/profile.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { Loading } from '../components/Skeleton.tsx';
import { useResource } from '../hooks/useResource.ts';

/** What a person tells about themselves: city, interests, Telegram. Used in the profile and at the first sign-in. */
export function ProfileEditor(props: {
  submitLabel: string;
  /** Called after the answers are saved. */
  onSaved: (message: string) => void;
  onProblem: (message: string) => void;
  /** A second button (the first-sign-in dialog offers «Позже»). */
  secondary?: { label: string; onClick: () => void };
}) {
  const ids = useId();
  const data = useResource<ProfileResponse>('/api/profile');
  const [city, setCity] = useState<string | null>(null);
  const [about, setAbout] = useState<string | null>(null);
  const [tg, setTg] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<TelegramLinkResponse | null>(null);

  // While the code waits to be sent to the bot, the page notices the moment the chat is linked.
  useEffect(() => {
    if (!link) return;
    const timer = setInterval(() => data.reload(), 3000);
    return () => clearInterval(timer);
  }, [link]);
  useEffect(() => {
    if (link && data.data?.profile.telegramLinked) {
      setLink(null);
      props.onSaved('Telegram привязан.');
    }
  }, [data.data?.profile.telegramLinked]);

  const d = data.data;
  if (!d) return <Loading label="Загружаем…" />;
  const profile = d.profile;
  const interests = picked ?? profile.interests;

  async function run(job: () => Promise<unknown>, ok: string, reload = true) {
    setBusy(true);
    try {
      await job();
      if (reload) data.reload();
      if (ok) props.onSaved(ok);
    } catch (error) {
      const failure = toFailure(error);
      props.onProblem(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  const save = () => {
    const patch: ProfilePatch = { onboarded: true };
    if (city !== null && city.trim() !== profile.city) patch.city = city;
    if (about !== null) patch.about = about;
    if (tg !== null) patch.telegramUsername = tg;
    if (picked !== null) patch.interests = picked;
    void run(() => apiPost('/api/profile', patch), 'Сохранено.');
  };

  return (
    <div class="profile-editor">
      <label class="field__label" htmlFor={`${ids}-city`}>
        Город (для погоды в вашем дайджесте)
      </label>
      <input
        id={`${ids}-city`}
        class="field__input"
        placeholder="Например: Москва"
        value={city ?? profile.city}
        onInput={(e) => setCity(e.currentTarget.value)}
      />

      <fieldset class="profile-editor__interests">
        <legend class="field__label">Что вам интересно — это попадёт в ваш утренний дайджест</legend>
        {d.interests.map((item) => (
          <label key={item.id} class="check">
            <input
              type="checkbox"
              checked={interests.includes(item.id)}
              onChange={(e) =>
                setPicked(
                  e.currentTarget.checked
                    ? [...interests, item.id]
                    : interests.filter((id) => id !== item.id),
                )
              }
            />
            <span>
              <strong>{item.title}</strong>
              <span class="meta"> — {item.lead}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label class="field__label" htmlFor={`${ids}-about`}>
        Расскажите о себе своими словами (необязательно): хобби, чем занимаетесь, чего ждёте от сервера
      </label>
      <textarea
        id={`${ids}-about`}
        class="field__input"
        rows={3}
        maxLength={300}
        value={about ?? profile.about}
        onInput={(e) => setAbout(e.currentTarget.value)}
      />

      <h3 class="section-title">Telegram</h3>
      {d.bot === null ? (
        <p class="meta">Бот пока не подключён: администратору нужно положить ключ бота на сервер.</p>
      ) : profile.telegramLinked ? (
        <>
          <p class="meta">
            Привязан: бот @{d.bot} пишет вам дайджест и уведомления, отвечает на вопросы, принимает ссылки,
            фото и файлы.
          </p>
          <label class="check">
            <input
              type="checkbox"
              checked={profile.telegramNotify}
              disabled={busy}
              onChange={(e) =>
                void run(() => apiPost('/api/profile', { telegramNotify: e.currentTarget.checked }), '')
              }
            />
            Присылать уведомления портала в Telegram
          </label>
          <div class="action-row">
            <button
              type="button"
              class="button button--quiet"
              disabled={busy}
              onClick={() => void run(() => apiPost('/api/profile/telegram-unlink', {}), 'Telegram отвязан.')}
            >
              <Unlink size={18} aria-hidden="true" />
              Отвязать
            </button>
          </div>
        </>
      ) : link ? (
        <div class="banner banner--info" role="status">
          <p>
            Нажмите на ссылку, откроется Telegram и бот сразу узнает вас:{' '}
            <a href={`https://t.me/${link.bot}?start=${link.code}`} target="_blank" rel="noopener noreferrer">
              t.me/{link.bot}
            </a>
            . Или откройте бота @{link.bot} и отправьте ему код <strong>{link.code}</strong> (действует{' '}
            {link.expiresInMinutes} минут).
          </p>
        </div>
      ) : (
        <div class="action-row">
          <button
            type="button"
            class="button button--secondary"
            disabled={busy}
            onClick={() =>
              void run(
                async () => setLink(await apiPost<TelegramLinkResponse>('/api/profile/telegram-link', {})),
                '',
                false,
              )
            }
          >
            <Send size={18} aria-hidden="true" />
            Привязать Telegram
          </button>
        </div>
      )}
      <label class="field__label" htmlFor={`${ids}-tg`}>
        Ваше имя в Telegram (необязательно, только для подписи)
      </label>
      <input
        id={`${ids}-tg`}
        class="field__input"
        placeholder="@имя"
        maxLength={40}
        value={tg ?? (profile.telegramUsername ? `@${profile.telegramUsername}` : '')}
        onInput={(e) => setTg(e.currentTarget.value)}
      />

      <div class="action-row">
        <button type="button" class="button button--primary" disabled={busy} onClick={save}>
          {props.submitLabel}
        </button>
        {props.secondary ? (
          <button
            type="button"
            class="button button--quiet"
            disabled={busy}
            onClick={props.secondary.onClick}
          >
            {props.secondary.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
