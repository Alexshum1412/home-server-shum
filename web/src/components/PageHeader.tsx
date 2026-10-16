import type { ComponentChildren } from 'preact';
import type { IconComponent } from './icons.ts';

/** Page title (the h1 receives focus after navigation) with an optional icon and lead paragraph. */
export function PageHeader(props: {
  title: string;
  icon?: IconComponent;
  lead?: ComponentChildren;
  children?: ComponentChildren;
}) {
  const Icon = props.icon;
  return (
    <div class="page-header">
      <div class="page-header__row">
        {Icon ? (
          <span class="page-header__icon">
            <Icon size={24} aria-hidden="true" />
          </span>
        ) : null}
        <h1 class="page-header__title" tabIndex={-1}>
          {props.title}
        </h1>
      </div>
      {props.lead ? <p class="page-header__lead">{props.lead}</p> : null}
      {props.children}
    </div>
  );
}
