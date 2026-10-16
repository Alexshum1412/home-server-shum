import { Check, Copy } from 'lucide-preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

type CopyState = 'idle' | 'copied' | 'manual';

function selectContents(element: HTMLElement | null): void {
  const selection = window.getSelection();
  if (!element || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Fallback for plain-HTTP pages where the async clipboard API is unavailable. */
function legacyCopy(element: HTMLElement | null): boolean {
  selectContents(element);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

/** A value shown as selectable text with a «Копировать» button. */
export function CopyField(props: { label: string; value: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const valueRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const labelId = useId();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(props.value);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) ok = legacyCopy(valueRef.current);
    if (!ok) selectContents(valueRef.current);
    setState(ok ? 'copied' : 'manual');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), ok ? 2500 : 8000);
  }

  return (
    <div class="copy-field">
      <p class="copy-field__label" id={labelId}>
        {props.label}
      </p>
      <div class="copy-field__row">
        <code class="copy-field__value" ref={valueRef}>
          {props.value}
        </code>
        <button type="button" class="button button--secondary" onClick={copy} aria-describedby={labelId}>
          {state === 'copied' ? (
            <Check size={18} aria-hidden="true" />
          ) : (
            <Copy size={18} aria-hidden="true" />
          )}
          {state === 'copied' ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <p class="copy-field__status" aria-live="polite">
        {state === 'copied' ? 'Адрес скопирован.' : null}
        {state === 'manual'
          ? 'Скопировать автоматически не получилось: адрес выделен, скопируйте его вручную.'
          : null}
      </p>
    </div>
  );
}
