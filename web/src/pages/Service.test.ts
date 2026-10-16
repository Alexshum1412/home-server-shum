import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, ServiceStatus } from '../../../shared/api.ts';
import { SERVICE_PAGES } from '../lib/labels.ts';
import { installDocument, type Mounted, mount, textOf } from '../testing/dom.ts';
import { polling, service, servicesResponse, withProviders } from '../testing/fixtures.ts';
import { ServicePage } from './Service.tsx';

let view: Mounted | null = null;

beforeEach(() => {
  installDocument();
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

async function renderPhotos(item: ServiceStatus | null, role: Role = 'family'): Promise<string> {
  const services = polling(servicesResponse(item ? [item] : []));
  view = await mount(withProviders(h(ServicePage, { kind: 'photos' }), { role, services }));
  return textOf(view.container);
}

const INSTALL_ADVICE = SERVICE_PAGES.photos.adminTodo;

describe('service page advice', () => {
  it('a configured service that was not checked yet is not described as «not installed»', async () => {
    const text = await renderPhotos(
      service({
        kind: 'photos',
        state: 'unknown',
        message: 'Проверка ещё не выполнялась',
        openUrl: 'http://127.0.0.1:2283/',
      }),
    );
    expect(text).toContain('Сервис ещё не проверялся');
    expect(text).toContain('Проверка ещё не выполнялась — обновите страницу через минуту.');
    expect(text).not.toContain(INSTALL_ADVICE);
    expect(text).not.toContain('Что здесь будет');
  });

  it('a service that is not set up gets the install advice and «Что здесь будет»', async () => {
    const text = await renderPhotos(service({ kind: 'photos', state: 'not_configured', hint: null }));
    expect(text).toContain(`Что нужно сделать: ${INSTALL_ADVICE}`);
    expect(text).toContain('Что здесь будет');
  });

  it('a service unknown to the server is treated as not set up', async () => {
    const text = await renderPhotos(null);
    expect(text).toContain(INSTALL_ADVICE);
    expect(text).toContain('Что здесь будет');
  });

  it('an installed service that does not answer is never told to be installed', async () => {
    const text = await renderPhotos(
      service({ kind: 'photos', state: 'offline', message: 'Сервис не отвечает', hint: null }),
    );
    expect(text).not.toContain(INSTALL_ADVICE);
    expect(text).not.toContain('Что нужно сделать');
    expect(text).not.toContain('Что здесь будет');
  });

  it('keeps the server hint for an installed service', async () => {
    const text = await renderPhotos(
      service({
        kind: 'photos',
        state: 'offline',
        message: 'Сервис не отвечает',
        hint: 'Перезапустите Immich.',
      }),
    );
    expect(text).toContain('Что нужно сделать: Перезапустите Immich.');
  });
});

describe('service page technical detail', () => {
  const degraded = service({
    kind: 'photos',
    state: 'degraded',
    message: 'Сервис отвечает с ошибкой',
    hint: null,
    detail: 'HTTP 503',
  });

  it('is shown to administrators as secondary text', async () => {
    const text = await renderPhotos(degraded, 'admin');
    expect(text).toContain('Отвечает с ошибкой');
    expect(text).toContain('Подробности: HTTP 503');
  });

  it('is hidden from the family', async () => {
    const text = await renderPhotos(degraded, 'family');
    expect(text).toContain('Отвечает с ошибкой');
    expect(text).not.toContain('HTTP 503');
  });
});
