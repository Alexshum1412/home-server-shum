import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGuests } from '../src/guests/guests.ts';
import { createTelegramBot } from '../src/telegram/bot.ts';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tg-report-'));
  await writeFile(path.join(dir, 'token'), '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await writeFile(path.join(dir, 'r.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(path.join(dir, 'r.pdf'), Buffer.from('%PDF-1.4'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a family member asks Olivia for a report in Telegram', () => {
  it('gets the picture with the summary and the document, then the answer text', async () => {
    const calls: Array<{ method: string; caption?: string; file?: string }> = [];
    let handed = false;
    const user = { username: 'mama', displayName: 'Мама', role: 'family', disabled: false };
    const fake = (async (url: string, init: RequestInit) => {
      const method = url.split('/').pop() ?? '';
      if (method === 'getMe') return Response.json({ ok: true, result: { username: 'olivia_test_bot' } });
      if (method === 'getUpdates') {
        if (handed) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return Response.json({ ok: true, result: [] });
        }
        handed = true;
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 1,
                chat: { id: 77, type: 'private' },
                from: { first_name: 'Мама' },
                text: 'сделай отчёт о состоянии сервера',
              },
            },
          ],
        });
      }
      if (init.body instanceof FormData) {
        const form = init.body;
        const file = (form.get('photo') ?? form.get('document')) as File | null;
        calls.push({
          method,
          caption: String(form.get('caption') ?? ''),
          file: file?.name ?? '',
        });
      } else {
        const body = JSON.parse(String(init.body ?? '{}')) as { text?: string };
        calls.push({ method, caption: body.text });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as never;
    const bot = createTelegramBot({
      tokenFile: path.join(dir, 'token'),
      clock: () => new Date('2026-11-03T08:00:00Z'),
      publicUrl: 'http://portal.test',
      profiles: { findByChat: async () => 'mama' } as never,
      users: { list: async () => [user], findByUsername: async () => user } as never,
      chat: {
        converse: async () => ({
          kind: 'tool',
          answer: {
            reply: 'Отчёт готов.',
            via: 'rules',
            tool: 'report',
            note: null,
            cards: [
              {
                kind: 'report',
                id: 'r1',
                title: 'Состояние сервера',
                summary: 'Всё в порядке: диски, копии, программы.',
                png: '/x.png',
                pdf: '/x.pdf',
              },
            ],
          },
        }),
      } as never,
      downloads: {} as never,
      storage: {} as never,
      family: { state: async () => ({ current: null }) } as never,
      guests: createGuests({ dataDir: dir, clock: () => new Date('2026-11-03T08:00:00Z') }),
      guestsEnabled: () => true,
      geocode: async () => null,
      guestDigest: async () => '',
      tellAdmins: () => undefined,
      knowledge: {} as never,
      deadlinesText: async () => '',
      reportFile: async (_u: unknown, _id: string, ext: 'png' | 'pdf') => path.join(dir, `r.${ext}`),
      ocr: { available: () => false, read: async () => null },
      resetChat: async () => undefined,
      digestToggle: async () => false,
      digest: async () => '',
      tasksToday: async () => '',
      statusText: async () => '',
      fetch: fake,
    } as never);
    await bot.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    bot.stop();
    const methods = calls
      .filter((c) => !['sendChatAction', 'setMyCommands', 'answerCallbackQuery'].includes(c.method))
      .map((c) => c.method);
    expect(methods).toEqual(['sendPhoto', 'sendDocument', 'sendMessage']);
    expect(calls.find((c) => c.method === 'sendPhoto')).toMatchObject({
      caption: 'Всё в порядке: диски, копии, программы.',
      file: 'otchet.png',
    });
    expect(calls.find((c) => c.method === 'sendDocument')?.file).toBe('otchet.pdf');
  });
});
