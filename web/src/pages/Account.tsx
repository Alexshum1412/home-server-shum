import { CircleCheck, UserRound } from 'lucide-preact';
import { useState } from 'preact/hooks';
import type { SessionResponse } from '../../../shared/api.ts';
import { PageHeader } from '../components/PageHeader.tsx';
import { PasswordForm } from '../components/PasswordForm.tsx';
import { ROLE_LABEL } from '../lib/labels.ts';
import { useSession } from '../state.tsx';

/** «Мой профиль»: who is signed in and the change of the own password. */
export function AccountPage(props: { onSessionChanged: (session: SessionResponse) => void }) {
  const { session } = useSession();
  const { user } = session;
  const [changed, setChanged] = useState(false);
  return (
    <div class="page page--narrow">
      <PageHeader
        title="Мой профиль"
        icon={UserRound}
        lead="Здесь можно сменить свой пароль. Остальные настройки учётной записи меняет администратор."
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
