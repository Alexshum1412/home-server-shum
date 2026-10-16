import { FlaskConical, RefreshCw, TriangleAlert, WifiOff } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { NO_CONNECTION } from '../api.ts';
import { useData } from '../state.tsx';
import { RelativeTime } from './RelativeTime.tsx';

/** Persistent label for demo mode: the data on screen is not real. */
export function DemoBanner() {
  return (
    <div class="banner banner--info">
      <FlaskConical class="banner__icon" size={20} aria-hidden="true" />
      <p class="banner__title">Демо-режим: показанные состояния сервисов не настоящие</p>
    </div>
  );
}

/**
 * Shown when polling fails; the last good data stays on screen with its age.
 *
 * Only the short title is a live region, and it stays in the DOM (empty while all is well),
 * so the message is announced once when it appears. The age of the data, the error text and
 * the retry button live outside it: background polls every 30–60 s must not re-announce anything.
 * The DOM structure is the same with and without a failure so the live region is never re-created.
 */
export function ConnectionBanner() {
  const { services, system, refreshAll } = useData();
  const failure = system.error ?? services.error;
  // The age of the OLDEST data on screen: one fresh source must not hide that the other is stale.
  const times = [services.receivedAt, system.receivedAt].filter((time): time is number => time !== null);
  const receivedAt = times.length > 0 ? Math.min(...times) : null;
  const loading = services.loading || system.loading;
  // «Проверяем…» only after the user pressed the button, not during background polls:
  // the retry ends when the requests it started have finished.
  const [retrying, setRetrying] = useState(false);
  const retryStarted = useRef(false);
  useEffect(() => {
    if (!retrying) return;
    if (loading) retryStarted.current = true;
    else if (retryStarted.current) {
      retryStarted.current = false;
      setRetrying(false);
    }
  }, [retrying, loading]);
  const busy = retrying && loading;

  const retry = () => {
    retryStarted.current = false;
    setRetrying(true);
    refreshAll();
  };

  let title: string | null = null;
  let icon = null;
  if (failure) {
    title = failure.unreachable ? NO_CONNECTION : 'Сервер ответил с ошибкой';
    icon = failure.unreachable ? (
      <WifiOff class="banner__icon" size={20} aria-hidden="true" />
    ) : (
      <TriangleAlert class="banner__icon" size={20} aria-hidden="true" />
    );
  }

  return (
    <div class={failure ? `banner ${failure.unreachable ? 'banner--bad' : 'banner--warn'}` : 'banner-slot'}>
      {icon}
      <div class={failure ? 'banner__body' : undefined}>
        <p class={failure ? 'banner__title' : undefined} role="status">
          {title}
        </p>
        {failure ? (
          <p class="banner__text">
            {failure.message !== NO_CONNECTION ? `${failure.message} ` : null}
            {receivedAt ? (
              <>
                Показаны данные, полученные <RelativeTime value={receivedAt} />.
              </>
            ) : (
              'Данных пока нет.'
            )}
          </p>
        ) : null}
      </div>
      {failure ? (
        <button type="button" class="button button--secondary banner__action" onClick={retry} disabled={busy}>
          <RefreshCw size={18} aria-hidden="true" />
          {busy ? 'Проверяем…' : 'Повторить'}
        </button>
      ) : null}
    </div>
  );
}
