import { Eye, EyeOff, LogIn, Terminal } from 'lucide-preact';
import { useRef, useState } from 'preact/hooks';
import type { SessionResponse, SetupStateResponse } from '../../../shared/api.ts';
import { apiGet, apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { useResource } from '../hooks/useResource.ts';

function FirstRun(props: { command: string }) {
  return (
    <section class="first-run" aria-labelledby="first-run-title">
      <h2 id="first-run-title" class="first-run__title">
        <Terminal size={20} aria-hidden="true" />
        Первый запуск: учётных записей пока нет
      </h2>
      <p>
        Создайте администратора на домашнем компьютере: откройте командную строку в папке портала и выполните
        команду. Пароль вводится там же, в браузер он не передаётся.
      </p>
      <code class="first-run__command">{props.command}</code>
      <p>После этого войдите здесь под созданным именем.</p>
    </section>
  );
}

/** Sign-in screen; shows the first-run instructions when the server has no users yet. */
export function LoginPage(props: { onSignedIn: (session: SessionResponse) => void }) {
  const setup = useResource<SetupStateResponse>('/api/setup-state');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const userRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function submit(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) {
      setError('Введите имя пользователя и пароль.');
      (username.trim() ? passwordRef : userRef).current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await apiPost('/api/login', { username: username.trim(), password }, { quiet401: true });
      const session = await apiGet<SessionResponse>('/api/session', { quiet401: true });
      props.onSignedIn(session);
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.unreachable ? NO_CONNECTION : failure.message);
      setPassword('');
      setBusy(false);
      passwordRef.current?.focus();
    }
  }

  return (
    <div class="auth">
      <main id="main" class="auth__main">
        <div class="auth__brand">
          <img class="auth__mark" src="/icons/icon.svg" alt="" width={56} height={56} />
          <h1 class="auth__title" tabIndex={-1}>
            Семейный сервер
          </h1>
          <p class="auth__lead">Войдите, чтобы открыть домашние сервисы.</p>
        </div>

        {setup.data && !setup.data.hasUsers ? <FirstRun command={setup.data.createAdminCommand} /> : null}

        <form class="auth__form" onSubmit={submit} noValidate>
          <div class="field">
            <label class="field__label" htmlFor="login-username">
              Имя пользователя
            </label>
            <input
              ref={userRef}
              id="login-username"
              class="field__input"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellcheck={false}
              required
              value={username}
              onInput={(event) => setUsername(event.currentTarget.value)}
            />
          </div>
          <div class="field">
            <label class="field__label" htmlFor="login-password">
              Пароль
            </label>
            <div class="field__with-action">
              <input
                ref={passwordRef}
                id="login-password"
                class="field__input"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onInput={(event) => setPassword(event.currentTarget.value)}
              />
              <button
                type="button"
                class="field__action"
                aria-pressed={showPassword}
                aria-label="Показать пароль"
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? (
                  <EyeOff size={20} aria-hidden="true" />
                ) : (
                  <Eye size={20} aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
          <p class="form-error" role="alert">
            {error}
          </p>
          <button type="submit" class="button button--primary button--large button--block" disabled={busy}>
            <LogIn size={20} aria-hidden="true" />
            {busy ? 'Входим…' : 'Войти'}
          </button>
        </form>
        <p class="auth__note">Забыли пароль? Его меняет администратор на домашнем компьютере.</p>
      </main>
    </div>
  );
}
