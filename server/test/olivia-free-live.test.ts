import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN, addUser, cookieFor, createTestApp, removeDir, type TestApp } from './helpers.ts';

/*
 * A live check through the portal's own chat route with the real free-model router on this PC.
 * Off by default (it needs the router, its key file and the internet): LIVE_FREE=1 npx vitest run server/test/olivia-free-live.test.ts
 */
const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps.splice(0)) {
    await t.app.close();
    await removeDir(t.dataDir);
  }
});

describe.skipIf(process.env.LIVE_FREE !== '1')('Olivia answers through the free router (live)', () => {
  it('a plain question is answered by the «free» model, without reasoning in the text', async () => {
    process.env.FREELLM_URL = 'http://127.0.0.1:3101/v1';
    const t = await createTestApp({ fetch: globalThis.fetch as never });
    apps.push(t);
    await addUser(t.dataDir, t.clock, ADMIN);
    const cookie = await cookieFor(t.app, ADMIN);
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/olivia/chat',
      headers: { cookie },
      payload: { message: 'Напиши два предложения про осень в Беларуси', smart: false, web: false },
    });
    const events = response.body
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { t: string; text?: string; model?: string });
    const end = events.find((event) => event.t === 'end');
    console.log('LIVE', JSON.stringify(end));
    expect(end?.model).toBe('free');
    expect(end?.text ?? '').not.toMatch(/<\/?think|^Thinking/i);
    expect((end?.text ?? '').length).toBeGreaterThan(20);
  }, 120_000);
});
