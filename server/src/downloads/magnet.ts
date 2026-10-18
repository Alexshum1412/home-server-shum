/**
 * Magnet links: only the info-hash, the display name and trackers are kept. Everything else in a
 * magnet (`ws=`/`as=`/`xs=` — addresses to fetch from) is dropped, so the client cannot be sent to
 * an address of the sender's choosing.
 */

export interface Magnet {
  /** 40 hex characters, lowercase. */
  infoHash: string;
  name: string | null;
  trackers: string[];
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(value: string): string | null {
  let bits = '';
  for (const char of value.toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) return null;
    bits += index.toString(2).padStart(5, '0');
  }
  if (bits.length !== 160) return null;
  let hex = '';
  for (let i = 0; i < 160; i += 4) hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function parseMagnet(raw: string): Magnet | null {
  const trimmed = raw.trim();
  if (trimmed.length > 4096 || !/^magnet:\?/i.test(trimmed)) return null;
  let params: URLSearchParams;
  try {
    params = new URL(trimmed).searchParams;
  } catch {
    return null;
  }
  let infoHash: string | null = null;
  for (const topic of params.getAll('xt')) {
    const match = /^urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/.exec(topic);
    if (!match?.[1]) continue;
    infoHash = match[1].length === 40 ? match[1].toLowerCase() : base32ToHex(match[1]);
    if (infoHash) break;
  }
  if (!infoHash) return null;
  const name = params.get('dn')?.trim().slice(0, 200) || null;
  return { infoHash, name, trackers: [...new Set(params.getAll('tr'))].slice(0, 60) };
}

/** A fresh magnet with only the checked parts. */
export function buildMagnet(magnet: Magnet, trackers: readonly string[]): string {
  const query = [`xt=urn:btih:${magnet.infoHash}`];
  if (magnet.name) query.push(`dn=${encodeURIComponent(magnet.name)}`);
  for (const tracker of trackers) query.push(`tr=${encodeURIComponent(tracker)}`);
  return `magnet:?${query.join('&')}`;
}
