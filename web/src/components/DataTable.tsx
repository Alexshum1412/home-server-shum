import type { ComponentChildren } from 'preact';

/**
 * Scroll container for wide tables: on narrow screens the table scrolls inside it,
 * never the page. Focusable and labelled so keyboard users can scroll it too.
 */
export function TableWrap(props: { labelledBy: string; children: ComponentChildren }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable from the keyboard
    <section class="table-wrap" aria-labelledby={props.labelledBy} tabIndex={0}>
      {props.children}
    </section>
  );
}
