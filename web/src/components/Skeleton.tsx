import type { ComponentChildren } from 'preact';

/** Placeholder shape while data loads (static when reduced motion is requested). */
export function Skeleton(props: { kind?: 'line' | 'short' | 'badge' | 'block' | 'tile' }) {
  return <span class={`skeleton skeleton--${props.kind ?? 'line'}`} aria-hidden="true" />;
}

/** A loading region: announces «Загружаем…» to screen readers and shows placeholder shapes. */
export function Loading(props: { label?: string; children?: ComponentChildren }) {
  return (
    <div class="loading" aria-busy="true">
      <span class="visually-hidden">{props.label ?? 'Загружаем данные…'}</span>
      {props.children ?? (
        <>
          <Skeleton kind="block" />
          <Skeleton kind="line" />
          <Skeleton kind="short" />
        </>
      )}
    </div>
  );
}
