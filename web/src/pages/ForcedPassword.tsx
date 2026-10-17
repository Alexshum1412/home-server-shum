import { LogOut } from 'lucide-preact';
import type { SessionResponse } from '../../../shared/api.ts';
import { PasswordForm } from '../components/PasswordForm.tsx';

/**
 * Shown instead of the portal after signing in with a generated (temporary) password: the server
 * refuses every other API call until the user has chosen an own password.
 */
export function ForcedPasswordPage(props: {
  session: SessionResponse;
  onChanged: (session: SessionResponse) => void;
  onLogout: () => void;
}) {
  const { user } = props.session;
  return (
    <div class="auth">
      <main id="main" class="auth__main">
        <div class="auth__brand">
          <img class="auth__mark" src="/icons/icon.svg" alt="" width={56} height={56} />
          <h1 class="auth__title" tabIndex={-1}>
            Придумайте свой пароль
          </h1>
          <p class="auth__lead">
            {user.displayName}, вы вошли с временным паролем. Он действует только для первого входа — задайте
            пароль, который знаете только вы.
          </p>
        </div>
        <PasswordForm
          class="auth__form"
          username={user.username}
          currentLabel="Временный пароль"
          submitLabel="Сохранить и открыть портал"
          onChanged={props.onChanged}
        />
        <button type="button" class="button button--quiet" onClick={props.onLogout}>
          <LogOut size={18} aria-hidden="true" />
          Выйти
        </button>
      </main>
    </div>
  );
}
