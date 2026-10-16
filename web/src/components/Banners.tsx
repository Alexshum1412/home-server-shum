import { FlaskConical, RefreshCw, TriangleAlert, WifiOff } from 'lucide-preact';
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
 * Shown when polling fails. The live region is always in the DOM so that the
 * message is announced when it appears; the last good data stays on screen with its age.
 */
export function ConnectionBanner() {
  const { services, system, refreshAll } = useData();
  const failure = system.error ?? services.error;
  const receivedAt = Math.max(services.receivedAt ?? 0, system.receivedAt ?? 0) || null;
  const busy = services.loading || system.loading;
  return (
    <div class="banner-slot" role="status">
      {failure ? (
        <div class={`banner ${failure.unreachable ? 'banner--bad' : 'banner--warn'}`}>
          {failure.unreachable ? (
            <WifiOff class="banner__icon" size={20} aria-hidden="true" />
          ) : (
            <TriangleAlert class="banner__icon" size={20} aria-hidden="true" />
          )}
          <div class="banner__body">
            <p class="banner__title">{failure.unreachable ? NO_CONNECTION : 'Сервер ответил с ошибкой'}</p>
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
          </div>
          <button
            type="button"
            class="button button--secondary banner__action"
            onClick={refreshAll}
            disabled={busy}
          >
            <RefreshCw size={18} aria-hidden="true" />
            {busy ? 'Проверяем…' : 'Повторить'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
