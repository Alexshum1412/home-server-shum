import { KeyRound } from 'lucide-preact';
import { useId, useRef, useState } from 'preact/hooks';
import type { ChangePasswordRequest, SessionResponse } from '../../../shared/api.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';

/** Same rule as the server (checkPasswordPolicy); the server stays the authority. */
export const MIN_PASSWORD_LENGTH = 10;

function PasswordInput(props: {
  id: string;
  label: string;
  value: string;
  autoComplete: 'current-password' | 'new-password';
  visible: boolean;
  describedBy?: string;
  inputRef?: { current: HTMLInputElement | null };
  onInput: (value: string) => void;
}) {
  return (
    <div class="field">
      <label class="field__label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        ref={props.inputRef}
        id={props.id}
        class="field__input"
        type={props.visible ? 'text' : 'password'}
        autoComplete={props.autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellcheck={false}
        required
        aria-describedby={props.describedBy}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </div>
  );
}

/**
 * Change of the signed-in user's own password (POST /api/password). The server ends every other
 * session of the user and hands this device a fresh one, passed to `onChanged`.
 */
export function PasswordForm(props: {
  username: string;
  currentLabel: string;
  submitLabel: string;
  class?: string;
  onChanged: (session: SessionResponse) => void;
}) {
  const ids = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLInputElement>(null);

  function fail(message: string, focus: { current: HTMLInputElement | null }) {
    setError(message);
    focus.current?.focus();
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (!current) return fail('Введите текущий пароль.', currentRef);
    if (Array.from(next).length < MIN_PASSWORD_LENGTH) {
      return fail(`Новый пароль слишком короткий: нужно не меньше ${MIN_PASSWORD_LENGTH} символов.`, nextRef);
    }
    if (next.trim().toLowerCase() === props.username.toLowerCase()) {
      return fail('Пароль не должен совпадать с логином.', nextRef);
    }
    if (next !== repeat) return fail('Пароли не совпадают. Введите новый пароль ещё раз.', repeatRef);
    setBusy(true);
    setError('');
    try {
      const body: ChangePasswordRequest = { currentPassword: current, newPassword: next };
      const session = await apiPost<SessionResponse>('/api/password', body);
      props.onChanged(session);
    } catch (err) {
      const failure = toFailure(err);
      setBusy(false);
      if (failure.code === 'wrong_password') {
        setCurrent('');
        return fail(failure.message, currentRef);
      }
      fail(failure.unreachable ? NO_CONNECTION : failure.message, nextRef);
    }
  }

  const hintId = `${ids}-hint`;
  return (
    <form class={props.class ?? 'password-form'} onSubmit={submit} noValidate>
      {/* Lets password managers attach the new password to the right account. */}
      <input type="text" name="username" autoComplete="username" value={props.username} hidden readOnly />
      <PasswordInput
        id={`${ids}-current`}
        label={props.currentLabel}
        value={current}
        autoComplete="current-password"
        visible={visible}
        inputRef={currentRef}
        onInput={setCurrent}
      />
      <PasswordInput
        id={`${ids}-new`}
        label="Новый пароль"
        value={next}
        autoComplete="new-password"
        visible={visible}
        describedBy={hintId}
        inputRef={nextRef}
        onInput={setNext}
      />
      <p id={hintId} class="field__hint">
        Не меньше {MIN_PASSWORD_LENGTH} символов. Удобно взять 3–4 случайных слова, например
        «сосна-чайник-маяк-42».
      </p>
      <PasswordInput
        id={`${ids}-repeat`}
        label="Новый пароль ещё раз"
        value={repeat}
        autoComplete="new-password"
        visible={visible}
        inputRef={repeatRef}
        onInput={setRepeat}
      />
      <label class="check">
        <input
          type="checkbox"
          checked={visible}
          onChange={(event) => setVisible(event.currentTarget.checked)}
        />
        Показать пароли
      </label>
      <p class="form-error" role="alert">
        {error}
      </p>
      <button type="submit" class="button button--primary button--large button--block" disabled={busy}>
        <KeyRound size={20} aria-hidden="true" />
        {busy ? 'Сохраняем…' : props.submitLabel}
      </button>
    </form>
  );
}
