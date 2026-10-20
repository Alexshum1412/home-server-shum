import { CircleAlert, CircleCheck, CircleHelp, HeartPulse, TriangleAlert } from 'lucide-preact';
import type { FamilyStatusResponse, StatusLevel } from '../../../shared/extras.ts';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Loading } from '../components/Skeleton.tsx';
import { usePolling } from '../hooks/usePolling.ts';
import { formatDateTime } from '../lib/format.ts';
import { navigate } from '../router.ts';
import { useIsAdmin } from '../state.tsx';

const ICON = { ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert, unknown: CircleHelp } as const;
const WORD: Record<StatusLevel, string> = {
  ok: 'в порядке',
  warn: 'есть замечание',
  bad: 'неполадка',
  unknown: 'нет сведений',
};

/** «Что с сервером»: the family's version in plain lines (the administrator's details are on «Безопасность»). */
export function StatusPage() {
  const status = usePolling<FamilyStatusResponse>('/api/status', 30_000);
  const isAdmin = useIsAdmin();
  const d = status.data;
  return (
    <div class="page">
      <PageHeader
        title="Что с сервером"
        icon={HeartPulse}
        lead="Коротко: работает ли то, чем вы пользуетесь. Подробности — у администратора."
      />
      {status.error && !d ? (
        <ErrorState failure={status.error} onRetry={() => undefined} busy={status.loading} level={3} />
      ) : null}
      {!d && !status.error ? <Loading label="Проверяем…" /> : null}
      {d ? (
        <>
          <p
            class={`banner banner--${d.level === 'ok' ? 'ok' : d.level === 'bad' ? 'bad' : 'warn'}`}
            role="status"
          >
            <strong>{d.headline}.</strong> Проверено {formatDateTime(d.generatedAt)}.
          </p>
          <ul class="status-list">
            {d.items.map((item) => {
              const Icon = ICON[item.level];
              return (
                <li key={item.id} class={`status-list__item status-list__item--${item.level}`}>
                  <Icon size={22} aria-hidden="true" />
                  <span>
                    <strong>{item.title}</strong> — {item.text}{' '}
                    <span class="visually-hidden">({WORD[item.level]})</span>
                  </span>
                </li>
              );
            })}
          </ul>
          {isAdmin ? (
            <div class="action-row">
              <button type="button" class="button button--secondary" onClick={() => navigate('/safety')}>
                Безопасность и журнал происшествий
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
