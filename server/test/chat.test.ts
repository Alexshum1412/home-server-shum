import { createECDH } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChatConversation,
  ChatListResponse,
  ChatMessage,
  ChatMessagesResponse,
  NotificationsResponse,
  RealtimeEvent,
} from '../../shared/api.ts';
import type { PushFetch } from '../src/notify/webpush.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, removeDir, type TestApp } from './helpers.ts';

const SASHA = { username: 'sasha', password: 'sasha-password-1', displayName: 'Саша' };

let t: TestApp;
let papa: string;
let mama: string;
let sasha: string;
let ids: { papa: string; mama: string; sasha: string };
const pushed: Array<{ url: string }> = [];
const pushFetch: PushFetch = async (url) => {
  pushed.push({ url });
  return { status: 201 };
};

async function call<T = unknown>(
  cookie: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await t.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as T };
}

async function upload(
  cookie: string,
  conversationId: string,
  name: string,
  bytes: Buffer,
  extra = '',
  headers: Record<string, string> = {},
) {
  return t.app.inject({
    method: 'PUT',
    url: `/api/chat/conversations/${conversationId}/attachment?name=${encodeURIComponent(name)}&size=${bytes.length}${extra}`,
    headers: { cookie, 'content-type': 'application/octet-stream', 'x-upload': '1', ...headers },
    payload: bytes,
  });
}

beforeEach(async () => {
  t = await createTestApp({ pushFetch });
  const a = await addUser(t.dataDir, t.clock, ADMIN);
  const b = await addUser(t.dataDir, t.clock, FAMILY);
  const c = await addUser(t.dataDir, t.clock, { ...SASHA, role: 'family' });
  ids = { papa: a.id, mama: b.id, sasha: c.id };
  papa = await cookieFor(t.app, ADMIN);
  mama = await cookieFor(t.app, FAMILY);
  sasha = await cookieFor(t.app, SASHA);
  pushed.length = 0;
});

afterEach(async () => {
  await t.app.close();
  await removeDir(t.dataDir);
});

const direct = async (cookie: string, userId: string) =>
  (await call<ChatConversation>(cookie, 'POST', '/api/chat/conversations/direct', { userId })).body;
const send = (cookie: string, id: string, text: string, clientId?: string) =>
  call<ChatMessage>(cookie, 'POST', `/api/chat/conversations/${id}/messages`, {
    text,
    ...(clientId ? { clientId } : {}),
  });
const list = async (cookie: string) =>
  (await call<ChatListResponse>(cookie, 'GET', '/api/chat/conversations')).body;

