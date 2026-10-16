import { useNow } from '../hooks/useNow.ts';
import { formatDateTime, formatRelative, NO_DATA } from '../lib/format.ts';

/** «2 мин назад» in a <time> element; the exact time is in the tooltip and datetime attribute. */
export function RelativeTime(props: { value: string | number | null | undefined }) {
  const now = useNow();
  const { value } = props;
  if (value == null) return <span>{NO_DATA}</span>;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return <span>{NO_DATA}</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={formatDateTime(ms, now)}>
      {formatRelative(ms, now)}
    </time>
  );
}

/** «Обновлено 2 мин назад» / «Ещё не измерялось». */
export function UpdatedAt(props: { value: string | number | null | undefined; prefix?: string }) {
  if (props.value == null) return <p class="meta">Ещё не измерялось</p>;
  return (
    <p class="meta">
      {props.prefix ?? 'Обновлено'} <RelativeTime value={props.value} />
    </p>
  );
}
