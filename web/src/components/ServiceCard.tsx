import { ExternalLink } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import type { StatusView } from '../lib/labels.ts';
import type { IconComponent } from './icons.ts';
import { Skeleton } from './Skeleton.tsx';
import { StatusBadge } from './StatusBadge.tsx';
import { TechDetail } from './TechDetail.tsx';

interface ServiceCardProps {
  name: string;
  icon: IconComponent;
  /** null while the first status is loading. */
  status: StatusView | null;
  text?: ComponentChildren;
  /** Technical detail for administrators (e.g. «HTTP 503»); pass null for the family. */
  detail?: string | null;
  /** In-app page or external URL; the whole card becomes the link target. */
  href?: string | null;
  external?: boolean;
}

/** Home page card: the whole card is one large touch target (stretched link). */
export function ServiceCard(props: ServiceCardProps) {
  const Icon = props.icon;
  const title = props.href ? (
    <a
      class="card__link"
      href={props.href}
      target={props.external ? '_blank' : undefined}
      rel={props.external ? 'noopener noreferrer' : undefined}
    >
      {props.name}
      {props.external ? (
        <>
          <ExternalLink class="card__external" size={16} aria-hidden="true" />
          <span class="visually-hidden"> (откроется в новой вкладке)</span>
        </>
      ) : null}
    </a>
  ) : (
    props.name
  );
  return (
    <li class={props.href ? 'card card--link' : 'card'}>
      <div class="card__head">
        <span class="card__icon">
          <Icon size={22} aria-hidden="true" />
        </span>
        <h3 class="card__title">{title}</h3>
      </div>
      {props.status ? <StatusBadge status={props.status} /> : <Skeleton kind="badge" />}
      {props.text ? <p class="card__text">{props.text}</p> : null}
      <TechDetail detail={props.detail ?? null} />
    </li>
  );
}
