import type { QuotaState } from '../../../shared/storage-extras.ts';
import { formatBytes } from '../lib/format.ts';

/** How full the person's own space is — a quiet line while there is room, a warning from 90 %, a stop at 100 %. */
export function QuotaNote(props: { quota: QuotaState | null | undefined }) {
  const { quota } = props;
  if (!quota) return null;
  const share = Math.min(100, Math.round((quota.usedBytes / Math.max(1, quota.limitBytes)) * 100));
  const text = `Занято ${formatBytes(quota.usedBytes)} из ${formatBytes(quota.limitBytes)} (${share} %).`;
  if (quota.level === 'ok') return <p class="meta quota-note">{text}</p>;
  if (quota.level === 'warn') {
    return (
      <p class="banner banner--warn quota-note" role="status">
        {text} Место скоро закончится: уберите ненужное в корзину или попросите администратора увеличить его.
      </p>
    );
  }
  return (
    <p class="banner banner--bad quota-note" role="alert">
      {text} Место закончилось: новые файлы не принимаются. Уберите ненужное в корзину или попросите
      администратора увеличить место.
    </p>
  );
}
