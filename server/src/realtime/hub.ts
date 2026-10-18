/**
 * Live events for open pages (new messages, calls, notifications) over Server-Sent Events.
 *
 * One-way (server → page) on purpose: plain HTTP that passes through Tailscale Serve and a tunnel
 * unchanged, needs no extra package and reconnects by itself. Everything the page sends goes through
 * ordinary POST requests, which have their own checks.
 *
 * An event is delivered only to the people the caller names; a connection stays open only while its
 * session is valid (re-checked at every keep-alive).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RealtimeEvent } from '../../../shared/api.ts';
import { type Clock, isoNow } from '../lib/time.ts';

export const KEEPALIVE_MS = 20_000;
/** A page with more connections than this (tabs, devices) closes its oldest ones. */
export const MAX_CONNECTIONS_PER_USER = 6;
/** A reader that does not read (frozen tab, dead network) is dropped instead of piling up memory. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

interface Connection {
  readonly reply: FastifyReply;
  readonly raw: FastifyReply['raw'];
  readonly isValid: () => boolean;
  timer: NodeJS.Timeout;
}

export interface RealtimeHub {
  /** Takes over the response of an authenticated request and keeps it open. */
  attach(request: FastifyRequest, reply: FastifyReply, userId: string, isValid: () => boolean): void;
  /** Sends `event` to every open connection of the listed people. */
  publish(userIds: Iterable<string>, event: RealtimeEvent): void;
  isOnline(userId: string): boolean;
  connectionCount(): number;
  /** Ends every connection (server shutdown). */
  closeAll(): void;
}

export interface RealtimeHubOptions {
  clock: Clock;
  /** Security headers every response carries (the hub answers outside the normal onSend hook). */
  headers: Readonly<Record<string, string>>;
  keepaliveMs?: number;
}

function frame(event: RealtimeEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createRealtimeHub(options: RealtimeHubOptions): RealtimeHub {
  const byUser = new Map<string, Set<Connection>>();
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;

  function drop(userId: string, connection: Connection): void {
    clearInterval(connection.timer);
    const set = byUser.get(userId);
    set?.delete(connection);
    if (set && set.size === 0) byUser.delete(userId);
    if (!connection.raw.writableEnded && !connection.raw.destroyed) connection.raw.end();
  }

  function write(userId: string, connection: Connection, text: string): void {
    const { raw } = connection;
    if (raw.destroyed || raw.writableEnded || raw.writableLength > MAX_BUFFERED_BYTES) {
      drop(userId, connection);
      return;
    }
    raw.write(text);
  }

  return {
    attach(_request, reply, userId, isValid) {
      // The answer leaves the normal reply pipeline: headers set so far (a renewed session cookie)
      // are kept, the usual security headers are added by hand.
      const headers: Record<string, string | number | string[] | undefined> = {
        ...reply.getHeaders(),
        ...options.headers,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        // Tells reverse proxies not to hold the stream back.
        'X-Accel-Buffering': 'no',
      };
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, headers);
      raw.socket?.setNoDelay(true);
      raw.socket?.setKeepAlive(true, 30_000);

      const connection: Connection = {
        reply,
        raw,
        isValid,
        timer: setInterval(() => {
          if (connection.isValid()) write(userId, connection, ': ping\n\n');
          else drop(userId, connection);
        }, keepaliveMs),
      };
      connection.timer.unref();

      let set = byUser.get(userId);
      if (!set) {
        set = new Set();
        byUser.set(userId, set);
      }
      set.add(connection);
      while (set.size > MAX_CONNECTIONS_PER_USER) {
        const oldest = set.values().next().value;
        if (oldest) drop(userId, oldest);
      }
      raw.on('close', () => drop(userId, connection));
      // `retry` — how long the browser waits before it reconnects.
      raw.write(`retry: 3000\n${frame({ type: 'hello', at: isoNow(options.clock) })}`);
    },

    publish(userIds, event) {
      const text = frame(event);
      for (const userId of new Set(userIds)) {
        const set = byUser.get(userId);
        if (!set) continue;
        for (const connection of [...set]) write(userId, connection, text);
      }
    },

    isOnline: (userId) => (byUser.get(userId)?.size ?? 0) > 0,

    connectionCount() {
      let total = 0;
      for (const set of byUser.values()) total += set.size;
      return total;
    },

    closeAll() {
      for (const [userId, set] of [...byUser]) {
        for (const connection of [...set]) drop(userId, connection);
      }
    },
  };
}
