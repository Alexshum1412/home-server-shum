/**
 * One live connection to the server (Server-Sent Events) for the whole open portal: new messages,
 * calls, notifications arrive at once. If it breaks, the browser reconnects by itself; after every
 * reconnect the server says «hello», and the pages reload what they show so nothing is missed.
 *
 * Without live events (an old proxy that holds the stream, a blocked connection) every page still
 * works: lists refresh on a timer and when the page becomes visible again.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RealtimeEvent } from '../../../shared/api.ts';

export type RealtimeStatus = 'connecting' | 'live' | 'offline';
type Listener = (event: RealtimeEvent) => void;

const TYPES: ReadonlyArray<RealtimeEvent['type']> = [
  'hello',
  'message',
  'conversation',
  'read',
  'call',
  'signal',
  'notification',
];

const listeners = new Set<Listener>();
const statusListeners = new Set<(status: RealtimeStatus) => void>();
let status: RealtimeStatus = 'connecting';
let source: EventSource | null = null;
let users = 0;

function setStatus(next: RealtimeStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener(next);
}

function emit(event: RealtimeEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.warn('Ошибка в обработчике событий', error);
    }
  }
}

function open(): void {
  if (source || typeof EventSource === 'undefined') return;
  setStatus('connecting');
  const next = new EventSource('/api/events');
  source = next;
  next.onopen = () => setStatus('live');
  next.onerror = () => setStatus(next.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
  for (const type of TYPES) {
    next.addEventListener(type, (message) => {
      try {
        emit(JSON.parse((message as MessageEvent<string>).data) as RealtimeEvent);
      } catch {
        // a damaged event is skipped
      }
    });
  }
}

function close(): void {
  source?.close();
  source = null;
  setStatus('connecting');
}

/** Keeps the connection open while at least one component asks for it (the signed-in app). */
export function useRealtimeConnection(): void {
  useEffect(() => {
    users += 1;
    open();
    return () => {
      users -= 1;
      if (users === 0) close();
    };
  }, []);
}

/** Calls `handler` for every live event while the component is mounted. */
export function useRealtime(handler: Listener): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener: Listener = (event) => latest.current(event);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}

export function useRealtimeStatus(): RealtimeStatus {
  const [value, setValue] = useState(status);
  useEffect(() => {
    statusListeners.add(setValue);
    setValue(status);
    return () => {
      statusListeners.delete(setValue);
    };
  }, []);
  return value;
}
