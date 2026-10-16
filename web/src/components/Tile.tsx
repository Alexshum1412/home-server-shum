import type { ComponentChildren } from 'preact';
import type { StatusView } from '../lib/labels.ts';
import type { IconComponent } from './icons.ts';
import { StatusBadge } from './StatusBadge.tsx';

interface TileProps {
  title: string;
  icon?: IconComponent;
  status?: StatusView | null;
  /** Heading level inside the page outline. */
  level?: 2 | 3;
  wide?: boolean;
  children?: ComponentChildren;
  footer?: ComponentChildren;
}

/** A quiet panel with a heading, an optional status badge, content and a footer line. */
export function Tile(props: TileProps) {
  const Heading = props.level === 3 ? 'h3' : 'h2';
  const Icon = props.icon;
  return (
    <div class={props.wide ? 'tile tile--wide' : 'tile'}>
      <div class="tile__head">
        {Icon ? <Icon class="tile__icon" size={20} aria-hidden="true" /> : null}
        <Heading class="tile__title">{props.title}</Heading>
        {props.status ? <StatusBadge status={props.status} /> : null}
      </div>
      <div class="tile__body">{props.children}</div>
      {props.footer ? <div class="tile__footer">{props.footer}</div> : null}
    </div>
  );
}

/**
 * A big value with a caption. `value === null` is rendered as «Нет данных»
 * with the reason as secondary text — never as 0.
 */
export function Metric(props: { value: string | null; caption?: ComponentChildren; reason?: string | null }) {
  if (props.value === null) {
    return (
      <div class="metric">
        <p class="metric__value metric__value--empty">Нет данных</p>
        {props.reason ? <p class="metric__caption">{props.reason}</p> : null}
      </div>
    );
  }
  return (
    <div class="metric">
      <p class="metric__value">{props.value}</p>
      {props.caption ? <p class="metric__caption">{props.caption}</p> : null}
    </div>
  );
}
