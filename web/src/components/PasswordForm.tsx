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
  /** Problem with this very field: shown right under it, so it is seen next to the keyboard. */
  error?: string;
  inputRef?: { current: HTMLInputElement | null };
  onInput: (value: string) => void;
}) {
  const errorId = `${props.id}-error`;
  const describedBy = [props.describedBy, props.error ? errorId : undefined].filter(Boolean).join(' ');
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
        aria-invalid={props.error ? 'true' : undefined}
        aria-describedby={describedBy || undefined}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      {props.error ? (
        <p id={errorId} class="form-error" role="alert">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

type FieldName = 'current' | 'next' | 'repeat';

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
  const [error, setError] = useState<{ field: FieldName; message: string } | null>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLInputElement>(null);

  const refs: Record<FieldName, { current: HTMLInputElement | null }> = {
    current: currentRef,
    next: nextRef,
    repeat: repeatRef,
  };

  function fail(message: string, field: FieldName) {
    setError({ field, message });
    refs[field].current?.focus();
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (busy) return;
    if (!current) return fail('Введите текущий пароль.', 'current');
    if (Array.from(next).length < MIN_PASSWORD_LENGTH) {
      return fail(`Новый пароль слишком короткий: нужно не меньше ${MIN_PASSWORD_LENGTH} символов.`, 'next');
    }
    if (next.trim().toLowerCase() === props.username.toLowerCase()) {
      return fail('Пароль не должен совпадать с логином.', 'next');
    }
    if (next !== repeat) return fail('Пароли не совпадают. Введите новый пароль ещё раз.', 'repeat');
    setBusy(true);
    setError(null);
    try {
      const body: ChangePasswordRequest = { currentPassword: current, newPassword: next };
      const session = await apiPost<SessionResponse>('/api/password', body);
      props.onChanged(session);
    } catch (err) {
      const failure = toFailure(err);
      setBusy(false);
      if (failure.code === 'wrong_password') {
        setCurrent('');
        return fail(failure.message, 'current');
      }
      fail(failure.unreachable ? NO_CONNECTION : failure.message, 'next');
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
        error={error?.field === 'current' ? error.message : undefined}
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
        error={error?.field === 'next' ? error.message : undefined}
        inputRef={nextRef}
        onInput={setNext}
      />
      <p id={hintId} class="field__hint">
        Не меньше {MIN_PASSWORD_LENGTH} символов. Удобно взять 3–4 своих слова через дефис и пару цифр — так
        пароль легко запомнить и трудно угадать.
      </p>
      <PasswordInput
        id={`${ids}-repeat`}
        label="Новый пароль ещё раз"
        value={repeat}
        autoComplete="new-password"
        visible={visible}
        error={error?.field === 'repeat' ? error.message : undefined}
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
      <button type="submit" class="button button--primary button--large button--block" disabled={busy}>
        <KeyRound size={20} aria-hidden="true" />
        {busy ? 'Сохраняем…' : props.submitLabel}
      </button>
    </form>
  );
}
