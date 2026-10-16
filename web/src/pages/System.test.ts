import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupInfo } from '../../../shared/api.ts';
import {
  byClass,
  byTag,
  type FakeElement,
  installDocument,
  type Mounted,
  mount,
  textOf,
} from '../testing/dom.ts';
import { NOW_ISO, polling, systemResponse, withProviders } from '../testing/fixtures.ts';
import { SystemPage } from './System.tsx';

let view: Mounted | null = null;

beforeEach(() => {
  installDocument();
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

function tile(root: FakeElement, title: string): FakeElement {
  const found = byClass(root, 'tile').find((item) => textOf(byTag(item, 'h3')[0] ?? item) === title);
  if (!found) throw new Error(`No tile «${title}»`);
  return found;
}

/** «dt: dd» pairs of a tile's facts list. */
function facts(element: FakeElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of byClass(element, 'facts__row')) {
    result[textOf(byTag(row, 'dt')[0] ?? row)] = textOf(byTag(row, 'dd')[0] ?? row);
  }
  return result;
}

async function renderSystem(overrides: Parameters<typeof systemResponse>[0] = {}) {
  view = await mount(
    withProviders(h(SystemPage, {}), { role: 'admin', system: polling(systemResponse(overrides)) }),
  );
  return view.container;
}

describe('system page: never-measured values', () => {
  it('shows the temperature reason without promising a measurement', async () => {
    const root = await renderSystem();
    const temperature = tile(root, 'Температура');
    expect(textOf(temperature)).toContain('Нет данных');
    expect(textOf(temperature)).toContain('Датчик температуры недоступен');
    expect(byClass(temperature, 'tile__footer')).toEqual([]);
    expect(textOf(root)).not.toContain('Ещё не измерялось');
  });

  it('keeps «Обновлено …» for measured values', async () => {
    const root = await renderSystem();
    expect(textOf(byClass(tile(root, 'Процессор'), 'tile__footer')[0] ?? root)).toContain('Обновлено');
  });

  it('drops the footer of other values that were never collected (Tailscale, printer, disks)', async () => {
    const root = await renderSystem({
      tailscale: {
        state: 'unknown',
        dnsName: null,
        peersOnline: null,
        version: null,
        collectedAt: null,
        reason: 'Ещё не проверено',
      },
    });
    expect(byClass(tile(root, 'Удалённый доступ'), 'tile__footer')).toEqual([]);
    expect(byClass(tile(root, 'Принтер'), 'tile__footer')).toEqual([]);
    expect(textOf(root)).not.toContain('Ещё не измерялось');
  });
});

describe('system page: backups', () => {
  const backup = (overrides: Partial<BackupInfo>): BackupInfo => ({
    state: 'unknown',
    lastSuccessAt: null,
    restoreTested: false,
    message: 'Состояние резервного копирования ещё не проверено',
    ...overrides,
  });

  it('does not present an unknown backup state as «never» / «not tested»', async () => {
    const root = await renderSystem({ backup: backup({ state: 'unknown' }) });
    expect(facts(tile(root, 'Резервные копии'))).toEqual({
      'Последняя удачная копия': 'Нет данных',
      'Восстановление проверено': 'Нет данных',
    });
  });

  it('states the facts once the state is known', async () => {
    const root = await renderSystem({ backup: backup({ state: 'not_configured', message: 'Не настроены' }) });
    expect(facts(tile(root, 'Резервные копии'))).toEqual({
      'Последняя удачная копия': 'Не было',
      'Восстановление проверено': 'Нет',
    });
  });

  it('shows a real date and a real check', async () => {
    const root = await renderSystem({
      backup: backup({ state: 'ok', lastSuccessAt: NOW_ISO, restoreTested: true, message: 'В порядке' }),
    });
    const values = facts(tile(root, 'Резервные копии'));
    expect(values['Последняя удачная копия']).not.toBe('Нет данных');
    expect(values['Последняя удачная копия']).not.toBe('Не было');
    expect(values['Восстановление проверено']).toBe('Да');
  });
});
