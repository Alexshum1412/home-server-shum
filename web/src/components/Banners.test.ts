import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServicesResponse, SystemResponse } from '../../../shared/api.ts';
import { NO_CONNECTION } from '../api.ts';
import type { PollingResult } from '../hooks/usePolling.ts';
import {
  byRole,
  byTag,
  click,
  type FakeElement,
  getButton,
  installDocument,
  type Mounted,
  mount,
  textOf,
} from '../testing/dom.ts';
import { failure, polling, servicesResponse, systemResponse, withProviders } from '../testing/fixtures.ts';
import { ConnectionBanner } from './Banners.tsx';

let view: Mounted | null = null;

beforeEach(() => {
  installDocument();
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

function render(system: PollingResult<SystemResponse>, refreshAll = vi.fn()) {
  const services = polling<ServicesResponse>(servicesResponse([]));
  return withProviders(h(ConnectionBanner, {}), { system, services, refreshAll });
}

function liveRegion(root: FakeElement): FakeElement {
  const regions = byRole(root, 'status');
  expect(regions.length).toBe(1);
  return regions[0] as FakeElement;
}

const offline = (overrides: Partial<PollingResult<SystemResponse>> = {}) =>
  polling(systemResponse(), { error: failure(true), ...overrides });

describe('connection banner', () => {
  it('keeps an empty live region in the page while everything works', async () => {
    view = await mount(render(polling(systemResponse())));
    expect(textOf(liveRegion(view.container))).toBe('');
  });

  it('puts only the stable title into the live region', async () => {
    view = await mount(render(offline()));
    const region = liveRegion(view.container);
    expect(textOf(region)).toBe(NO_CONNECTION);
    // The age of the data and the button change on every poll: they must stay outside.
    expect(byTag(region, 'time')).toEqual([]);
    expect(byTag(region, 'button')).toEqual([]);
    expect(textOf(view.container)).toContain('Показаны данные, полученные');
  });

  it('reuses the same live region element when the failure appears', async () => {
    view = await mount(render(polling(systemResponse())));
    const before = liveRegion(view.container);
    await view.update(render(offline()));
    expect(liveRegion(view.container)).toBe(before);
    expect(textOf(before)).toBe(NO_CONNECTION);
  });

  it('does not flip the button to «Проверяем…» during background polls', async () => {
    view = await mount(render(offline()));
    await view.update(render(offline({ loading: true })));
    const button = getButton(view.container, 'Повторить');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(textOf(view.container)).not.toContain('Проверяем');
  });

  it('shows «Проверяем…» after a manual retry until the check finishes', async () => {
    const refreshAll = vi.fn();
    view = await mount(render(offline(), refreshAll));
    await click(getButton(view.container, 'Повторить'));
    expect(refreshAll).toHaveBeenCalledTimes(1);
    await view.update(render(offline({ loading: true }), refreshAll));
    expect(getButton(view.container, 'Проверяем…').hasAttribute('disabled')).toBe(true);
    await view.update(render(offline(), refreshAll));
    expect(getButton(view.container, 'Повторить').hasAttribute('disabled')).toBe(false);
    // A later background poll does not bring the busy label back.
    await view.update(render(offline({ loading: true }), refreshAll));
    expect(textOf(view.container)).not.toContain('Проверяем');
  });
});
