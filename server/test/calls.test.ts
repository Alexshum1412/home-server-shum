import { createECDH } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CallConfigResponse,
  CallInfo,
  ChatConversation,
  ChatMessage,
  ChatMessagesResponse,
  RealtimeEvent,
} from '../../shared/api.ts';
import type { PushFetch } from '../src/notify/webpush.ts';
import { ADMIN, addUser, cookieFor, createTestApp, FAMILY, removeDir, type TestApp } from './helpers.ts';

const SASHA = { username: 'sasha', password: 'sasha-password-1', displayName: 'Саша' };

let t: TestApp;
let cookies: { papa: string; mama: string; sasha: string };
let ids: { papa: string; mama: string; sasha: string };
let sent: Array<{ to: string; event: RealtimeEvent }>;
let online: Set<string>;
const pushed: Array<{ headers: Record<string, string> }> = [];
const pushFetch: PushFetch = async (_url, init) => {
  pushed.push({ headers: init.headers });
  return { status: 201 };
};

async function call<T = unknown>(cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await t.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as T };
}

async function boot(options: Parameters<typeof createTestApp>[0] = {}) {
  t = await createTestApp({ pushFetch, ...options });
  const hub = t.app.dashboard.hub;
  sent = [];
  online = new Set();
  vi.spyOn(hub, 'publish').mockImplementation((userIds, event) => {
    for (const to of new Set(userIds)) sent.push({ to, event });
  });
  vi.spyOn(hub, 'isOnline').mockImplementation((id) => online.has(id));
}

beforeEach(async () => {
  pushed.length = 0;
  await boot();
  const a = await addUser(t.dataDir, t.clock, ADMIN);
  const b = await addUser(t.dataDir, t.clock, FAMILY);
  const c = await addUser(t.dataDir, t.clock, { ...SASHA, role: 'family' });
  ids = { papa: a.id, mama: b.id, sasha: c.id };
  cookies = {
    papa: await cookieFor(t.app, ADMIN),
    mama: await cookieFor(t.app, FAMILY),
    sasha: await cookieFor(t.app, SASHA),
  };
  sent = [];
  online = new Set(Object.values(ids));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.app.close();
  await removeDir(t.dataDir);
});

const direct = async (cookie: string, userId: string) =>
  (await call<ChatConversation>(cookie, 'POST', '/api/chat/conversations/direct', { userId })).body;
const start = (cookie: string, conversationId: string, video = false) =>
  call<{ call: CallInfo; busy: string[] }>(cookie, 'POST', '/api/calls', { conversationId, video });
const eventsFor = (id: string, type: RealtimeEvent['type']) =>
  sent.filter((item) => item.to === id && item.event.type === type).map((item) => item.event);
const unreadOf = async (cookie: string, id: string) =>
  (
    await call<{ conversations: Array<{ id: string; unread: number }> }>(
      cookie,
      'GET',
      '/api/chat/conversations',
    )
  ).body.conversations.find((c) => c.id === id)?.unread;
const lines = async (cookie: string, conversationId: string) =>
  (
    await call<ChatMessagesResponse>(cookie, 'GET', `/api/chat/conversations/${conversationId}/messages`)
  ).body.messages.map((m: ChatMessage) => m.text);

describe('call setup', () => {
  it('gives no relay by default and short-lived relay credentials when a TURN server is set', async () => {
    const plain = await call<CallConfigResponse>(cookies.mama, 'GET', '/api/calls/config');
    expect(plain.body).toEqual({ iceServers: [], maxParticipants: 4, relay: 'none' });
    await t.app.close();
    await boot({
      dataDir: t.dataDir,
      env: {
        CALLS_STUN_URLS: 'stun:stun.example.org:3478',
        CALLS_TURN_URLS: 'turn:turn.example.org:3478?transport=udp, turns:turn.example.org:5349',
        CALLS_TURN_SECRET: 'top-secret-value',
        CALLS_TURN_TTL_SEC: '600',
      },
    });
    cookies.mama = await cookieFor(t.app, FAMILY);
    const full = await call<CallConfigResponse>(cookies.mama, 'GET', '/api/calls/config');
    expect(full.body.relay).toBe('turn');
    expect(full.body.iceServers[0]).toEqual({ urls: ['stun:stun.example.org:3478'] });
    const turn = full.body.iceServers[1];
    expect(turn?.urls).toEqual(['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349']);
    expect(turn?.username).toMatch(
      new RegExp(`^${Math.floor(t.clock().getTime() / 1000) + 600}:${ids.mama}$`),
    );
    expect(turn?.credential).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(JSON.stringify(full.body)).not.toContain('top-secret-value');
  });

  it('refuses a malformed relay address at start-up', async () => {
    await expect(createTestApp({ env: { CALLS_TURN_URLS: 'http://x.example' } })).rejects.toThrow(
      /CALLS_TURN_URLS/,
    );
    await expect(createTestApp({ env: { CALLS_STUN_URLS: 'turn:x.example:3478' } })).rejects.toThrow(
      /CALLS_STUN_URLS/,
    );
  });
});

