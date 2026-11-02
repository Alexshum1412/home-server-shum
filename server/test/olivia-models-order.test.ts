import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOliviaChat } from '../src/olivia/chat.ts';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'olivia-order-'));
  await writeFile(path.join(dir, 'free.key'), 'free-secret');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sse = (text: string) =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });

const user = { username: 'mama', displayName: 'Мама' } as never;
const noBig = { available: () => false, isRunning: () => false, use: async () => null };

function setup(free: () => Response | Promise<Response>, enabled = true) {
  const calls: string[] = [];
  const chat = createOliviaChat({
    dataDir: dir,
    clock: () => new Date('2026-11-03T08:00:00Z'),
    assistant: {
      ask: async () => ({ reply: 'rules', via: 'rules', tool: 'none', cards: [], note: null }),
    } as never,
    quickUrl: 'http://quick.test/v1',
    keyFile: undefined,
    big: noBig as never,
    external: {
      url: 'http://free.test/v1',
      keyFile: path.join(dir, 'free.key'),
      model: 'auto',
      enabled: () => enabled,
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push(url.startsWith('http://free.test') ? 'free' : 'quick');
      if (url.startsWith('http://free.test')) {
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer free-secret');
        return free();
      }
      return sse('локальный ответ');
    }) as never,
  });
  return { chat, calls };
}

const ask = (chat: ReturnType<typeof setup>['chat']) =>
  chat.converse(user, 'Напиши короткое стихотворение про осень', { web: false });

describe('the order of the models', () => {
  it('a free model answers first, and the local one is not asked', async () => {
    const { chat, calls } = setup(() => sse('<think>думаю</think>Осень пришла.'));
    const result = await ask(chat);
    expect(result).toMatchObject({ kind: 'chat', text: 'Осень пришла.', model: 'free' });
    expect(calls).toEqual(['free']);
  });

  it('falls back to the local model when the free router fails', async () => {
    const { chat, calls } = setup(() => new Response('no', { status: 503 }));
    const result = await ask(chat);
    expect(result).toMatchObject({ text: 'локальный ответ', model: 'quick' });
    expect(calls).toEqual(['free', 'quick']);
  });

  it('asks the router twice when it answers with reasoning only, then uses the local model', async () => {
    const { chat, calls } = setup(() => sse('Thinking:\n\n1. Identify the question'));
    const result = await ask(chat);
    expect(result).toMatchObject({ text: 'локальный ответ', model: 'quick' });
    expect(calls).toEqual(['free', 'free', 'quick']);
  });

  it('does not touch the router when the administrator switched it off', async () => {
    const { chat, calls } = setup(() => sse('не должно быть'), false);
    const result = await ask(chat);
    expect(result).toMatchObject({ model: 'quick' });
    expect(calls).toEqual(['quick']);
  });
});
