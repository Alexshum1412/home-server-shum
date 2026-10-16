import { h } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeDocument, installDocument, type Mounted, mount } from '../testing/dom.ts';
import { type PollingResult, usePolling } from './usePolling.ts';

const INTERVAL_MS = 30_000;

let doc: FakeDocument;
let view: Mounted | null = null;
let latest: PollingResult<{ n: number }> | null = null;
/** Pending fetches in call order; each test resolves them explicitly. */
let pending: Array<(value: Response) => void> = [];
let fetchMock: ReturnType<typeof vi.fn>;

function Probe() {
  latest = usePolling<{ n: number }>('/api/probe', INTERVAL_MS);
  return null;
}

function respond(n: number): Promise<void> {
  const resolve = pending.shift();
  if (!resolve) throw new Error('No request is in flight');
  return act(async () => {
    resolve(new Response(JSON.stringify({ n }), { headers: { 'content-type': 'application/json' } }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

function advance(ms: number): Promise<void> {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  doc = installDocument();
  pending = [];
  latest = null;
  fetchMock = vi.fn(
    (_path: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        pending.push(resolve);
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePolling', () => {
  it('polls on its interval while the page is visible', async () => {
    view = await mount(h(Probe, {}));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await respond(1);
    expect(latest?.data).toEqual({ n: 1 });
    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch while hidden after a visibility flip during a request', async () => {
    view = await mount(h(Probe, {}));
    // Tab hidden and shown again quickly while the first request is in flight:
    // the visibility handler schedules a timer, then the request schedules another.
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    await respond(1);
    doc.setVisibility('hidden');
    await advance(INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops for good after unmount, even with a visibility flip during a request', async () => {
    view = await mount(h(Probe, {}));
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    await respond(1);
    await view.unmount();
    view = null;
    await advance(INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps exactly one poll loop after the visibility flip', async () => {
    view = await mount(h(Probe, {}));
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    await respond(1);
    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await respond(2);
    await advance(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
