import { KeyRound, Trash2, UserPlus, Users } from 'lucide-preact';
import { useId, useRef, useState } from 'preact/hooks';
import {
  PERMISSIONS,
  type Permission,
  type Role,
  type TemporaryPasswordResponse,
  type UsersResponse,
} from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { useResource } from '../hooks/useResource.ts';
import { formatDateTime } from '../lib/format.ts';
import { ROLE_LABEL } from '../lib/labels.ts';
import { useSession } from '../state.tsx';
import { CopyField } from './CopyField.tsx';
import { TableWrap } from './DataTable.tsx';
import { ErrorState } from './ErrorState.tsx';
import { Loading } from './Skeleton.tsx';
import type { ToastApi } from './Toast.tsx';

type UserRow = UsersResponse['users'][number];

const PERMISSION_LABEL: Record<Permission, string> = {
  downloads: 'Загрузки по ссылке',
  print: 'Печать',
};

function permissionsText(user: UserRow): string {
  if (user.role === 'admin') return 'все';
  return user.permissions.map((p) => PERMISSION_LABEL[p]).join(', ') || 'нет';
}

/** The temporary password of a new or reset account: shown once, kept nowhere. */
function SecretPanel(props: { secret: TemporaryPasswordResponse; onClose: () => void }) {
  const { secret } = props;
  return (
    <section class="secret" aria-labelledby="secret-title">
      <h3 id="secret-title" class="secret__title">
        Временный пароль для «{secret.displayName}» (логин {secret.username})
      </h3>
      <CopyField label="Временный пароль" value={secret.temporaryPassword} copiedText="Пароль скопирован." />
      <p>
        Передайте человеку логин и этот пароль лично или в личном сообщении. Пароль показан{' '}
        <strong>один раз</strong> и нигде не сохранён: потерянный пароль не восстановить, можно только выдать
        новый. Он действует до {formatDateTime(secret.expiresAt)} и только для первого входа — сразу после
        входа портал попросит придумать свой пароль.
      </p>
      <button type="button" class="button button--secondary" onClick={props.onClose}>
        Готово, скрыть пароль
      </button>
    </section>
  );
}

