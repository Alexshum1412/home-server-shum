/**
 * Voice and video calls: the server only introduces the devices to each other.
 *
 * The call itself (WebRTC) goes straight between the devices; this module keeps the list of who is
 * ringing and who is in, and passes the small setup messages (offer, answer, ICE candidates) from one
 * person to another over the live-event channel. It never sees audio or video.
 *
 * - Only members of a chat can call it, and only they hear it ring.
 * - A call has at most MAX_PARTICIPANTS people (every device talks to every other one).
 * - A person who vanishes (closed lid, lost network) is dropped after ~30 s, so a call cannot hang.
 */
import { createHmac } from 'node:crypto';
import type {
  CallConfigResponse,
  CallEndReason,
  CallIceServer,
  CallInfo,
  CallState,
  SignalType,
} from '../../../shared/api.ts';
import { isDisabled, type StoredUser, type UserStore } from '../auth/users.ts';
import type { ChatService } from '../chat/service.ts';
import { newId } from '../lib/ids.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import type { NotificationCenter } from '../notify/center.ts';
import type { RealtimeHub } from '../realtime/hub.ts';

export const MAX_PARTICIPANTS = 4;
export const RING_MS = 45_000;
export const MAX_CALL_MS = 6 * 60 * 60 * 1000;
const CHECK_MS = 10_000;
/** Consecutive checks (CHECK_MS apart) without a live connection before a person is dropped. */
const OFFLINE_STRIKES = 3;
export const SIGNAL_MAX_BYTES = 24 * 1024;

export class CallError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface CallSettings {
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  turnSecret: string | null;
  turnTtlSec: number;
}

interface Call {
  id: string;
  conversationId: string;
  title: string;
  initiatorId: string;
  video: boolean;
  invited: Set<string>;
  joined: Set<string>;
  declined: Set<string>;
  state: CallState;
  endReason: CallEndReason | null;
  startedAt: string;
  answeredAt: number | null;
  ringTimer: NodeJS.Timeout | null;
  strikes: Map<string, number>;
}

export interface CallManager {
  config(me: StoredUser): CallConfigResponse;
  start(me: StoredUser, conversationId: string, video: boolean): Promise<{ call: CallInfo; busy: string[] }>;
  join(me: StoredUser, callId: string): Promise<{ call: CallInfo; peers: string[] }>;
  decline(me: StoredUser, callId: string): Promise<void>;
  leave(me: StoredUser, callId: string): Promise<void>;
  signal(me: StoredUser, callId: string, to: string, type: SignalType, data: unknown): void;
  active(me: StoredUser): Promise<CallInfo | null>;
  /** Drops a person from every call (account removed). */
  dropUser(userId: string): Promise<void>;
  stop(): void;
}

export interface CallManagerOptions {
  chat: ChatService;
  users: UserStore;
  hub: RealtimeHub;
  notify: NotificationCenter;
  clock: Clock;
  settings: CallSettings;
  ringMs?: number;
  checkMs?: number;
}

