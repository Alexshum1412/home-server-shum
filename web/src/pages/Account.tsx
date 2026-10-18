import { CircleCheck, LogOut, MonitorSmartphone, Palette, UserRound } from 'lucide-preact';
import { useId, useState } from 'preact/hooks';
import type { SessionResponse, SessionsResponse } from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { PasswordForm } from '../components/PasswordForm.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatDateTime } from '../lib/format.ts';
import { ROLE_LABEL } from '../lib/labels.ts';
import { readTheme, saveTheme, THEME_LABEL, type Theme } from '../lib/theme.ts';
import { useSession } from '../state.tsx';

function ThemeChoice() {
  const name = useId();
  const [theme, setTheme] = useState<Theme>(readTheme);
  return (
    <section class="page-section" aria-labelledby="account-theme">
      <h2 id="account-theme" class="section-title">
        <Palette class="section-title__icon" size={20} aria-hidden="true" />
        Оформление
      </h2>
      <p class="section-lead">Выбор действует только на этом устройстве.</p>
      <fieldset class="user-form__group">
        <legend class="visually-hidden">Тема оформления</legend>
        {(Object.keys(THEME_LABEL) as Theme[]).map((value) => (
          <label key={value} class="check">
            <input
              type="radio"
              name={name}
              checked={theme === value}
              onChange={() => {
                setTheme(value);
                saveTheme(value);
              }}
            />
            {THEME_LABEL[value]}
          </label>
        ))}
      </fieldset>
    </section>
  );
}

/** The devices signed in as this person; a lost phone can be signed out from here. */
function DevicesBlock() {
  const devices = useResource<SessionsResponse>('/api/sessions');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function revoke(body: { id: string } | { others: true }, text: string) {
    setBusy(true);
    setMessage('');
    try {
      await apiPost('/api/sessions/revoke', body);
      setMessage(text);
      devices.reload();
    } catch (error) {
      const failure = toFailure(error);
      setMessage(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  const others = devices.data?.sessions.filter((session) => !session.current) ?? [];
  return (
    <section class="page-section" aria-labelledby="account-devices">
      <h2 id="account-devices" class="section-title">
        <MonitorSmartphone class="section-title__icon" size={20} aria-hidden="true" />
        Мои устройства
      </h2>
      <p class="section-lead">
        Здесь видно, где вы вошли в портал. Если потеряли телефон, выйдите на нём отсюда — пароль менять не
        нужно.
      </p>
      {devices.data ? (
        <ul class="devices">
          {devices.data.sessions.map((session) => (
            <li key={session.id} class="devices__row">
              <span class="devices__name">
                {session.label}
                {session.current ? <span class="devices__here"> · это устройство</span> : null}
              </span>
              <span class="meta">
                Вход: {formatDateTime(session.createdAt)} · последний раз:{' '}
                {formatDateTime(session.lastSeenAt)}
              </span>
              {session.current ? null : (
                <button
                  type="button"
                  class="button button--quiet"
                  disabled={busy}
                  onClick={() => void revoke({ id: session.id }, 'Устройство вышло из портала.')}
                >
                  <LogOut size={18} aria-hidden="true" />
                  Выйти на этом устройстве<span class="visually-hidden">: {session.label}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : devices.error ? (
        <ErrorState failure={devices.error} onRetry={devices.reload} busy={devices.loading} level={3} />
      ) : (
        <Loading label="Загружаем список устройств…" />
      )}
      {others.length > 1 ? (
        <button
          type="button"
          class="button button--secondary"
          disabled={busy}
          onClick={() => void revoke({ others: true }, 'Все остальные устройства вышли из портала.')}
        >
          <LogOut size={18} aria-hidden="true" />
          Выйти на всех остальных устройствах
        </button>
      ) : null}
      {message ? (
        <p class="action-message" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}

/** «Мой профиль»: who is signed in, the look of the portal, own devices and the own password. */
export function AccountPage(props: { onSessionChanged: (session: SessionResponse) => void }) {
  const { session } = useSession();
  const { user } = session;
  const [changed, setChanged] = useState(false);
  return (
    <div class="page page--narrow">
      <PageHeader
        title="Мой профиль"
        icon={UserRound}
        lead="Здесь можно сменить свой пароль, выбрать оформление и закрыть вход на потерянном устройстве. Остальные настройки учётной записи меняет администратор."
      />
      <section class="page-section" aria-labelledby="account-me">
        <h2 id="account-me" class="section-title">
          Вы вошли как
        </h2>
        <dl class="facts">
          <div class="facts__row">
            <dt>Имя</dt>
            <dd>{user.displayName}</dd>
          </div>
          <div class="facts__row">
            <dt>Логин</dt>
            <dd>{user.username}</dd>
          </div>
          <div class="facts__row">
            <dt>Роль</dt>
            <dd>{ROLE_LABEL[user.role]}</dd>
          </div>
        </dl>
      </section>
      <ThemeChoice />
      <DevicesBlock />
      <section class="page-section" aria-labelledby="account-password">
        <h2 id="account-password" class="section-title">
          Сменить пароль
        </h2>
        <p class="section-lead">
          После смены пароля портал останется открытым на этом устройстве, а на остальных телефонах и
          компьютерах нужно будет войти заново.
        </p>
        {changed ? (
          <p class="banner banner--ok" role="status">
            <CircleCheck size={20} aria-hidden="true" />
            Пароль изменён. На других устройствах войдите с новым паролем.
          </p>
        ) : null}
        <PasswordForm
          key={changed ? 'after' : 'before'}
          class="password-form password-form--page"
          username={user.username}
          currentLabel="Текущий пароль"
          submitLabel="Сменить пароль"
          onChanged={(next) => {
            setChanged(true);
            props.onSessionChanged(next);
          }}
        />
      </section>
    </div>
  );
}
