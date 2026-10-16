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

/**
 * «Обновлено 2 мин назад». Nothing for a value that was never measured: its reason is shown
 * next to it, and «ещё не измерялось» would wrongly promise a measurement (e.g. no sensor at all).
 */
export function UpdatedAt(props: { value: string | number | null | undefined; prefix?: string }) {
  if (props.value == null) return null;
  return (
    <p class="meta">
      {props.prefix ?? 'Обновлено'} <RelativeTime value={props.value} />
    </p>
  );
}
