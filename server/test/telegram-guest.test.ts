import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGuests } from '../src/guests/guests.ts';
import { createTelegramBot } from '../src/telegram/bot.ts';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tg-guest-'));
  await writeFile(path.join(dir, 'token'), '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Sent = { method: string; body: Record<string, unknown> };

/** A bot with a fake Telegram: the updates are handed over one by one, everything it sends is recorded. */
async function run(updates: object[], options: { chat?: boolean; enabled?: boolean } = {}) {
  const sent: Sent[] = [];
  const asked: string[] = [];
  const notices: string[] = [];
  const clock = () => new Date('2026-11-03T08:00:00Z');
  const guests = createGuests({ dataDir: dir, clock });
  let handed = false;
  const fake = (async (url: string, init: RequestInit) => {
    const method = url.split('/').pop() ?? '';
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    if (method === 'getMe') return Response.json({ ok: true, result: { username: 'olivia_test_bot' } });
    if (method === 'getUpdates') {
      if (handed) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({ ok: true, result: [] });
      }
      handed = true;
      return Response.json({ ok: true, result: updates });
    }
    sent.push({ method, body });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as never;
  const bot = createTelegramBot({
    tokenFile: path.join(dir, 'token'),
    clock,
    publicUrl: 'http://portal.test',
    profiles: { findByChat: async () => null } as never,
    users: { list: async () => [], findByUsername: async () => null } as never,
    chat: {
      converse: async (_user: unknown, text: string) => {
        asked.push(text);
        return { kind: 'chat', text: 'ответ Оливии', model: 'free', sources: [] };
      },
    } as never,
    downloads: {} as never,
    storage: {} as never,
    family: {} as never,
    guests,
    guestsEnabled: () => options.enabled !== false,
    geocode: async () => null,
    guestDigest: async () => 'Дайджест',
    tellAdmins: (title: string) => notices.push(title),
    knowledge: {} as never,
    deadlinesText: async () => '',
    reportFile: async () => null,
    ocr: { available: () => false, read: async () => null },
    resetChat: async () => undefined,
    digestToggle: async () => false,
    digest: async () => '',
    tasksToday: async () => '',
    statusText: async () => '',
    fetch: fake,
  } as never);
  await bot.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  bot.stop();
  return { sent, asked, notices, guests };
}

const text = (id: number, value: string, chat = 5001) => ({
  update_id: id,
  message: { message_id: id, chat: { id: chat, type: 'private' }, from: { first_name: 'Аня' }, text: value },
});
const press = (id: number, data: string, chat = 5001) => ({
  update_id: id,
  callback_query: {
    id: `cb${id}`,
    data,
    message: { message_id: 7, chat: { id: chat, type: 'private' } },
  },
});
const sends = (sent: Sent[]) =>
  sent.filter((item) => item.method === 'sendMessage').map((item) => String(item.body.text));

describe('a stranger in the bot', () => {
  it('gets a neutral greeting and the admin is told; nothing about the family or the server', async () => {
    const { sent, notices } = await run([text(1, 'привет')]);
    const greeting = sends(sent)[0] ?? '';
    expect(greeting).toContain('дайджест');
    expect(greeting).not.toMatch(/сервер|семь|скачива|файл|портал/i);
    expect(notices).toEqual(['Новый собеседник в боте']);
  });

  it('talks to nobody but is offered the digest, until the administrator gives the right', async () => {
    const { asked, sent } = await run([text(1, 'привет'), text(2, 'расскажи анекдот')]);
    expect(asked).toEqual([]);
    expect(sends(sent)[1]).toContain('утренний дайджест');
  });

  it('can subscribe and gets the button for a family member to join', async () => {
    const { sent, guests } = await run([text(1, 'привет'), press(2, 'g:sub'), press(3, 'g:join')]);
    expect((await guests.get('5001'))?.subscribed).toBe(true);
    expect(sends(sent).join('\n')).toContain('Привязать Telegram');
  });

  it('talks to Olivia once the administrator has allowed it', async () => {
    const dirGuests = createGuests({ dataDir: dir, clock: () => new Date('2026-11-03T08:00:00Z') });
    await dirGuests.open('5001', 'Аня', '');
    await dirGuests.update('5001', { chat: true });
    const { asked, sent } = await run([text(1, 'расскажи анекдот')]);
    expect(asked).toEqual(['расскажи анекдот']);
    expect(sends(sent)).toContain('ответ Оливии');
  });

  it('is turned away when the switch is off', async () => {
    const { sent, asked } = await run([text(1, 'привет')], { enabled: false });
    expect(asked).toEqual([]);
    expect(sends(sent)[0]).toContain('только для семьи');
  });
});
