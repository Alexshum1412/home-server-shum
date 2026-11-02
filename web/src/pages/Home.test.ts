import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeInfo } from '../../../shared/api.ts';
import { byClass, installDocument, type Mounted, mount, textOf } from '../testing/dom.ts';
import { NOW_ISO, polling, systemResponse, withProviders } from '../testing/fixtures.ts';
import { HomePage } from './Home.tsx';

let view: Mounted | null = null;

beforeEach(() => {
  installDocument();
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

function statusRow(root: Mounted['container'], label: string) {
  const row = byClass(root, 'status-row').find((item) => textOf(item).startsWith(label));
  if (!row) throw new Error(`No status row «${label}»`);
  return row;
}

describe('home page: the big buttons', () => {
  it('shows the sections as big buttons, and the house status only to the administrator', async () => {
    view = await mount(withProviders(h(HomePage, {}), { role: 'family' }));
    const text = textOf(view.container);
    for (const name of ['Чат', 'Дела', 'Медиа', 'Память', 'Загрузки']) expect(text).toContain(name);
    expect(byClass(view.container, 'status-row')).toEqual([]);
    await view.unmount();
    view = await mount(withProviders(h(HomePage, {}), { role: 'admin' }));
    expect(byClass(view.container, 'status-row').length).toBeGreaterThan(0);
  });
});

describe('home page: disk row', () => {
  const volume = (overrides: Partial<VolumeInfo>): VolumeInfo => ({
    path: 'C:\\',
    totalBytes: 100 * 1024 ** 3,
    freeBytes: 60 * 1024 ** 3,
    collectedAt: NOW_ISO,
    reason: null,
    lowSpace: false,
    ...overrides,
  });

  it('reports low space on the second disk, not just the first one', async () => {
    const system = systemResponse({
      volumes: [volume({ path: 'C:\\' }), volume({ path: 'D:\\', freeBytes: 5 * 1024 ** 3, lowSpace: true })],
    });
    view = await mount(withProviders(h(HomePage, {}), { role: 'admin', system: polling(system) }));
    const row = textOf(statusRow(view.container, 'Место на диске'));
    expect(row).toContain('Мало места');
    expect(row).toContain('D:\\');
    expect(row).not.toContain('Места достаточно');
  });
});

describe('home page: alerts', () => {
  /** Position in the rendered text: the alert title vs the big buttons. */
  function order(root: Mounted['container'], alertTitle: string): 'tiles-first' | 'alerts-first' {
    const text = textOf(root);
    const tiles = text.indexOf('Переписка с семьёй');
    const alert = text.indexOf(alertTitle);
    if (tiles < 0 || alert < 0) throw new Error(`Missing tiles or alert in: ${text}`);
    return tiles < alert ? 'tiles-first' : 'alerts-first';
  }

  it('shows the warnings above the big buttons', async () => {
    const system = polling(
      systemResponse({
        alerts: [{ id: 'b', level: 'warning', title: 'Резервные копии не настроены', text: 'x' }],
      }),
    );
    view = await mount(withProviders(h(HomePage, {}), { system }));
    expect(order(view.container, 'Резервные копии не настроены')).toBe('alerts-first');
  });

  it('shows the critical problems above the big buttons too', async () => {
    const system = polling(
      systemResponse({ alerts: [{ id: 'd', level: 'critical', title: 'Диск почти заполнен', text: 'x' }] }),
    );
    view = await mount(withProviders(h(HomePage, {}), { system }));
    expect(order(view.container, 'Диск почти заполнен')).toBe('alerts-first');
  });
});
