import { formatPercent } from '../lib/format.ts';
import type { Tone } from '../lib/labels.ts';

/** Usage bar (native <meter>, 0–100). Renders nothing when the value is unknown. */
export function Meter(props: { value: number | null; label: string; tone?: Tone }) {
  if (props.value == null || !Number.isFinite(props.value)) return null;
  const value = Math.min(100, Math.max(0, props.value));
  return (
    <meter
      class={`meter meter--${props.tone ?? 'neutral'}`}
      min={0}
      max={100}
      value={value}
      aria-label={props.label}
    >
      {formatPercent(value)}
    </meter>
  );
}

/** Tone for a load/usage percentage: calm until it gets high. */
export function usageTone(percent: number | null, warnAt = 90): Tone {
  return percent != null && percent >= warnAt ? 'warn' : 'neutral';
}
