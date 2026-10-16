import type { Clock } from '../lib/time.ts';

export interface LimitCheck {
  allowed: boolean;
  /** Seconds until the next attempt is allowed (0 when allowed). */
  retryAfterSec: number;
}

export interface SlidingWindowLimiter {
  check(key: string): LimitCheck;
  hit(key: string): void;
  reset(key: string): void;
}

export interface SlidingWindowOptions {
  limit: number;
  windowMs: number;
  clock: Clock;
  /** Upper bound on tracked keys so random usernames cannot exhaust memory. */
  maxKeys?: number;
}

/** In-memory sliding-window counter of events per key. */
export function createSlidingWindowLimiter(options: SlidingWindowOptions): SlidingWindowLimiter {
  const { limit, windowMs, clock } = options;
  const maxKeys = options.maxKeys ?? 10_000;
  const hits = new Map<string, number[]>();

  function recent(key: string, now: number): number[] {
    const list = hits.get(key);
    if (!list) return [];
    const fresh = list.filter((time) => now - time < windowMs);
    if (fresh.length === 0) hits.delete(key);
    else if (fresh.length !== list.length) hits.set(key, fresh);
    return fresh;
  }

  function prune(now: number): void {
    for (const key of [...hits.keys()]) recent(key, now);
    // Still too many: drop the oldest keys (Map keeps insertion order).
    for (const key of hits.keys()) {
      if (hits.size <= maxKeys) break;
      hits.delete(key);
    }
  }

  return {
    check(key) {
      const now = clock().getTime();
      const list = recent(key, now);
      if (list.length < limit) return { allowed: true, retryAfterSec: 0 };
      const oldestRelevant = list[list.length - limit] ?? now;
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((oldestRelevant + windowMs - now) / 1000)),
      };
    },
    hit(key) {
      const now = clock().getTime();
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
      if (hits.size > maxKeys) prune(now);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FAILURES_PER_USER = 10;
export const LOGIN_FAILURES_PER_IP = 30;

export interface LoginLimiter {
  byUser: SlidingWindowLimiter;
  byIp: SlidingWindowLimiter;
}

export function createLoginLimiter(clock: Clock): LoginLimiter {
  return {
    byUser: createSlidingWindowLimiter({ limit: LOGIN_FAILURES_PER_USER, windowMs: LOGIN_WINDOW_MS, clock }),
    byIp: createSlidingWindowLimiter({ limit: LOGIN_FAILURES_PER_IP, windowMs: LOGIN_WINDOW_MS, clock }),
  };
}