describe('family chat: rooms and messages', () => {
  it('has one room for everybody and lists the other people', async () => {
    const mine = await list(mama);
    expect(mine.me).toEqual({ id: ids.mama, displayName: 'Мама' });
    expect(mine.conversations.map((c) => [c.id, c.kind, c.title])).toEqual([
      ['family', 'family', 'Вся семья'],
    ]);
    expect(mine.people.map((p) => p.displayName)).toEqual(['Папа', 'Саша']);
    expect(mine.conversations[0]?.members).toHaveLength(3);
    // the room's first line is made by the server
    const first = await call<ChatMessagesResponse>(mama, 'GET', '/api/chat/conversations/family/messages');
    expect(first.body.messages[0]).toMatchObject({
      system: 'created',
      senderId: null,
      senderName: 'Семейный сервер',
    });
  });

  it('sends in the family room; others get an unread count that reading clears', async () => {
    const sent = await send(mama, 'family', '  Привет всем!  ');
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ text: 'Привет всем!', senderId: ids.mama, senderName: 'Мама', seq: 2 });
    expect((await list(sasha)).conversations[0]).toMatchObject({
      unread: 1,
      last: { preview: 'Привет всем!', senderName: 'Мама' },
    });
    expect((await list(mama)).conversations[0]?.unread).toBe(0);
    await call(sasha, 'POST', '/api/chat/conversations/family/read', { seq: 2 });
    expect((await list(sasha)).conversations[0]?.unread).toBe(0);
    expect((await list(mama)).conversations[0]?.reads[ids.sasha]).toBe(2);
  });

  it('opens one direct chat per pair, named after the other person', async () => {
    const first = await direct(mama, ids.sasha);
    const again = await direct(sasha, ids.mama);
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ kind: 'direct', title: 'Саша' });
    expect(again.title).toBe('Мама');
    expect((await call(mama, 'POST', '/api/chat/conversations/direct', { userId: ids.mama })).status).toBe(
      400,
    );
    expect((await call(mama, 'POST', '/api/chat/conversations/direct', { userId: 'nobody' })).status).toBe(
      400,
    );
  });

  it('checks the text: empty, too long, control characters', async () => {
    expect((await send(mama, 'family', '   ')).status).toBe(400);
    expect((await send(mama, 'family', 'я'.repeat(4001))).status).toBe(413);
    const ok = await send(mama, 'family', 'a\u0000b\u0007c\r\nd');
    expect(ok.body.text).toBe('abc\nd');
  });

  it('answers a retry of the same message with the first one instead of sending twice', async () => {
    const one = await send(mama, 'family', 'раз', 'cid-1');
    const two = await send(mama, 'family', 'раз', 'cid-1');
    expect(two.body.id).toBe(one.body.id);
    const all = await call<ChatMessagesResponse>(mama, 'GET', '/api/chat/conversations/family/messages');
    expect(all.body.messages.filter((m) => m.text === 'раз')).toHaveLength(1);
    expect(one.body.clientId).toBe('cid-1');
    // another person never gets the sender's private id
    const seen = await call<ChatMessagesResponse>(sasha, 'GET', '/api/chat/conversations/family/messages');
    expect(seen.body.messages.find((m) => m.text === 'раз')?.clientId).toBeNull();
  });

  it('pages through older messages', async () => {
    for (let i = 1; i <= 7; i += 1) await send(mama, 'family', `сообщение ${i}`);
    const latest = await call<ChatMessagesResponse>(
      mama,
      'GET',
      '/api/chat/conversations/family/messages?limit=3',
    );
    expect(latest.body.messages.map((m) => m.text)).toEqual(['сообщение 5', 'сообщение 6', 'сообщение 7']);
    expect(latest.body.more).toBe(true);
    const before = latest.body.messages[0]?.seq;
    const older = await call<ChatMessagesResponse>(
      mama,
      'GET',
      `/api/chat/conversations/family/messages?limit=3&before=${before}`,
    );
    expect(older.body.messages.map((m) => m.text)).toEqual(['сообщение 2', 'сообщение 3', 'сообщение 4']);
    const oldest = await call<ChatMessagesResponse>(
      mama,
      'GET',
      `/api/chat/conversations/family/messages?limit=50&before=${older.body.messages[0]?.seq}`,
    );
    expect(oldest.body.more).toBe(false);
    expect(oldest.body.messages.map((m) => m.system ?? m.text)).toEqual(['created', 'сообщение 1']);
  });

  it('keeps everything after a restart of the server', async () => {
    const room = await direct(mama, ids.sasha);
    await send(mama, room.id, 'до перезапуска');
    await call(sasha, 'POST', `/api/chat/conversations/${room.id}/read`, { seq: 1 });
    const { dataDir } = t;
    await t.app.close();
    t = await createTestApp({ dataDir, pushFetch });
    mama = await cookieFor(t.app, FAMILY);
    sasha = await cookieFor(t.app, SASHA);
    const messages = await call<ChatMessagesResponse>(
      mama,
      'GET',
      `/api/chat/conversations/${room.id}/messages`,
    );
    expect(messages.body.messages.map((m) => m.text)).toEqual(['до перезапуска']);
    const mine = await list(sasha);
    expect(mine.conversations.find((c) => c.id === room.id)).toMatchObject({ unread: 0 });
    // the line is really in a file, one JSON per line
    const lines = (await readFile(path.join(t.config.chatDir, 'msg', `${room.id}.jsonl`), 'utf8'))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ t: 'm', text: 'до перезапуска', seq: 1 });
  });

  it('survives a half-written last line', async () => {
    const room = await direct(mama, ids.sasha);
    await send(mama, room.id, 'целое');
    const file = path.join(t.config.chatDir, 'msg', `${room.id}.jsonl`);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, '{"t":"m","id":"x","seq":2,"at":"2026');
    const { dataDir } = t;
    await t.app.close();
    t = await createTestApp({ dataDir, pushFetch });
    mama = await cookieFor(t.app, FAMILY);
    const messages = await call<ChatMessagesResponse>(
      mama,
      'GET',
      `/api/chat/conversations/${room.id}/messages`,
    );
    expect(messages.body.messages.map((m) => m.text)).toEqual(['целое']);
    expect((await send(mama, room.id, 'после')).body.seq).toBe(2);
  });

  it('deletes only your own message', async () => {
    const sent = await send(mama, 'family', 'ошибка');
    const foreign = await call(
      sasha,
      'POST',
      `/api/chat/conversations/family/messages/${sent.body.id}/delete`,
      {},
    );
    expect(foreign.status).toBe(403);
    const own = await call(
      mama,
      'POST',
      `/api/chat/conversations/family/messages/${sent.body.id}/delete`,
      {},
    );
    expect(own.status).toBe(204);
    const all = await call<ChatMessagesResponse>(sasha, 'GET', '/api/chat/conversations/family/messages');
    expect(all.body.messages.find((m) => m.id === sent.body.id)).toMatchObject({ deleted: true, text: '' });
    expect((await list(sasha)).conversations[0]?.last?.preview).toBe('Сообщение удалено');
  });

  it('limits the pace: 60 messages a minute', async () => {
    for (let i = 0; i < 60; i += 1) expect((await send(mama, 'family', `n${i}`)).status).toBe(200);
    const extra = await t.app.inject({
      method: 'POST',
      url: '/api/chat/conversations/family/messages',
      headers: { cookie: mama },
      payload: { text: 'ещё' },
    });
    expect(extra.statusCode).toBe(429);
    expect(extra.headers['retry-after']).toBeDefined();
    t.clock.advance(61_000);
    expect((await send(mama, 'family', 'снова')).status).toBe(200);
  });
});

