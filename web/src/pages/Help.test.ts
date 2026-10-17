import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionResponse, Role } from '../../../shared/api.ts';
import { byClass, installDocument, type Mounted, mount, settle, textOf } from '../testing/dom.ts';
import { withProviders } from '../testing/fixtures.ts';
import { HelpPage } from './Help.tsx';

let view: Mounted | null = null;

beforeEach(() => {
  installDocument();
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.unstubAllGlobals();
});

const LOCAL_URL = 'http://127.0.0.1:8070';

async function renderHelp(connection: ConnectionResponse, role: Role) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(connection), { headers: { 'content-type': 'application/json' } }),
    ),
  );
  view = await mount(withProviders(h(HelpPage, {}), { role }));
  await settle();
  return view.container;
}

const NO_LAN: ConnectionResponse = {
  tailnetUrl: 'https://server-home.example.ts.net',
  lanUrl: null,
  localUrl: LOCAL_URL,
  lanProblem: null,
};
const WITH_LAN: ConnectionResponse = { ...NO_LAN, lanUrl: 'http://192.168.1.10:8071' };

/** Copyable values on the page (address fields). */
function copyValues(root: Mounted['container']): string[] {
  return byClass(root, 'copy-field__value').map(textOf);
}

describe('help page without a home (LAN) address', () => {
  it('says plainly that the fallback address is not enabled and promises it nowhere', async () => {
    const root = await renderHelp(NO_LAN, 'family');
    const text = textOf(root);
    expect(text).toContain('Запасной адрес для домашней сети пока не включён');
    expect(text).toContain('попросите администратора');
    expect(text).not.toContain('дома может выручить запасной адрес');
  });

  it('does not offer the server-only address to the family', async () => {
    const root = await renderHelp(NO_LAN, 'family');
    expect(copyValues(root)).toEqual([NO_LAN.tailnetUrl]);
    expect(textOf(root)).not.toContain(LOCAL_URL);
  });

  it('shows the server-only address to administrators with a clear label', async () => {
    const root = await renderHelp(NO_LAN, 'admin');
    expect(copyValues(root)).toContain(LOCAL_URL);
    expect(textOf(root)).toContain('Адрес только для самого домашнего компьютера');
    expect(textOf(root)).toContain('Открывается только в браузере на самом домашнем компьютере');
  });
});

describe('help page with a home (LAN) address', () => {
  it('offers the fallback address and mentions it in the limits', async () => {
    const root = await renderHelp(WITH_LAN, 'family');
    expect(copyValues(root)).toEqual([WITH_LAN.tailnetUrl, WITH_LAN.lanUrl]);
    expect(textOf(root)).toContain('дома может выручить запасной адрес');
    expect(textOf(root)).not.toContain(LOCAL_URL);
  });
});
