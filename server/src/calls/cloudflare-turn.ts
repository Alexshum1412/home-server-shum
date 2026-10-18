/**
 * Short-lived TURN credentials from Cloudflare Realtime TURN (a relay for calls that cannot connect
 * directly). Off unless the owner created a TURN key in their own Cloudflare account and put the key id in
 * CALLS_CF_TURN_KEY_ID and the API token into a file named by CALLS_CF_TURN_TOKEN_FILE (never into Git or
 * the environment). The portal asks Cloudflare for credentials valid for a few hours; the relay sees only
 * encrypted media and the devices' addresses. If Cloudflare does not answer, calls simply go without a relay.
 */
import { readFile } from 'node:fs/promises';
import type { CallIceServer } from '../../../shared/api.ts';
import type { Clock } from '../lib/time.ts';

export const CLOUDFLARE_TURN_HOST = 'https://rtc.live.cloudflare.com';
const KEY_ID_RE = /^[0-9a-f]{32}$/i;
const URL_RE = /^(stun|stuns|turn|turns):[^\s]+$/i;

export interface CloudflareTurnSettings {
  keyId: string;
  tokenFile: string;
  /** How long the credentials live; a fresh set is asked for a little before they run out. */
  ttlSec: number;
}

export interface CloudflareTurn {
  /** ICE servers with credentials, or null when Cloudflare could not be reached. */
  iceServers(): Promise<CallIceServer[] | null>;
}

export function isValidKeyId(value: string): boolean {
  return KEY_ID_RE.test(value);
}

/** Cloudflare answers {iceServers: [{urls, username, credential}]}; an older shape had one object instead of a list. */
export function parseIceServers(body: unknown): CallIceServer[] {
  const raw = (body as { iceServers?: unknown } | null)?.iceServers;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const servers: CallIceServer[] = [];
  for (const entry of list) {
    const item = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(item.urls) ? item.urls : [item.urls]).filter(
      (url): url is string => typeof url === 'string' && URL_RE.test(url),
    );
    if (urls.length === 0) continue;
    const server: CallIceServer = { urls };
    if (typeof item.username === 'string' && typeof item.credential === 'string') {
      server.username = item.username;
      server.credential = item.credential;
    }
    servers.push(server);
  }
  return servers;
}

export function createCloudflareTurn(options: {
  settings: CloudflareTurnSettings;
  clock: Clock;
  fetch?: typeof fetch;
  onError?: (message: string) => void;
}): CloudflareTurn {
  const { settings, clock } = options;
  const doFetch = options.fetch ?? fetch;
  let cached: { servers: CallIceServer[]; until: number } | null = null;
  let inflight: Promise<CallIceServer[] | null> | null = null;

  async function ask(): Promise<CallIceServer[] | null> {
    try {
      const token = (await readFile(settings.tokenFile, 'utf8')).trim();
      if (token === '') throw new Error('файл с токеном пуст');
      const response = await doFetch(
        `${CLOUDFLARE_TURN_HOST}/v1/turn/keys/${settings.keyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl: settings.ttlSec }),
          signal: AbortSignal.timeout(6000),
        },
      );
      if (!response.ok) throw new Error(`Cloudflare ответил ${response.status}`);
      const servers = parseIceServers(await response.json());
      if (servers.length === 0) throw new Error('Cloudflare не прислал адресов ретранслятора');
      // Asked again after three quarters of the lifetime, so nobody gets credentials that expire mid-call.
      cached = { servers, until: clock().getTime() + settings.ttlSec * 750 };
      return servers;
    } catch (error) {
      options.onError?.(`Ретранслятор звонков (Cloudflare) недоступен: ${(error as Error).message}`);
      return null;
    }
  }

  return {
    async iceServers() {
      if (cached && clock().getTime() < cached.until) return cached.servers;
      inflight ??= ask().finally(() => {
        inflight = null;
      });
      const fresh = await inflight;
      // A failed refresh keeps handing out the old set while it is still valid (a few hours).
      return (
        fresh ?? (cached && clock().getTime() < cached.until + settings.ttlSec * 250 ? cached.servers : null)
      );
    },
  };
}
