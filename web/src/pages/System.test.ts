import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupInfo, SystemResponse } from '../../../shared/api.ts';
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

describe('system page: hardware details (administrator)', () => {
  const NOTHING = { value: null, collectedAt: null, source: 's', reason: 'нет' };
  const hardware = (over: Partial<NonNullable<SystemResponse['hardware']>> = {}) => ({
    cpuCores: { value: [12, 80, 3.5, 0], collectedAt: NOW_ISO, source: 's', reason: null },
    cpuClock: { value: { currentMhz: 2712, maxMhz: 2712 }, collectedAt: NOW_ISO, source: 's', reason: null },
    cpuTemperatureC: {
      ...NOTHING,
      reason: 'Температуру процессора Windows не сообщает. Нужна LibreHardwareMonitor.',
    },
    boardTemperatureC: { value: 29.9, collectedAt: NOW_ISO, source: 's', reason: null },
    gpu: {
      value: [
        {
          name: 'NVIDIA GeForce GTX 960',
          loadPercent: 31,
          memoryUsedBytes: 1194 * 1024 ** 2,
          memoryTotalBytes: 2048 * 1024 ** 2,
          temperatureC: 39,
          powerWatts: 19,
          fanPercent: 0,
          driver: '560.94',
        },
      ],
      collectedAt: NOW_ISO,
      source: 's',
      reason: null,
    },
    network: {
      value: [
        {
          name: 'Ethernet',
          description: 'Realtek',
          physical: true,
          linkSpeedMbps: 1000,
          rxBytesPerSec: 125_000,
          txBytesPerSec: null,
          rxTotalBytes: 2_500_000_000,
          txTotalBytes: 400_000_000,
        },
      ],
      collectedAt: NOW_ISO,
      source: 's',
      reason: null,
    },
    diskReliability: {
      value: [
        {
          model: 'ST_M13FQBL',
          temperatureC: null,
          wearPercent: null,
          readErrors: null,
          writeErrors: null,
          powerOnHours: null,
          note: null,
        },
      ],
      collectedAt: NOW_ISO,
      source: 's',
      reason: null,
    },
    ...over,
  });

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ intervalSec: 60, points: [] }), { status: 200 })),
    );
  });

  it('shows what is measured and says «Недоступно» for the rest, never a zero', async () => {
    const root = await renderSystem({ hardware: hardware() });
    const text = textOf(root);
    expect(text).toContain('Оборудование');
    expect(byClass(tile(root, 'Ядра процессора'), 'core-list__item')).toHaveLength(4);
    expect(text).toContain('2 712 МГц');
    expect(facts(tile(root, 'Видеокарта'))['Видеопамять']).toContain('из');
    const temperatures = facts(tile(root, 'Температуры'));
    expect(temperatures['Процессор']).toBe('Недоступно');
    expect(temperatures['Видеокарта']).toBe('39 °C');
    expect(temperatures['Плата (зона ACPI)']).toBe('29,9 °C');
    expect(text).toContain('Недоступно');
    expect(text).not.toContain('0 °C');
  });

  it('explains a missing video card instead of showing zeros', async () => {
    const root = await renderSystem({
      hardware: hardware({
        gpu: { ...NOTHING, reason: 'Драйвер NVIDIA (nvidia-smi) не найден' },
      }),
    });
    expect(textOf(tile(root, 'Видеокарта'))).toContain('Драйвер NVIDIA (nvidia-smi) не найден');
  });

  it('is not shown to the family', async () => {
    view = await mount(
      withProviders(h(SystemPage, {}), {
        role: 'family',
        system: polling(systemResponse({ hardware: null })),
      }),
    );
    expect(textOf(view.container)).not.toContain('Оборудование');
  });
});
