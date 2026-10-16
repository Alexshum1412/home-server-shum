import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDocument, type Mounted, mount, textOf } from '../testing/dom.ts';
import { polling, service, servicesResponse, systemResponse, withProviders } from '../testing/fixtures.ts';
import { AppShell } from './AppShell.tsx';

let view: Mounted | null = null;

beforeEach(() => {
  installDocument();
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

const shell = () => h(AppShell, { path: '/', children: h('h1', {}, 'Главная') });

describe('demo banner', () => {
  it('is absent in real mode', async () => {
    view = await mount(withProviders(shell()));
    expect(textOf(view.container)).not.toContain('Демо-режим');
  });

  it('follows the session flag read at start-up', async () => {
    view = await mount(withProviders(shell(), { demo: true }));
    expect(textOf(view.container)).toContain('Демо-режим');
  });

  it('appears when the system data says demo, even if the session did not', async () => {
    view = await mount(withProviders(shell(), { system: polling(systemResponse({ demo: true })) }));
    expect(textOf(view.container)).toContain('Демо-режим');
  });

  it('appears when any service is marked as demo', async () => {
    const services = polling(servicesResponse([service({ kind: 'media', state: 'online', demo: true })]));
    view = await mount(withProviders(shell(), { services }));
    expect(textOf(view.container)).toContain('Демо-режим');
  });
});
