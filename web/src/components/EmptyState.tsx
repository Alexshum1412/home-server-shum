import type { ComponentChildren } from 'preact';
import type { IconComponent } from './icons.ts';

/** An empty or unavailable view: what is here, why it is empty, what to do next. */
export function EmptyState(props: {
  icon: IconComponent;
  title: string;
  level?: 2 | 3;
  children?: ComponentChildren;
  actions?: ComponentChildren;
}) {
  const Icon = props.icon;
  const Heading = props.level === 3 ? 'h3' : 'h2';
  return (
    <div class="empty">
      <span class="empty__icon">
        <Icon size={24} aria-hidden="true" />
      </span>
      <Heading class="empty__title">{props.title}</Heading>
      {props.children ? <div class="empty__text">{props.children}</div> : null}
      {props.actions ? <div class="empty__actions">{props.actions}</div> : null}
    </div>
  );
}
