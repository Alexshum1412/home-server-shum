import { Newspaper, RefreshCw } from 'lucide-preact';
import { useId, useState } from 'preact/hooks';
import type { DigestResponse } from '../../../shared/extras.ts';
import { apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { ToastRegion, useToast } from '../components/Toast.tsx';
import { useResource } from '../hooks/useResource.ts';
import { formatDateTime } from '../lib/format.ts';

/** «Утренний дайджест»: a short personal message every morning (portal, and Telegram if it is set up). */
export function DigestPage() {
  const ids = useId();
  const toast = useToast();
  const data = useResource<DigestResponse>('/api/digest');
  const [city, setCity] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run<T>(job: () => Promise<T>, ok: string) {
    setBusy(true);
    try {
      await job();
      toast.showOk(ok);
      data.reload();
    } catch (error) {
      const failure = toFailure(error);
      toast.showError(failure.unreachable ? NO_CONNECTION : failure.message);
    } finally {
      setBusy(false);
    }
  }

  const d = data.data;
  return (
    <div class="page">
      <PageHeader
        title="Утренний дайджест"
        icon={Newspaper}
        lead="Каждое утро — короткая сводка именно для вас: дела и события дня, ближайшие сроки, погода, курсы. Пишет её модель на этом компьютере; чужого она не видит."
      />
      {data.error && !d ? (
        <ErrorState failure={data.error} onRetry={data.reload} busy={data.loading} level={3} />
      ) : null}
      {!d && !data.error ? <Loading label="Загружаем…" /> : null}
      {d ? (
        <>
          <section class="page-section" aria-labelledby={`${ids}-last`}>
            <h2 id={`${ids}-last`} class="section-title">
              Последний дайджест
            </h2>
            {d.mine.last ? (
              <>
                <p class="meta">
                  {formatDateTime(d.mine.last.at)} ·{' '}
                  {d.mine.last.how === 'model' ? 'написан моделью' : 'собран по шаблону (модель не ответила)'}
                </p>
                <p class="digest-text">{d.mine.last.text}</p>
              </>
            ) : (
              <p class="section-lead">
                Пока не было. Нажмите «Сделать сейчас» или дождитесь утра ({d.settings.time}).
              </p>
            )}
            <div class="action-row">
              <button
                type="button"
                class="button button--primary"
                disabled={busy}
                onClick={() => void run(() => apiPost('/api/digest/mine/now', {}), 'Дайджест готов.')}
              >
                <RefreshCw size={18} aria-hidden="true" />
                Сделать сейчас
              </button>
            </div>
          </section>

          <section class="page-section" aria-labelledby={`${ids}-mine`}>
            <h2 id={`${ids}-mine`} class="section-title">
              Для меня
            </h2>
            <label class="check">
              <input
                type="checkbox"
                checked={d.mine.enabled}
                disabled={busy}
                onChange={(e) =>
                  void run(
                    () => apiPost('/api/digest/mine', { enabled: e.currentTarget.checked }),
                    e.currentTarget.checked ? 'Дайджест включён.' : 'Дайджест выключен.',
                  )
                }
              />
              Присылать мне дайджест каждое утро ({d.settings.time})
            </label>
            <p class="meta">
              Город, интересы и привязка Telegram — в разделе «Мой профиль» (вкладка «Профиль»). Бот присылает
              дайджест туда, куда вы его привязали.
            </p>
          </section>

          {d.isAdmin ? (
            <section class="page-section" aria-labelledby={`${ids}-adm`}>
              <h2 id={`${ids}-adm`} class="section-title">
                Для администратора
              </h2>
              <label class="check">
                <input
                  type="checkbox"
                  checked={d.settings.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    void run(
                      () => apiPost('/api/admin/digest/settings', { enabled: e.currentTarget.checked }),
                      'Сохранено.',
                    )
                  }
                />
                Рассылка включена
              </label>
              <label class="field__label" htmlFor={`${ids}-time`}>
                Время рассылки
              </label>
              <input
                id={`${ids}-time`}
                class="field__input"
                type="time"
                value={d.settings.time}
                disabled={busy}
                onChange={(e) =>
                  void run(
                    () => apiPost('/api/admin/digest/settings', { time: e.currentTarget.value }),
                    'Время сохранено.',
                  )
                }
              />
              <label class="field__label" htmlFor={`${ids}-city`}>
                Город для погоды {d.settings.city ? `(сейчас: ${d.settings.city})` : '(не задан)'}
              </label>
              <input
                id={`${ids}-city`}
                class="field__input"
                placeholder="Например: Москва"
                value={city ?? ''}
                onInput={(e) => setCity(e.currentTarget.value)}
              />
              <div class="action-row">
                <button
                  type="button"
                  class="button button--secondary"
                  disabled={busy || city === null}
                  onClick={() =>
                    void run(
                      () => apiPost('/api/admin/digest/settings', { city: city ?? '' }),
                      'Город сохранён.',
                    )
                  }
                >
                  Сохранить город
                </button>
              </div>
              <label class="check">
                <input
                  type="checkbox"
                  checked={d.settings.currency}
                  disabled={busy}
                  onChange={(e) =>
                    void run(
                      () => apiPost('/api/admin/digest/settings', { currency: e.currentTarget.checked }),
                      'Сохранено.',
                    )
                  }
                />
                Курсы валют Центробанка
              </label>
              <p class="meta">
                Ночью для рассылки запускается большая модель на несколько минут (около 4 ГБ памяти); днём
                «Сделать сейчас» использует быструю. Погода и курсы берутся из открытых источников; о семье
                туда ничего не уходит.
              </p>
              <div class="action-row">
                <button
                  type="button"
                  class="button button--secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => apiPost('/api/admin/digest/run', {}),
                      'Рассылка запущена: дайджесты появятся через несколько минут.',
                    )
                  }
                >
                  Разослать всем сейчас
                </button>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
      <ToastRegion toast={toast} />
    </div>
  );
}
