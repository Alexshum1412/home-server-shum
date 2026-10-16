import type { StatusView } from '../lib/labels.ts';
import { STATUS_ICONS } from './icons.ts';

/** A state as «icon + word» on a tinted pill; colour is only a third cue. */
export function StatusBadge(props: { status: StatusView; label?: string }) {
  const { status } = props;
  const Icon = STATUS_ICONS[status.icon];
  return (
    <span class={`badge badge--${status.tone}`}>
      <Icon class="badge__icon" size={16} strokeWidth={2.25} aria-hidden="true" />
      <span>{props.label ?? status.label}</span>
    </span>
  );
}
