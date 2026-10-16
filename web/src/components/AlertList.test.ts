import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alert } from '../../../shared/api.ts';
import { byTag, click, getButton, installDocument, type Mounted, mount, textOf } from '../testing/dom.ts';
import { AlertList } from './AlertList.tsx';

let view: Mounted | null = null;

beforeEach(() => {
  installDocument();
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

const LONG =
  'Фотографии и документы на домашнем сервере пока хранятся в одном экземпляре — копии нет. Если диск выйдет из строя, их не удастся восстановить.';

const alert = (id: string, level: Alert['level'], text = LONG): Alert => ({
  id,
  level,
  title: `Сообщение ${id}`,
  text,
});

function items(): ReturnType<typeof byTag> {
  return byTag(view?.container as Parameters<typeof byTag>[0], 'li');
}

describe('alert list', () => {
  it('shows the full text of every alert when not compact', async () => {
    view = await mount(h(AlertList, { alerts: [alert('a', 'warning')] }));
    expect(textOf(view.container)).toContain(LONG);
    expect(byTag(view.container, 'button')).toEqual([]);
  });

  it('lets a long warning be collapsed on phones and expanded with a button', async () => {
    view = await mount(h(AlertList, { alerts: [alert('a', 'warning')], compact: true }));
    const item = items()[0];
    expect(item?.getAttribute('class')).toContain('alert--clampable');
    expect(item?.getAttribute('class')).not.toContain('alert--expanded');
    // The full text stays in the page (screen readers read it); only the visual height is limited.
    expect(textOf(view.container)).toContain(LONG);

    const more = getButton(view.container, 'Подробнее');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await click(more);
    expect(items()[0]?.getAttribute('class')).toContain('alert--expanded');
    expect(getButton(view.container, 'Свернуть').getAttribute('aria-expanded')).toBe('true');
  });

  it('never collapses critical alerts or short texts', async () => {
    view = await mount(
      h(AlertList, {
        alerts: [alert('c', 'critical'), alert('s', 'warning', 'Коротко и ясно.')],
        compact: true,
      }),
    );
    for (const item of items()) expect(item.getAttribute('class')).not.toContain('alert--clampable');
    expect(byTag(view.container, 'button')).toEqual([]);
  });
});
