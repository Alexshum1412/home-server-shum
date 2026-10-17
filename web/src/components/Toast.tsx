import { X } from 'lucide-preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

const OK_VISIBLE_MS = 6000;

export interface ToastApi {
  ok: string;
  error: string;
  showOk: (text: string) => void;
  showError: (text: string) => void;
  clear: () => void;
}

/**
 * Result of an action («переименовано», «не получилось»). It is shown by `ToastRegion` in a fixed
 * place above the tab bar, so it is seen even when the button that caused it is far down a long list.
 * A success message disappears by itself; an error stays until it is closed or the page changes.
 */
export function useToast(): ToastApi {
  const [state, setState] = useState({ ok: '', error: '' });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const showOk = useCallback((text: string) => {
    clearTimeout(timer.current);
    setState({ ok: text, error: '' });
    timer.current = setTimeout(() => setState((prev) => ({ ...prev, ok: '' })), OK_VISIBLE_MS);
  }, []);
  const showError = useCallback((text: string) => {
    clearTimeout(timer.current);
    setState({ ok: '', error: text });
  }, []);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setState({ ok: '', error: '' });
  }, []);

  return { ...state, showOk, showError, clear };
}

/**
 * The two live regions stay in the page even when empty, so screen readers announce a message the
 * moment its text appears.
 */
export function ToastRegion(props: { toast: ToastApi }) {
  const { toast } = props;
  return (
    <div class="toast-region">
      <p class={toast.ok ? 'toast toast--ok toast--on' : 'toast toast--ok'} role="status">
        {toast.ok}
      </p>
      <p class={toast.error ? 'toast toast--error toast--on' : 'toast toast--error'} role="alert">
        {toast.error}
        {toast.error ? (
          <button type="button" class="toast__close" onClick={toast.clear}>
            <X size={18} aria-hidden="true" />
            <span class="visually-hidden">Закрыть сообщение</span>
          </button>
        ) : null}
      </p>
    </div>
  );
}