function duration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин ${seconds} с`;
  return `${seconds} с`;
}

export function createCallManager(options: CallManagerOptions): CallManager {
  const { chat, users, hub, notify, clock, settings } = options;
  const calls = new Map<string, Call>();
  const ringMs = options.ringMs ?? RING_MS;

  const involved = (call: Call): string[] => [
    ...new Set([call.initiatorId, ...call.invited, ...call.joined]),
  ];

  async function names(): Promise<Map<string, string>> {
    return new Map((await users.list()).map((user) => [user.id, user.displayName]));
  }

  async function view(call: Call): Promise<CallInfo> {
    const dir = await names();
    const person = (id: string) => ({ id, displayName: dir.get(id) ?? 'Бывший участник' });
    return {
      id: call.id,
      conversationId: call.conversationId,
      video: call.video,
      initiator: person(call.initiatorId),
      participants: [call.initiatorId, ...call.invited]
        .filter((id, index, all) => all.indexOf(id) === index)
        .map((id) => ({ ...person(id), joined: call.joined.has(id), declined: call.declined.has(id) })),
      state: call.state,
      endReason: call.endReason,
      startedAt: call.startedAt,
    };
  }

  async function publish(call: Call): Promise<void> {
    hub.publish(involved(call), { type: 'call', call: await view(call) });
  }

  function inCall(userId: string): Call | undefined {
    for (const call of calls.values()) {
      if (call.state !== 'ended' && call.joined.has(userId)) return call;
    }
    return undefined;
  }

  async function end(call: Call, reason: CallEndReason): Promise<void> {
    if (call.state === 'ended') return;
    const wasAnswered = call.answeredAt !== null;
    call.state = 'ended';
    call.endReason = reason;
    if (call.ringTimer) clearTimeout(call.ringTimer);
    call.ringTimer = null;
    const peopleToTell = involved(call);
    const info = await view(call);
    hub.publish(peopleToTell, { type: 'call', call: info });
    calls.delete(call.id);
    const dir = await names();
    const initiator = dir.get(call.initiatorId) ?? 'Участник';
    const kind = call.video ? 'Видеозвонок' : 'Звонок';
    let line: string;
    switch (reason) {
      case 'missed':
        line = `Пропущенный ${call.video ? 'видеозвонок' : 'звонок'} от ${initiator}.`;
        break;
      case 'declined':
        line = `${kind} отклонён.`;
        break;
      case 'cancelled':
        line = `${kind} отменён: ${initiator} положил(а) трубку до ответа.`;
        break;
      case 'busy':
        line = `${kind} не состоялся: собеседник уже разговаривает.`;
        break;
      case 'failed':
        line = `${kind} прервался: не удалось соединиться.`;
        break;
      default:
        line = wasAnswered
          ? `${kind} завершён, длился ${duration(clock().getTime() - (call.answeredAt ?? clock().getTime()))}.`
          : `${kind} завершён.`;
    }
    const missed =
      reason === 'missed'
        ? [...call.invited].filter((id) => !call.joined.has(id) && !call.declined.has(id))
        : [];
    await chat
      .addSystem(
        call.conversationId,
        line,
        reason === 'missed' ? 'call-missed' : 'call',
        reason === 'missed' ? missed : undefined,
      )
      .catch(() => undefined);
    if (reason === 'missed') {
      await notify
        .notify({
          users: missed,
          kind: 'call',
          title: 'Пропущенный звонок',
          body: initiator,
          url: `/chat?c=${call.conversationId}`,
          ttlSec: 3 * 24 * 3600,
          topic: `call-${call.id.slice(0, 8)}`,
        })
        .catch(() => undefined);
    }
  }

  /** People who are not connected to the portal at all cannot be in a call: drop them after a while. */
  async function sweep(): Promise<void> {
    const now = clock().getTime();
    for (const call of [...calls.values()]) {
      if (call.state === 'ended') continue;
      if (call.state === 'active' && call.answeredAt !== null && now - call.answeredAt > MAX_CALL_MS) {
        await end(call, 'hangup');
        continue;
      }
      for (const id of [...call.joined]) {
        if (hub.isOnline(id)) {
          call.strikes.delete(id);
          continue;
        }
        const strikes = (call.strikes.get(id) ?? 0) + 1;
        call.strikes.set(id, strikes);
        if (strikes >= OFFLINE_STRIKES) await removeJoined(call, id);
      }
    }
  }

  async function removeJoined(call: Call, userId: string): Promise<void> {
    call.joined.delete(userId);
    call.strikes.delete(userId);
    if (call.state === 'ringing' && userId === call.initiatorId) return end(call, 'cancelled');
    if (call.joined.size < 2 && call.state === 'active') return end(call, 'hangup');
    if (call.joined.size === 0) return end(call, 'hangup');
    await publish(call);
  }

  const timer = setInterval(() => void sweep().catch(() => undefined), options.checkMs ?? CHECK_MS);
  timer.unref();

  function find(callId: string): Call {
    const call = calls.get(callId);
    if (!call || call.state === 'ended') throw new CallError(404, 'not_found', 'Этот звонок уже закончился.');
    return call;
  }

  return {
    config(me) {
      const iceServers: CallIceServer[] = [];
      if (settings.stunUrls.length > 0) iceServers.push({ urls: [...settings.stunUrls] });
      let relay: CallConfigResponse['relay'] = settings.stunUrls.length > 0 ? 'stun' : 'none';
      if (settings.turnUrls.length > 0 && settings.turnSecret) {
        // coturn "REST API" credentials: valid for a short time, nothing permanent is handed out.
        const username = `${Math.floor(clock().getTime() / 1000) + settings.turnTtlSec}:${me.id}`;
        const credential = createHmac('sha1', settings.turnSecret).update(username).digest('base64');
        iceServers.push({ urls: [...settings.turnUrls], username, credential });
        relay = 'turn';
      }
      return { iceServers, maxParticipants: MAX_PARTICIPANTS, relay };
    },

    async start(me, conversationId, video) {
      const audience = await chat.audience(conversationId);
      if (!audience?.ids.includes(me.id)) {
        throw new CallError(404, 'not_found', 'Такого чата нет.');
      }
      if (inCall(me.id))
        throw new CallError(409, 'in_call', 'Вы уже разговариваете. Сначала завершите тот звонок.');
      const existing = [...calls.values()].find(
        (call) => call.conversationId === conversationId && call.state !== 'ended',
      );
      if (existing)
        throw new CallError(409, 'call_exists', 'В этом чате уже идёт звонок. Присоединитесь к нему.');
      const known = new Set((await users.list()).filter((user) => !isDisabled(user)).map((user) => user.id));
      const invitees = audience.ids.filter((id) => id !== me.id && known.has(id));
      if (invitees.length === 0) throw new CallError(409, 'nobody', 'В этом чате некому звонить.');
      const busy = invitees.filter((id) => inCall(id) !== undefined);
      const call: Call = {
        id: newId(),
        conversationId,
        title: audience.title,
        initiatorId: me.id,
        video,
        invited: new Set(invitees.filter((id) => !busy.includes(id))),
        joined: new Set([me.id]),
        declined: new Set(),
        state: 'ringing',
        endReason: null,
        startedAt: isoNow(clock),
        answeredAt: null,
        ringTimer: null,
        strikes: new Map(),
      };
      const dir = await names();
      calls.set(call.id, call);
      if (call.invited.size === 0) {
        await end(call, 'busy');
        return { call: await view(call), busy: busy.map((id) => dir.get(id) ?? '') };
      }
      call.ringTimer = setTimeout(() => void end(call, 'missed').catch(() => undefined), ringMs);
      call.ringTimer.unref();
      await publish(call);
      void notify
        .notify({
          users: [...call.invited],
          kind: 'call',
          title: `${me.displayName} звонит`,
          body: video ? 'Видеозвонок' : 'Голосовой звонок',
          url: `/chat?c=${conversationId}&call=${call.id}`,
          feed: false,
          ttlSec: 40,
          urgency: 'high',
          topic: `call-${call.id.slice(0, 8)}`,
        })
        .catch(() => undefined);
      return { call: await view(call), busy: busy.map((id) => dir.get(id) ?? '') };
    },

    async join(me, callId) {
      const call = find(callId);
      if (!call.invited.has(me.id) && call.initiatorId !== me.id) {
        throw new CallError(404, 'not_found', 'Этот звонок уже закончился.');
      }
      const other = inCall(me.id);
      if (other && other.id !== call.id)
        throw new CallError(409, 'in_call', 'Вы уже разговариваете в другом звонке.');
      if (!call.joined.has(me.id) && call.joined.size >= MAX_PARTICIPANTS) {
        throw new CallError(409, 'full', `В звонке уже ${MAX_PARTICIPANTS} человека — это предел.`);
      }
      const peers = [...call.joined].filter((id) => id !== me.id);
      call.joined.add(me.id);
      call.declined.delete(me.id);
      call.strikes.delete(me.id);
      if (call.state === 'ringing' && call.joined.size >= 2) {
        call.state = 'active';
        call.answeredAt = clock().getTime();
        if (call.ringTimer) clearTimeout(call.ringTimer);
        call.ringTimer = null;
      }
      await publish(call);
      return { call: await view(call), peers };
    },

    async decline(me, callId) {
      const call = find(callId);
      if (!call.invited.has(me.id)) throw new CallError(404, 'not_found', 'Этот звонок уже закончился.');
      call.declined.add(me.id);
      const waiting = [...call.invited].filter((id) => !call.declined.has(id) && !call.joined.has(id));
      if (call.state === 'ringing' && waiting.length === 0) return end(call, 'declined');
      await publish(call);
    },

    async leave(me, callId) {
      const call = calls.get(callId);
      if (!call || call.state === 'ended') return;
      if (call.joined.has(me.id)) return removeJoined(call, me.id);
      // Hanging up the ringing screen without having joined counts as declining.
      if (call.invited.has(me.id)) return this.decline(me, callId);
    },

    signal(me, callId, to, type, data) {
      const call = find(callId);
      if (!call.joined.has(me.id) || !call.joined.has(to) || to === me.id) {
        throw new CallError(409, 'not_in_call', 'Собеседник уже не в звонке.');
      }
      const size = JSON.stringify(data ?? null).length;
      if (size > SIGNAL_MAX_BYTES) throw new CallError(413, 'too_large', 'Слишком большое сообщение.');
      if (type !== 'candidate') {
        const sdp = data as { type?: unknown; sdp?: unknown } | null;
        if (!sdp || typeof sdp !== 'object' || typeof sdp.sdp !== 'string' || sdp.type !== type) {
          throw new CallError(400, 'bad_signal', 'Некорректное сообщение для соединения.');
        }
      } else if (typeof data !== 'object' || data === null) {
        throw new CallError(400, 'bad_signal', 'Некорректное сообщение для соединения.');
      }
      hub.publish([to], { type: 'signal', callId, from: me.id, signal: type, data });
    },

    async active(me) {
      for (const call of calls.values()) {
        if (call.state === 'ended') continue;
        if (call.joined.has(me.id) || (call.invited.has(me.id) && !call.declined.has(me.id)))
          return view(call);
      }
      return null;
    },

    async dropUser(userId) {
      for (const call of [...calls.values()]) {
        if (call.joined.has(userId)) await removeJoined(call, userId);
        else if (call.invited.has(userId)) {
          call.invited.delete(userId);
          call.declined.delete(userId);
        }
      }
    },

    stop() {
      clearInterval(timer);
      for (const call of calls.values()) {
        if (call.ringTimer) clearTimeout(call.ringTimer);
      }
      calls.clear();
    },
  };
}