describe('family chat: privacy', () => {
  it('hides a conversation from everybody outside it, administrator included', async () => {
    const room = await direct(mama, ids.sasha);
    await send(mama, room.id, 'секрет');
    for (const [name, url, method] of [
      ['messages', `/api/chat/conversations/${room.id}/messages`, 'GET'],
      ['send', `/api/chat/conversations/${room.id}/messages`, 'POST'],
      ['read', `/api/chat/conversations/${room.id}/read`, 'POST'],
      ['leave', `/api/chat/conversations/${room.id}/leave`, 'POST'],
    ] as const) {
      const res = await call(papa, method, url, method === 'POST' ? { text: 'x', seq: 1 } : undefined);
      expect(res.status, name).toBe(404);
    }
    expect((await list(papa)).conversations.map((c) => c.id)).toEqual(['family']);
    expect(JSON.stringify(await list(papa))).not.toContain('секрет');
  });

  it('needs a signed-in person for everything', async () => {
    for (const url of [
      '/api/chat/conversations',
      '/api/chat/conversations/family/messages',
      '/api/events',
      '/api/calls/config',
      '/api/notifications',
    ]) {
      const res = await t.app.inject({ url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('refuses requests sent from another site', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/chat/conversations/family/messages',
      headers: { cookie: mama, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      payload: { text: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects ids that are not conversation ids, with the same answer as a missing chat', async () => {
    for (const id of ['..%2F..%2Fusers', 'x', '0'.repeat(36), '..']) {
      const res = await t.app.inject({
        url: `/api/chat/conversations/${id}/messages`,
        headers: { cookie: mama },
      });
      expect([400, 404]).toContain(res.statusCode);
    }
  });
});

describe('family chat: groups', () => {
  async function group(title = 'Поездка') {
    const res = await call<ChatConversation>(mama, 'POST', '/api/chat/conversations/group', {
      title,
      memberIds: [ids.sasha],
    });
    expect(res.status).toBe(200);
    return res.body;
  }

  it('creates a group; the creator manages it, members do not', async () => {
    const g = await group();
    expect(g).toMatchObject({ kind: 'group', title: 'Поездка', canManage: true, ownerId: ids.mama });
    expect(g.members.map((m) => m.displayName).sort()).toEqual(['Мама', 'Саша']);
    const mine = (await list(sasha)).conversations.find((c) => c.id === g.id);
    expect(mine).toMatchObject({ canManage: false, title: 'Поездка' });
    // the third person does not see it
    expect((await list(papa)).conversations.map((c) => c.id)).not.toContain(g.id);
    expect(
      (await call(sasha, 'POST', `/api/chat/conversations/${g.id}/rename`, { title: 'Моя' })).status,
    ).toBe(403);
    expect(
      (await call(sasha, 'POST', `/api/chat/conversations/${g.id}/members`, { memberIds: [ids.papa] }))
        .status,
    ).toBe(403);
    expect(
      (await call(sasha, 'POST', `/api/chat/conversations/${g.id}/members/remove`, { userId: ids.mama }))
        .status,
    ).toBe(403);
  });

  it('renames, adds and removes people, and says so in the chat', async () => {
    const g = await group();
    expect(
      (
        await call<ChatConversation>(mama, 'POST', `/api/chat/conversations/${g.id}/rename`, {
          title: 'Отпуск',
        })
      ).body.title,
    ).toBe('Отпуск');
    const added = await call<ChatConversation>(mama, 'POST', `/api/chat/conversations/${g.id}/members`, {
      memberIds: [ids.papa],
    });
    expect(added.body.members).toHaveLength(3);
    expect((await call(papa, 'GET', `/api/chat/conversations/${g.id}/messages`)).status).toBe(200);
    const removed = await call<ChatConversation>(
      mama,
      'POST',
      `/api/chat/conversations/${g.id}/members/remove`,
      { userId: ids.papa },
    );
    expect(removed.body.members).toHaveLength(2);
    expect((await call(papa, 'GET', `/api/chat/conversations/${g.id}/messages`)).status).toBe(404);
    const lines = (
      await call<ChatMessagesResponse>(mama, 'GET', `/api/chat/conversations/${g.id}/messages`)
    ).body.messages.map((m) => m.text);
    expect(lines).toEqual([
      'Группа «Поездка» создана.',
      'В группу добавлены: Папа.',
      'Из группы удалён: Папа.',
    ]);
    expect(
      (await call(mama, 'POST', `/api/chat/conversations/${g.id}/members/remove`, { userId: ids.mama }))
        .status,
    ).toBe(400);
  });

  it('hands the group over to the next member when the creator leaves; the last member leaves an empty group', async () => {
    const g = await group();
    expect((await call(mama, 'POST', `/api/chat/conversations/${g.id}/leave`, {})).status).toBe(204);
    const asSasha = (await list(sasha)).conversations.find((c) => c.id === g.id);
    expect(asSasha).toMatchObject({ canManage: true, ownerId: ids.sasha });
    expect((await call(mama, 'GET', `/api/chat/conversations/${g.id}/messages`)).status).toBe(404);
    expect((await call(sasha, 'POST', `/api/chat/conversations/${g.id}/leave`, {})).status).toBe(204);
    expect((await call(mama, 'POST', '/api/chat/conversations/family/leave', {})).status).toBe(400);
  });

  it('checks the title, the members and the size', async () => {
    const bad = (payload: object) => call(mama, 'POST', '/api/chat/conversations/group', payload);
    expect((await bad({ title: '   ', memberIds: [ids.sasha] })).status).toBe(400);
    expect((await bad({ title: 'Группа', memberIds: [] })).status).toBe(400);
    expect((await bad({ title: 'Группа', memberIds: [ids.mama] })).status).toBe(400);
    expect((await bad({ title: 'Группа', memberIds: ['nobody'] })).status).toBe(400);
  });

  it('drops a removed account from groups and keeps its old lines readable', async () => {
    const g = await group();
    await call(sasha, 'POST', `/api/chat/conversations/${g.id}/messages`, { text: 'я был' });
    const removed = await call(papa, 'POST', '/api/admin/users/sasha/remove', { confirm: true });
    expect(removed.status).toBe(204);
    const after = await call<ChatMessagesResponse>(mama, 'GET', `/api/chat/conversations/${g.id}/messages`);
    expect(after.body.messages.find((m) => m.text === 'я был')?.senderName).toBe('Бывший участник');
    expect(
      (await list(mama)).conversations.find((c) => c.id === g.id)?.members.map((m) => m.displayName),
    ).toEqual(['Мама']);
  });
});

describe('family chat: attachments', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

  it('sends a photo; members view it inline in a sandbox, outsiders get 404', async () => {
    const room = await direct(mama, ids.sasha);
    const res = await upload(
      mama,
      room.id,
      'море.jpg',
      jpeg,
      `&text=${encodeURIComponent('Смотри!')}&clientId=up-1`,
    );
    expect(res.statusCode).toBe(200);
    const message = res.json() as ChatMessage;
    expect(message).toMatchObject({
      text: 'Смотри!',
      attachment: { name: 'море.jpg', kind: 'image', mime: 'image/jpeg', sizeBytes: jpeg.length },
    });
    const file = `/api/chat/conversations/${room.id}/messages/${message.id}/file`;
    const inline = await t.app.inject({ url: `${file}?inline=1`, headers: { cookie: sasha } });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers['content-type']).toBe('image/jpeg');
    expect(String(inline.headers['content-disposition'])).toContain('inline');
    expect(String(inline.headers['content-security-policy'])).toContain('sandbox');
    expect(Buffer.from(inline.rawPayload).equals(jpeg)).toBe(true);
    const download = await t.app.inject({ url: file, headers: { cookie: sasha } });
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(String(download.headers['content-disposition'])).toContain('attachment');
    expect((await t.app.inject({ url: file, headers: { cookie: papa } })).statusCode).toBe(404);
    const part = await t.app.inject({
      url: `${file}?inline=1`,
      headers: { cookie: sasha, range: 'bytes=0-3' },
    });
    expect(part.statusCode).toBe(206);
    expect(Buffer.from(part.rawPayload)).toEqual(jpeg.subarray(0, 4));
    // the file has a neutral name on disk, never the sender's name
    const stored = await readdir(path.join(t.config.chatDir, 'files', room.id));
    expect(stored).toEqual([message.id]);
  });

  it('never shows scripts or pages inline, whatever they are called', async () => {
    const room = await direct(mama, ids.sasha);
    const page = await upload(mama, room.id, 'страница.html', Buffer.from('<script>alert(1)</script>'));
    const message = page.json() as ChatMessage;
    expect(message.attachment).toMatchObject({ kind: 'file', mime: 'application/octet-stream' });
    const res = await t.app.inject({
      url: `/api/chat/conversations/${room.id}/messages/${message.id}/file?inline=1`,
      headers: { cookie: sasha },
    });
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
  });

  it('refuses programs by name and by content, wrong sizes, and non-members', async () => {
    const room = await direct(mama, ids.sasha);
    expect((await upload(mama, room.id, 'setup.exe', Buffer.from('hello'))).statusCode).toBe(422);
    expect(
      (await upload(mama, room.id, 'photo.jpg', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(40)])))
        .statusCode,
    ).toBe(422);
    expect((await upload(mama, room.id, '.hidden', jpeg)).statusCode).toBe(400);
    const lie = await t.app.inject({
      method: 'PUT',
      url: `/api/chat/conversations/${room.id}/attachment?name=a.jpg&size=999`,
      headers: { cookie: mama, 'content-type': 'application/octet-stream', 'x-upload': '1' },
      payload: jpeg,
    });
    expect(lie.statusCode).toBe(411);
    expect((await upload(papa, room.id, 'a.jpg', jpeg)).statusCode).toBe(404);
    const noHeader = await t.app.inject({
      method: 'PUT',
      url: `/api/chat/conversations/${room.id}/attachment?name=a.jpg&size=${jpeg.length}`,
      headers: { cookie: mama, 'content-type': 'application/octet-stream' },
      payload: jpeg,
    });
    expect(noHeader.statusCode).toBe(415);
    // nothing was left behind
    const all = await call<ChatMessagesResponse>(mama, 'GET', `/api/chat/conversations/${room.id}/messages`);
    expect(all.body.messages).toHaveLength(0);
    const leftovers = await readdir(path.join(t.config.chatDir, 'files', room.id)).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  it('refuses a file over the limit and a retry of the same upload does not duplicate it', async () => {
    await t.app.close();
    t = await createTestApp({ dataDir: t.dataDir, pushFetch, env: { CHAT_MAX_FILE_MB: '1' } });
    mama = await cookieFor(t.app, FAMILY);
    const room = await direct(mama, ids.sasha);
    const big = await upload(mama, room.id, 'big.bin', Buffer.alloc(2 * 1024 * 1024, 7));
    expect(big.statusCode).toBe(413);
    const one = await upload(mama, room.id, 'a.jpg', jpeg, '&clientId=same');
    const two = await upload(mama, room.id, 'a.jpg', jpeg, '&clientId=same');
    expect((two.json() as ChatMessage).id).toBe((one.json() as ChatMessage).id);
  });

  it('puts the attachment of a deleted message into the chat trash, not into oblivion', async () => {
    const room = await direct(mama, ids.sasha);
    const message = (await upload(mama, room.id, 'a.jpg', jpeg)).json() as ChatMessage;
    expect(
      (await call(mama, 'POST', `/api/chat/conversations/${room.id}/messages/${message.id}/delete`, {}))
        .status,
    ).toBe(204);
    expect(await readdir(path.join(t.config.chatDir, '.trash'))).toEqual([`${room.id}-${message.id}`]);
    const gone = await t.app.inject({
      url: `/api/chat/conversations/${room.id}/messages/${message.id}/file`,
      headers: { cookie: sasha },
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('notifications', () => {
  function subscribe(cookie: string, host = 'fcm.googleapis.com') {
    const device = createECDH('prime256v1');
    device.generateKeys();
    return call<NotificationsResponse>(cookie, 'POST', '/api/notifications/subscribe', {
      endpoint: `https://${host}/fcm/send/${Math.random().toString(36).slice(2)}`,
      keys: {
        p256dh: device.getPublicKey().toString('base64url'),
        auth: Buffer.alloc(16, 3).toString('base64url'),
      },
      label: 'Телефон',
    });
  }

  it('reports the push key and the number of devices', async () => {
    const before = await call<NotificationsResponse>(sasha, 'GET', '/api/notifications');
    expect(before.body.push.available).toBe(true);
    expect(before.body.push.publicKey).toMatch(/^[\w-]{87}$/);
    expect(before.body.push.devices).toBe(0);
    expect((await subscribe(sasha)).body.push.devices).toBe(1);
  });

  it('refuses a subscription that points anywhere but a real push service', async () => {
    expect((await subscribe(sasha, 'evil.example.com')).status).toBe(400);
    expect((await subscribe(sasha, '127.0.0.1')).status).toBe(400);
    const device = createECDH('prime256v1');
    device.generateKeys();
    const bad = await call(sasha, 'POST', '/api/notifications/subscribe', {
      endpoint: 'https://fcm.googleapis.com/x',
      keys: { p256dh: 'AAAA', auth: 'AAAA' },
    });
    expect(bad.status).toBe(400);
  });

  it('pushes a new message to the other people with a subscription, never to the sender', async () => {
    await subscribe(sasha);
    await subscribe(mama);
    await send(mama, 'family', 'Ужин готов');
    await t.app.dashboard.notify.idle();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.url).toContain('fcm.googleapis.com');
  });

  it('respects what a person switched off', async () => {
    await subscribe(sasha);
    await call(sasha, 'POST', '/api/notifications/prefs', { messages: false });
    await send(mama, 'family', 'Ужин готов');
    await t.app.dashboard.notify.idle();
    expect(pushed).toHaveLength(0);
    const prefs = await call<NotificationsResponse>(sasha, 'GET', '/api/notifications');
    expect(prefs.body.prefs).toMatchObject({ messages: false, calls: true, previews: false });
  });

  it('forgets a device the push service says is gone', async () => {
    const gone: PushFetch = async () => ({ status: 410 });
    await t.app.close();
    t = await createTestApp({ dataDir: t.dataDir, pushFetch: gone });
    sasha = await cookieFor(t.app, SASHA);
    mama = await cookieFor(t.app, FAMILY);
    expect((await subscribe(sasha)).body.push.devices).toBe(1);
    await send(mama, 'family', 'раз');
    await t.app.dashboard.notify.idle();
    expect((await call<NotificationsResponse>(sasha, 'GET', '/api/notifications')).body.push.devices).toBe(0);
  });

  it('shows a finished download in the list and marks it read', async () => {
    await t.app.dashboard.notify.notify({
      users: [ids.sasha],
      kind: 'download',
      title: 'Загрузка завершена',
      body: 'film.mkv',
      url: '/downloads',
    });
    const list1 = await call<NotificationsResponse>(sasha, 'GET', '/api/notifications');
    expect(list1.body.unread).toBe(1);
    expect(list1.body.notifications[0]).toMatchObject({
      kind: 'download',
      title: 'Загрузка завершена',
      read: false,
    });
    expect((await call<NotificationsResponse>(mama, 'GET', '/api/notifications')).body.unread).toBe(0);
    await call(sasha, 'POST', '/api/notifications/read', { ids: 'all' });
    expect((await call<NotificationsResponse>(sasha, 'GET', '/api/notifications')).body.unread).toBe(0);
  });
});

describe('live events', () => {
  async function listen() {
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    return (t.app.server.address() as { port: number }).port;
  }

  function open(port: number, cookie: string) {
    const events: RealtimeEvent[] = [];
    let status = 0;
    let headers: http.IncomingHttpHeaders = {};
    let resolveFirst: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/events', headers: { host: '127.0.0.1:8070', cookie } },
      (res) => {
        status = res.statusCode ?? 0;
        headers = res.headers;
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf('\n\n');
            if (end === -1) break;
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block.split('\n').find((line) => line.startsWith('data: '));
            if (data) events.push(JSON.parse(data.slice(6)) as RealtimeEvent);
            if (events.length === 1) resolveFirst();
          }
        });
      },
    );
    return {
      events,
      ready,
      get status() {
        return status;
      },
      get headers() {
        return headers;
      },
      close: () => request.destroy(),
    };
  }

  async function until(check: () => boolean) {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(check()).toBe(true);
  }

  it('delivers a message to the people in the chat at once, and to nobody else', async () => {
    const port = await listen();
    const room = await direct(mama, ids.sasha);
    const forSasha = open(port, sasha);
    const forPapa = open(port, papa);
    await Promise.all([forSasha.ready, forPapa.ready]);
    expect(forSasha.status).toBe(200);
    expect(String(forSasha.headers['content-type'])).toContain('text/event-stream');
    expect(forSasha.headers['cache-control']).toContain('no-store');
    expect(forSasha.headers['x-content-type-options']).toBe('nosniff');
    await send(mama, room.id, 'живое сообщение');
    await until(() => forSasha.events.some((e) => e.type === 'message'));
    const got = forSasha.events.find((e) => e.type === 'message');
    expect(got).toMatchObject({ type: 'message', message: { text: 'живое сообщение', clientId: null } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(forPapa.events.some((e) => e.type === 'message' && e.message.text === 'живое сообщение')).toBe(
      false,
    );
    forSasha.close();
    forPapa.close();
  });

  it('refuses a stranger and closes the stream when the session ends', async () => {
    const port = await listen();
    const stranger = open(port, 'fd_session=nope');
    await until(() => stranger.status === 401);
    const mine = open(port, mama);
    await mine.ready;
    expect(t.app.dashboard.hub.isOnline(ids.mama)).toBe(true);
    stranger.close();
    mine.close();
  });
});