function AddUserForm(props: { toast: ToastApi; onCreated: (secret: TemporaryPasswordResponse) => void }) {
  const ids = useId();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('family');
  const [rights, setRights] = useState<Permission[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loginRef = useRef<HTMLInputElement>(null);

  async function submit(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (!username.trim() || !displayName.trim()) {
      setError('Укажите логин и имя.');
      (username.trim() ? undefined : loginRef.current)?.focus();
      return;
    }
    if (
      role === 'admin' &&
      !window.confirm('Администратор видит состояние сервера и управляет людьми. Создать администратора?')
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const secret = await apiPost<TemporaryPasswordResponse>('/api/admin/users', {
        username: username.trim(),
        displayName: displayName.trim(),
        role,
        permissions: role === 'family' ? rights : [],
      });
      setUsername('');
      setDisplayName('');
      setRole('family');
      setRights([]);
      props.onCreated(secret);
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.unreachable ? NO_CONNECTION : failure.message);
      loginRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <details class="disclosure">
      <summary class="disclosure__summary">
        <UserPlus size={18} aria-hidden="true" />
        Добавить человека
      </summary>
      <form class="user-form" onSubmit={submit} noValidate>
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-login`}>
            Логин
          </label>
          <input
            ref={loginRef}
            id={`${ids}-login`}
            class="field__input"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellcheck={false}
            required
            aria-describedby={`${ids}-login-hint`}
            value={username}
            onInput={(event) => setUsername(event.currentTarget.value)}
          />
          <p id={`${ids}-login-hint`} class="field__hint">
            Латиница, цифры, «.», «_», «-», например mama. Логин потом не меняется.
          </p>
        </div>
        <div class="field">
          <label class="field__label" htmlFor={`${ids}-name`}>
            Имя для приветствия
          </label>
          <input
            id={`${ids}-name`}
            class="field__input"
            autoComplete="off"
            required
            value={displayName}
            onInput={(event) => setDisplayName(event.currentTarget.value)}
          />
        </div>
        <fieldset class="user-form__group">
          <legend class="field__label">Роль</legend>
          <label class="check">
            <input
              type="radio"
              name={`${ids}-role`}
              checked={role === 'family'}
              onChange={() => setRole('family')}
            />
            Семья — пользуется порталом
          </label>
          <label class="check">
            <input
              type="radio"
              name={`${ids}-role`}
              checked={role === 'admin'}
              onChange={() => setRole('admin')}
            />
            Администратор — ещё и управляет людьми и видит состояние сервера
          </label>
        </fieldset>
        {role === 'family' ? (
          <fieldset class="user-form__group">
            <legend class="field__label">Дополнительные права</legend>
            {PERMISSIONS.map((permission) => (
              <label key={permission} class="check">
                <input
                  type="checkbox"
                  checked={rights.includes(permission)}
                  onChange={(event) =>
                    setRights((all) =>
                      event.currentTarget.checked
                        ? [...all, permission]
                        : all.filter((p) => p !== permission),
                    )
                  }
                />
                {PERMISSION_LABEL[permission]}
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" class="button button--primary" disabled={busy}>
          <UserPlus size={20} aria-hidden="true" />
          {busy ? 'Создаём…' : 'Создать и выдать временный пароль'}
        </button>
      </form>
    </details>
  );
}

function ManageUser(props: {
  user: UserRow;
  isMe: boolean;
  toast: ToastApi;
  onChanged: () => void;
  onSecret: (secret: TemporaryPasswordResponse) => void;
}) {
  const { user, toast } = props;
  const ids = useId();
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (err) {
      const failure = toFailure(err);
      toast.showError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/admin/users/${encodeURIComponent(user.username)}`;
  const setRights = (permissions: Permission[]) =>
    run(async () => {
      await apiPost(`${base}/access`, { permissions });
      toast.showOk(`Права «${user.displayName}» обновлены.`);
      props.onChanged();
    });
  const setRole = (role: Role) =>
    run(async () => {
      if (
        !window.confirm(
          role === 'admin'
            ? `Сделать «${user.displayName}» администратором?`
            : `Снять роль администратора с «${user.displayName}»?`,
        )
      ) {
        return;
      }
      await apiPost(`${base}/access`, { role });
      toast.showOk(`Роль «${user.displayName}» изменена.`);
      props.onChanged();
    });
  const resetPassword = () =>
    run(async () => {
      if (
        !window.confirm(
          `Выдать «${user.displayName}» новый временный пароль? Старый пароль и все открытые входы перестанут работать.`,
        )
      ) {
        return;
      }
      props.onSecret(await apiPost<TemporaryPasswordResponse>(`${base}/reset-password`, {}));
      props.onChanged();
    });
  const remove = () =>
    run(async () => {
      if (
        !window.confirm(
          `Удалить пользователя «${user.displayName}»? Он больше не сможет войти. Его файлы и фото не удаляются: они переносятся в корзину на сервере, администратор может их вернуть. Личные события календаря будут удалены.`,
        )
      ) {
        return;
      }
      await apiPost(`${base}/remove`, { confirm: true });
      toast.showOk(`Пользователь «${user.displayName}» удалён.`);
      props.onChanged();
    });

  return (
    <details class="disclosure disclosure--row">
      <summary class="disclosure__summary">
        Управление<span class="visually-hidden"> пользователем «{user.displayName}»</span>
      </summary>
      <div class="user-manage">
        {user.role === 'family' ? (
          <fieldset class="user-form__group">
            <legend class="field__label">Дополнительные права</legend>
            {PERMISSIONS.map((permission) => (
              <label key={permission} class="check" htmlFor={`${ids}-${permission}`}>
                <input
                  id={`${ids}-${permission}`}
                  type="checkbox"
                  checked={user.permissions.includes(permission)}
                  disabled={busy}
                  onChange={(event) =>
                    void setRights(
                      PERMISSIONS.filter((p) =>
                        p === permission ? event.currentTarget.checked : user.permissions.includes(p),
                      ),
                    )
                  }
                />
                {PERMISSION_LABEL[permission]}
              </label>
            ))}
          </fieldset>
        ) : (
          <p class="meta">У администратора есть все права.</p>
        )}
        {props.isMe ? (
          <p class="meta">
            Это вы. Свой пароль меняйте в «Мой профиль», свою роль может изменить только другой администратор.
          </p>
        ) : (
          <div class="action-row">
            <button
              type="button"
              class="button button--secondary"
              disabled={busy}
              onClick={() => void setRole(user.role === 'admin' ? 'family' : 'admin')}
            >
              {user.role === 'admin' ? 'Сделать обычным пользователем' : 'Сделать администратором'}
            </button>
            <button
              type="button"
              class="button button--secondary"
              disabled={busy}
              onClick={() => void resetPassword()}
            >
              <KeyRound size={18} aria-hidden="true" />
              Выдать новый временный пароль
            </button>
            <button type="button" class="button button--quiet" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={18} aria-hidden="true" />
              Удалить
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

/** «Пользователи»: the list and everything an administrator needs to look after accounts. */
export function UsersBlock(props: { toast: ToastApi }) {
  const { session } = useSession();
  const users = useResource<UsersResponse>('/api/admin/users');
  const [secret, setSecret] = useState<TemporaryPasswordResponse | null>(null);

  let content = null;
  if (users.data) {
    content =
      users.data.users.length === 0 ? (
        <p class="section-lead">Пользователей нет.</p>
      ) : (
        <TableWrap labelledBy="users-title">
          <table class="table table--stack">
            <thead>
              <tr>
                <th scope="col">Имя</th>
                <th scope="col">Логин</th>
                <th scope="col">Роль</th>
                <th scope="col">Права</th>
                <th scope="col">Последний вход</th>
                <th scope="col">Пароль</th>
                <th scope="col">Управление</th>
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((user) => (
                <tr key={user.id}>
                  <th scope="row">{user.displayName}</th>
                  <td class="table__nowrap" data-label="Логин">
                    {user.username}
                  </td>
                  <td data-label="Роль">{ROLE_LABEL[user.role]}</td>
                  <td data-label="Права">{permissionsText(user)}</td>
                  <td class="table__nowrap" data-label="Последний вход">
                    {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Входов не было'}
                  </td>
                  <td class="table__nowrap" data-label="Пароль">
                    {user.temporaryPassword
                      ? `временный, до ${user.passwordExpiresAt ? formatDateTime(user.passwordExpiresAt) : '—'}`
                      : 'свой'}
                  </td>
                  <td data-label="Управление">
                    <ManageUser
                      user={user}
                      isMe={user.username === session.user.username}
                      toast={props.toast}
                      onChanged={users.reload}
                      onSecret={setSecret}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      );
  } else if (users.error) {
    content = <ErrorState failure={users.error} onRetry={users.reload} busy={users.loading} level={3} />;
  } else {
    content = <Loading label="Загружаем пользователей…" />;
  }

  return (
    <section class="page-section">
      <h2 id="users-title" class="section-title">
        <Users class="section-title__icon" size={20} aria-hidden="true" />
        Пользователи
      </h2>
      <p class="section-lead">
        Здесь можно добавить человека, выдать новый временный пароль, изменить права или удалить пользователя.
        Пароли вы не придумываете и не видите: портал создаёт временный пароль, человек входит с ним один раз
        и сразу задаёт свой. То же самое можно сделать на домашнем компьютере командой{' '}
        <code>scripts\user.cmd</code> (add, list, passwd, role, allow, deny, remove) — это запасной путь, если
        портал не открывается.
      </p>
      {secret ? <SecretPanel secret={secret} onClose={() => setSecret(null)} /> : null}
      <AddUserForm
        toast={props.toast}
        onCreated={(created) => {
          setSecret(created);
          props.toast.showOk(`Пользователь «${created.displayName}» создан.`);
          users.reload();
        }}
      />
      {content}
    </section>
  );
}
