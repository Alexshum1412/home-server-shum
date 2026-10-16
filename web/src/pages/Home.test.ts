import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServicesResponse, VolumeInfo } from '../../../shared/api.ts';
import { byClass, byTag, installDocument, type Mounted, mount, textOf } from '../testing/dom.ts';
import {
  failure,
  NOW_ISO,
  polling,
  service,
  servicesResponse,
  systemResponse,
  withProviders,
} from '../testing/fixtures.ts';
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

/** Text of the service card (or cinema screen) whose heading contains `name`. */
function card(root: Mounted['container'], name: string): string {
  const found = byTag(root, 'li').find((item) => textOf(byTag(item, 'h3')[0] ?? item).includes(name));
  if (!found) throw new Error(`No card «${name}» in: ${textOf(root)}`);
  return textOf(found);
}

function statusRow(root: Mounted['container'], label: string) {
  const row = byClass(root, 'status-row').find((item) => textOf(item).startsWith(label));
  if (!row) throw new Error(`No status row «${label}»`);
  return row;
}

const servicesFailed = polling<ServicesResponse>(null, { error: failure() });

describe('home page: service cards', () => {
  it('shows «Нет данных» instead of endless skeletons when the service list never loaded', async () => {
    view = await mount(withProviders(h(HomePage, {}), { services: servicesFailed }));
    const cards = byClass(view.container, 'card');
    expect(cards.length).toBe(5);
    for (const name of ['Фото', 'Файлы', 'Загрузки', 'Календарь']) {
      expect(card(view.container, name)).toContain('Нет данных');
    }
    for (const item of cards) expect(byClass(item, 'skeleton')).toEqual([]);
  });

  it('keeps skeletons only while the first load is still running', async () => {
    view = await mount(
      withProviders(h(HomePage, {}), { services: polling<ServicesResponse>(null, { loading: true }) }),
    );
    expect(card(view.container, 'Фото')).not.toContain('Нет данных');
    expect(byClass(byClass(view.container, 'card')[0] ?? view.container, 'skeleton').length).toBe(1);
  });

  const broken = servicesResponse([
    service({
      kind: 'photos',
      name: 'Фото',
      state: 'degraded',
      message: 'Сервис отвечает с ошибкой',
      detail: 'HTTP 503',
    }),
    service({
      kind: 'media',
      name: 'Кинотеатр',
      state: 'offline',
      message: 'Не отвечает',
      detail: 'ECONNREFUSED',
    }),
  ]);

  it('shows the technical detail of a check to administrators', async () => {
    view = await mount(withProviders(h(HomePage, {}), { role: 'admin', services: polling(broken) }));
    expect(card(view.container, 'Фото')).toContain('Подробности: HTTP 503');
    expect(textOf(view.container)).toContain('Подробности: ECONNREFUSED');
  });

  it('never shows the technical detail to the family, even if the server sent it', async () => {
    view = await mount(withProviders(h(HomePage, {}), { role: 'family', services: polling(broken) }));
    expect(textOf(view.container)).not.toContain('HTTP 503');
    expect(textOf(view.container)).not.toContain('ECONNREFUSED');
    expect(byClass(view.container, 'tech-detail')).toEqual([]);
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
    view = await mount(withProviders(h(HomePage, {}), { system: polling(system) }));
    const row = textOf(statusRow(view.container, 'Место на диске'));
    expect(row).toContain('Мало места');
    expect(row).toContain('D:\\');
    expect(row).not.toContain('Места достаточно');
  });
});

describe('home page: order of the cinema and the alerts', () => {
  /** Position in the rendered text: the cinema title vs the first alert title. */
  function order(root: Mounted['container'], alertTitle: string): 'cinema-first' | 'alerts-first' {
    const text = textOf(root);
    const cinema = text.indexOf('Кинотеатр');
    const alert = text.indexOf(alertTitle);
    if (cinema < 0 || alert < 0) throw new Error(`Missing cinema or alert in: ${text}`);
    return cinema < alert ? 'cinema-first' : 'alerts-first';
  }

  it('keeps the cinema above ordinary warnings', async () => {
    const system = polling(
      systemResponse({
        alerts: [{ id: 'b', level: 'warning', title: 'Резервные копии не настроены', text: 'x' }],
      }),
    );
    view = await mount(withProviders(h(HomePage, {}), { system }));
    expect(order(view.container, 'Резервные копии не настроены')).toBe('cinema-first');
  });

  it('puts critical problems above the cinema', async () => {
    const system = polling(
      systemResponse({ alerts: [{ id: 'd', level: 'critical', title: 'Диск почти заполнен', text: 'x' }] }),
    );
    view = await mount(withProviders(h(HomePage, {}), { system }));
    expect(order(view.container, 'Диск почти заполнен')).toBe('alerts-first');
  });
});
