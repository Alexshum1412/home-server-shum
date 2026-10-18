import { Users } from 'lucide-preact';
import { hueOf, initials } from './format.ts';

/** A round badge with the person's initials; each person keeps their own colour. */
export function Avatar(props: {
  id: string;
  name: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  group?: boolean;
}) {
  return (
    <span
      class={`avatar avatar--${props.size ?? 'md'}`}
      style={{ '--avatar-hue': String(hueOf(props.id)) }}
      aria-hidden="true"
    >
      {props.group ? <Users size={20} aria-hidden="true" /> : initials(props.name)}
    </span>
  );
}
