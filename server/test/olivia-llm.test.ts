import { afterEach, describe, expect, it } from 'vitest';
import type { OliviaExplainResponse, OliviaResponse } from '../../shared/api.ts';
import { loadConfig } from '../src/config.ts';
import { cleanAnswer, depersonalise, isLoopbackHttpUrl, LLM_MAX_ANSWER_CHARS } from '../src/olivia/llm.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, removeDir, type TestApp } from './helpers.ts';

const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps.splice(0)) {
    await t.app.close();
    await removeDir(t.dataDir);
  }
});

interface Seen {
  url: string;
  body: Record<string, unknown>;
}

async function setup(answer: () => Promise<Response>, env: Record<string, string> = {}) {
  const seen: Seen[] = [];
  const t = await createTestApp({
    env: { OLIVIA_LLM_URL: 'http://127.0.0.1:11434/v1', ...env },
    oliviaLlmFetch: async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return answer();
    },
  });
  apps.push(t);
  await addUser(t.dataDir, t.clock, ADMIN);
  await addUser(t.dataDir, t.clock, FAMILY);
  await t.app.dashboard.collector.collectAll();
  return { t, seen, admin: await cookieFor(t.app, ADMIN), mama: await cookieFor(t.app, FAMILY) };
}

const reply = (content: unknown) => async () =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { 'content-type': 'application/json' },
  });
const explain = (t: TestApp, cookie: string, id: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/admin/olivia/explain',
    headers: { cookie },
    payload: { id },
  });
const findings = async (t: TestApp, cookie: string) =>
  ((await t.app.inject({ url: '/api/admin/olivia', headers: { cookie } })).json() as OliviaResponse).findings;

describe('local language model settings', () => {
  it('is off by default and accepts only an address on this PC', () => {
    expect(loadConfig({}, 'win32').oliviaLlm).toBeNull();
    const on = loadConfig(
      { OLIVIA_LLM_URL: 'http://127.0.0.1:11434/v1/', OLIVIA_LLM_MODEL: 'qwen' },
      'win32',
    );
    expect(on.oliviaLlm).toEqual({ url: 'http://127.0.0.1:11434/v1', model: 'qwen', timeoutMs: 90_000 });
    for (const bad of [
      'http://192.168.1.5:11434/v1',
      'https://api.example.com/v1',
      'http://example.com',
      'ftp://127.0.0.1',
    ]) {
      expect(() => loadConfig({ OLIVIA_LLM_URL: bad }, 'win32'), bad).toThrow(/OLIVIA_LLM_URL/);
    }
    expect(isLoopbackHttpUrl('http://localhost:8080/v1')).toBe(true);
    expect(isLoopbackHttpUrl('http://127.0.0.1.evil.test/v1')).toBe(false);
  });

  it('removes addresses and folders from what is sent, and cleans what comes back', () => {
    const sent = depersonalise(
      'Диск C:\\FamilyData\\Photos на 192.168.1.252 и server-home.tail89d77e.ts.net',
    );
    expect(sent).not.toMatch(/FamilyData|192\.168|ts\.net/);
    const answer = cleanAnswer(`Привет\u0007 <script>alert(1)</script>\`\`\`rm -rf\`\`\`${'я'.repeat(3000)}`);
    expect(answer).not.toMatch(/<script>|```/);
    expect(answer.includes(String.fromCharCode(7))).toBe(false);
    expect(Array.from(answer).length).toBeLessThanOrEqual(LLM_MAX_ANSWER_CHARS);
  });
});

describe('explaining a finding with the local model', { timeout: 30_000 }, () => {
  it('re-words one finding; the request carries only that finding and no tools', async () => {
    const { t, seen, admin } = await setup(
      reply('  Супервизор — это программа-сторож.\u0007 Она нужна, чтобы всё само поднималось.  '),
    );
    const list = await findings(t, admin);
    expect((await t.app.inject({ url: '/api/admin/olivia', headers: { cookie: admin } })).json().llm).toEqual(
      { configured: true },
    );
    const finding = list.find((f) => f.id === 'supervisor');
    expect(finding).toBeDefined();

    const res = await explain(t, admin, 'supervisor');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as OliviaExplainResponse;
    expect(body.findingId).toBe('supervisor');
    expect(body.text).toBe('Супервизор — это программа-сторож. Она нужна, чтобы всё само поднималось.');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const sentBody = seen[0]?.body ?? {};
    expect(sentBody.stream).toBe(false);
    expect(sentBody).not.toHaveProperty('tools');
    expect(sentBody).not.toHaveProperty('functions');
    const prompt = JSON.stringify(sentBody.messages);
    expect(prompt).toContain(finding?.title ?? 'x');
    expect(prompt).not.toMatch(/C:\\\\|192\.168|\.ts\.net/);

    const audit = (
      await t.app.inject({ url: '/api/admin/audit?limit=10', headers: { cookie: admin } })
    ).json();
    expect(audit.entries.some((e: { detail?: string }) => e.detail === 'пояснение ИИ: supervisor')).toBe(
      true,
    );
    expect(JSON.stringify(audit)).not.toContain('Супервизор — это программа-сторож');
  });

  it('is for administrators, needs a connected model and a real finding', async () => {
    const { t, mama, admin } = await setup(reply('ok'));
    expect((await explain(t, mama, 'supervisor')).statusCode).toBe(403);
    expect((await explain(t, admin, 'no-such-finding')).statusCode).toBe(404);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/admin/olivia/explain',
          headers: { cookie: admin },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);

    const off = await createTestApp({});
    apps.push(off);
    await addUser(off.dataDir, off.clock, ADMIN);
    const offAdmin = await cookieFor(off.app, ADMIN);
    const refused = await explain(off, offAdmin, 'supervisor');
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error).toBe('not_configured');
    expect(
      (
        (
          await off.app.inject({ url: '/api/admin/olivia', headers: { cookie: offAdmin } })
        ).json() as OliviaResponse
      ).llm.configured,
    ).toBe(false);
  });

  it('says plainly when the model is down, slow or answers nonsense; rules keep working', async () => {
    const down = await setup(async () => {
      throw new TypeError('fetch failed');
    });
    const refused = await explain(down.t, down.admin, 'supervisor');
    expect(refused.statusCode).toBe(502);
    expect(refused.json().message).toMatch(/не отвечает/);
    expect((await findings(down.t, down.admin)).length).toBeGreaterThan(0);

    const slow = await setup(async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    });
    expect((await explain(slow.t, slow.admin, 'supervisor')).json().message).toMatch(/не ответил вовремя/);

    const broken = await setup(async () => new Response('<html>nope</html>', { status: 200 }));
    expect((await explain(broken.t, broken.admin, 'supervisor')).statusCode).toBe(502);
    const empty = await setup(reply('   '));
    expect((await explain(empty.t, empty.admin, 'supervisor')).json().message).toMatch(/пустой/);
    const http500 = await setup(async () => new Response('oops', { status: 500 }));
    expect((await explain(http500.t, http500.admin, 'supervisor')).json().message).toMatch(/HTTP 500/);
  });

  it('answers one request at a time and not more often than every ten seconds', async () => {
    const { t, admin } = await setup(reply('Готово.'));
    expect((await explain(t, admin, 'supervisor')).statusCode).toBe(200);
    expect((await explain(t, admin, 'supervisor')).statusCode).toBe(429);
    t.clock.advance(11_000);
    expect((await explain(t, admin, 'supervisor')).statusCode).toBe(200);
  });
});