describe('a call between two people', () => {
  it('rings the other person, connects on answer and passes the setup messages', async () => {
    const room = await direct(cookies.mama, ids.sasha);
    const started = await start(cookies.mama, room.id, true);
    expect(started.status).toBe(200);
    expect(started.body.call).toMatchObject({
      state: 'ringing',
      video: true,
      initiator: { displayName: 'Мама' },
    });
    expect(started.body.call.participants.map((p) => [p.displayName, p.joined])).toEqual([
      ['Мама', true],
      ['Саша', false],
    ]);
    const ring = eventsFor(ids.sasha, 'call')[0];
    expect(ring).toMatchObject({ type: 'call', call: { id: started.body.call.id, state: 'ringing' } });
    expect(eventsFor(ids.papa, 'call')).toHaveLength(0);

    const callId = started.body.call.id;
    const joined = await call<{ call: CallInfo; peers: string[] }>(
      cookies.sasha,
      'POST',
      `/api/calls/${callId}/join`,
      {},
    );
    expect(joined.body.call.state).toBe('active');
    expect(joined.body.peers).toEqual([ids.mama]);

    // the joiner offers, the first person answers, both exchange candidates
    const offer = { type: 'offer', sdp: 'v=0\r\n...' };
    expect(
      (
        await call(cookies.sasha, 'POST', `/api/calls/${callId}/signal`, {
          to: ids.mama,
          type: 'offer',
          data: offer,
        })
      ).status,
    ).toBe(204);
    expect(eventsFor(ids.mama, 'signal')[0]).toEqual({
      type: 'signal',
      callId,
      from: ids.sasha,
      signal: 'offer',
      data: offer,
    });
    const answer = { type: 'answer', sdp: 'v=0\r\n...answer' };
    expect(
      (
        await call(cookies.mama, 'POST', `/api/calls/${callId}/signal`, {
          to: ids.sasha,
          type: 'answer',
          data: answer,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call(cookies.mama, 'POST', `/api/calls/${callId}/signal`, {
          to: ids.sasha,
          type: 'candidate',
          data: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host' },
        })
      ).status,
    ).toBe(204);
    expect(eventsFor(ids.sasha, 'signal')).toHaveLength(2);

    t.clock.advance(125_000);
    expect((await call(cookies.mama, 'POST', `/api/calls/${callId}/leave`, {})).status).toBe(204);
    const ended = eventsFor(ids.sasha, 'call').at(-1);
    expect(ended).toMatchObject({ call: { state: 'ended', endReason: 'hangup' } });
    expect((await lines(cookies.mama, room.id)).at(-1)).toBe('Видеозвонок завершён, длился 2 мин 5 с.');
    // an ordinary end-of-call line is history, not news
    expect(await unreadOf(cookies.sasha, room.id)).toBe(0);
    expect((await call(cookies.sasha, 'GET', '/api/calls/active')).body).toEqual({ call: null });
  });

  it('sends a push that wakes the phone: urgent and short-lived', async () => {
    const device = createECDH('prime256v1');
    device.generateKeys();
    await call(cookies.sasha, 'POST', '/api/notifications/subscribe', {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: {
        p256dh: device.getPublicKey().toString('base64url'),
        auth: Buffer.alloc(16, 1).toString('base64url'),
      },
    });
    const room = await direct(cookies.mama, ids.sasha);
    await start(cookies.mama, room.id);
    await t.app.dashboard.notify.idle();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.headers).toMatchObject({ Urgency: 'high', TTL: '40' });
  });

  it('ends when the other person declines, and says so in the chat', async () => {
    const room = await direct(cookies.mama, ids.sasha);
    const { call: started } = (await start(cookies.mama, room.id)).body;
    expect((await call(cookies.sasha, 'POST', `/api/calls/${started.id}/decline`, {})).status).toBe(204);
    expect(eventsFor(ids.mama, 'call').at(-1)).toMatchObject({
      call: { state: 'ended', endReason: 'declined' },
    });
    expect((await lines(cookies.sasha, room.id)).at(-1)).toBe('Звонок отклонён.');
  });

  it('is cancelled when the caller hangs up before an answer', async () => {
    const room = await direct(cookies.mama, ids.sasha);
    const { call: started } = (await start(cookies.mama, room.id)).body;
    await call(cookies.mama, 'POST', `/api/calls/${started.id}/leave`, {});
    expect(eventsFor(ids.sasha, 'call').at(-1)).toMatchObject({
      call: { state: 'ended', endReason: 'cancelled' },
    });
    expect((await call(cookies.sasha, 'POST', `/api/calls/${started.id}/join`, {})).status).toBe(404);
  });

  it('is missed when nobody answers: a note in the chat and a notification', async () => {
    await t.app.close();
    await boot({ dataDir: t.dataDir, callTimings: { ringMs: 60 } });
    cookies.mama = await cookieFor(t.app, FAMILY);
    online = new Set(Object.values(ids));
    const room = await direct(cookies.mama, ids.sasha);
    const { call: started } = (await start(cookies.mama, room.id)).body;
    await vi.waitFor(() =>
      expect(eventsFor(ids.sasha, 'call').at(-1)).toMatchObject({
        call: { state: 'ended', endReason: 'missed' },
      }),
    );
    expect((await lines(cookies.mama, room.id)).at(-1)).toBe('Пропущенный звонок от Мама.');
    // a missed call is news for the person who missed it, not for the caller
    expect(await unreadOf(cookies.sasha, room.id)).toBe(1);
    expect(await unreadOf(cookies.mama, room.id)).toBe(0);
    const missed = eventsFor(ids.sasha, 'notification').at(-1);
    expect(missed).toMatchObject({
      notification: { kind: 'call', title: 'Пропущенный звонок', body: 'Мама' },
    });
    expect(started.id).toBeDefined();
  });

  it('does not ring somebody who is already talking', async () => {
    const first = await direct(cookies.mama, ids.sasha);
    const second = await direct(cookies.papa, ids.sasha);
    const { call: a } = (await start(cookies.mama, first.id)).body;
    await call(cookies.sasha, 'POST', `/api/calls/${a.id}/join`, {});
    const busy = await start(cookies.papa, second.id);
    expect(busy.body.call).toMatchObject({ state: 'ended', endReason: 'busy' });
    expect(busy.body.busy).toEqual(['Саша']);
    expect(
      (await call(cookies.mama, 'POST', '/api/calls', { conversationId: second.id, video: false })).status,
    ).toBe(404);
    // a person in a call cannot start another
    expect((await start(cookies.sasha, second.id)).status).toBe(409);
    expect((await lines(cookies.papa, second.id)).at(-1)).toBe(
      'Звонок не состоялся: собеседник уже разговаривает.',
    );
  });

  it('keeps strangers out: no calling a chat you are not in, no joining, no signals', async () => {
    const room = await direct(cookies.mama, ids.sasha);
    expect((await start(cookies.papa, room.id)).status).toBe(404);
    expect((await start(cookies.papa, 'nonexistent')).status).toBe(404);
    const { call: started } = (await start(cookies.mama, room.id)).body;
    expect((await call(cookies.papa, 'POST', `/api/calls/${started.id}/join`, {})).status).toBe(404);
    expect((await call(cookies.papa, 'POST', `/api/calls/${started.id}/decline`, {})).status).toBe(404);
    await call(cookies.sasha, 'POST', `/api/calls/${started.id}/join`, {});
    const data = { type: 'offer', sdp: 'x' };
    expect(
      (
        await call(cookies.papa, 'POST', `/api/calls/${started.id}/signal`, {
          to: ids.mama,
          type: 'offer',
          data,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(cookies.mama, 'POST', `/api/calls/${started.id}/signal`, {
          to: ids.papa,
          type: 'offer',
          data,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(cookies.mama, 'POST', `/api/calls/${started.id}/signal`, {
          to: ids.mama,
          type: 'offer',
          data,
        })
      ).status,
    ).toBe(409);
    expect(eventsFor(ids.papa, 'signal')).toHaveLength(0);
    expect(eventsFor(ids.papa, 'call')).toHaveLength(0);
  });

  it('checks the setup messages: right type, bounded size', async () => {
    const room = await direct(cookies.mama, ids.sasha);
    const { call: started } = (await start(cookies.mama, room.id)).body;
    await call(cookies.sasha, 'POST', `/api/calls/${started.id}/join`, {});
    const signal = (data: unknown, type = 'offer') =>
      call(cookies.mama, 'POST', `/api/calls/${started.id}/signal`, { to: ids.sasha, type, data });
    expect((await signal({ type: 'answer', sdp: 'x' })).status).toBe(400);
    expect((await signal({ type: 'offer' })).status).toBe(400);
    expect((await signal('text')).status).toBe(400);
    expect((await signal({ type: 'offer', sdp: 'x'.repeat(30_000) })).status).toBe(413);
    expect((await signal(null, 'candidate')).status).toBe(400);
    expect((await signal({ x: 1 }, 'wrong')).status).toBe(400);
  });

  it('limits how often a person can start calls', async () => {
    const room = await direct(cookies.mama, ids.sasha);
    for (let i = 0; i < 10; i += 1) {
      const res = await start(cookies.mama, room.id);
      expect(res.status).toBe(200);
      await call(cookies.mama, 'POST', `/api/calls/${res.body.call.id}/leave`, {});
    }
    expect((await start(cookies.mama, room.id)).status).toBe(429);
  });

  it('puts a call back on the screen after a reload', async () => {
    const room = await direct(cookies.mama, ids.sasha);
    const { call: started } = (await start(cookies.mama, room.id)).body;
    expect((await call<{ call: CallInfo }>(cookies.sasha, 'GET', '/api/calls/active')).body.call?.id).toBe(
      started.id,
    );
    expect((await call<{ call: CallInfo }>(cookies.mama, 'GET', '/api/calls/active')).body.call?.id).toBe(
      started.id,
    );
    expect((await call(cookies.papa, 'GET', '/api/calls/active')).body).toEqual({ call: null });
    await call(cookies.sasha, 'POST', `/api/calls/${started.id}/decline`, {});
    expect((await call(cookies.sasha, 'GET', '/api/calls/active')).body).toEqual({ call: null });
  });
});

describe('a call in the family room', () => {
  it('rings everybody and takes at most four', async () => {
    const extra = [];
    for (const name of ['olya', 'dima']) {
      const user = await addUser(t.dataDir, t.clock, {
        username: name,
        password: `${name}-password-1`,
        displayName: name,
      });
      extra.push({
        id: user.id,
        cookie: await cookieFor(t.app, { username: name, password: `${name}-password-1` }),
      });
    }
    online = new Set([...Object.values(ids), ...extra.map((item) => item.id)]);
    const { call: started } = (await start(cookies.mama, 'family')).body;
    expect(started.participants).toHaveLength(5);
    const everyone = [cookies.papa, cookies.sasha, extra[0]?.cookie as string];
    for (const cookie of everyone) {
      expect((await call(cookie, 'POST', `/api/calls/${started.id}/join`, {})).status).toBe(200);
    }
    const last = await call(extra[1]?.cookie as string, 'POST', `/api/calls/${started.id}/join`, {});
    expect(last.status).toBe(409);
    expect((last.body as { error: string }).error).toBe('full');
    // the second joiner is told to offer to the first one only
    const third = eventsFor(ids.papa, 'call').length;
    expect(third).toBeGreaterThan(0);
    // somebody leaves; the call goes on until one person is left
    await call(cookies.sasha, 'POST', `/api/calls/${started.id}/leave`, {});
    expect((await call<{ call: CallInfo }>(cookies.mama, 'GET', '/api/calls/active')).body.call?.state).toBe(
      'active',
    );
  });
});

describe('a person who disappears', () => {
  it('is dropped after a while, and the call ends for the other one', async () => {
    await t.app.close();
    await boot({ dataDir: t.dataDir, callTimings: { checkMs: 20 } });
    cookies.mama = await cookieFor(t.app, FAMILY);
    online = new Set([ids.mama, ids.sasha]);
    const room = await direct(cookies.mama, ids.sasha);
    const { call: started } = (await start(cookies.mama, room.id)).body;
    await call(cookies.sasha, 'POST', `/api/calls/${started.id}/join`, {});
    online.delete(ids.sasha); // closed the lid
    await vi.waitFor(
      () => expect(eventsFor(ids.mama, 'call').at(-1)).toMatchObject({ call: { state: 'ended' } }),
      { timeout: 2000 },
    );
  });
});
