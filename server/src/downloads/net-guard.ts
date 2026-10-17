/**
 * SSRF guard for the download queue: the server only fetches from public internet addresses.
 * The check runs inside the socket's own DNS lookup, so the address that is checked is the
 * address that is connected to (no gap for DNS rebinding), and again for every redirect.
 */
import dns from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/** Never reachable from the download queue: this PC, the home LAN, the tailnet and special ranges. */
const BLOCKED = new BlockList();
const V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, also every Tailscale address
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: may embed a private IPv4 address
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['fc00::', 7], // unique local, including the Tailscale ULA range
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of V4) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) BLOCKED.addSubnet(net, prefix, 'ipv6');
BLOCKED.addAddress('255.255.255.255', 'ipv4');

/** True for an address the queue may connect to. IPv4-mapped IPv6 is checked as IPv4. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKEDADDRESS';
}

export const BLOCKED_MESSAGE =
  'Этот адрес ведёт внутрь домашней сети или на сам сервер — такие загрузки запрещены.';

export interface UrlProblem {
  code: 'bad_url' | 'private_address';
  message: string;
}

/** Validates a user-supplied download URL before any network access. */
export function checkDownloadUrl(
  raw: string,
  allow: (address: string) => boolean = isPublicAddress,
): { url: URL } | UrlProblem {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { code: 'bad_url', message: 'Это не похоже на адрес файла. Пример: https://example.com/file.pdf' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { code: 'bad_url', message: 'Поддерживаются только ссылки http:// и https://.' };
  }
  if (url.username || url.password) {
    return { code: 'bad_url', message: 'Ссылки с логином и паролем внутри не поддерживаются.' };
  }
  if (url.href.length > 2048) return { code: 'bad_url', message: 'Слишком длинная ссылка.' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && !allow(host)) return { code: 'private_address', message: BLOCKED_MESSAGE };
  if (
    /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa|.*\.ts\.net)\.?$/i.test(host)
  ) {
    return { code: 'private_address', message: BLOCKED_MESSAGE };
  }
  return { url };
}

/** dns.lookup that refuses names resolving to any non-public address. */
export function createSafeLookup(allow: (address: string) => boolean = isPublicAddress): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    const literal = isIP(hostname);
    const resolve = (cb: (error: NodeJS.ErrnoException | null, list: dns.LookupAddress[]) => void) => {
      if (literal !== 0) {
        cb(null, [{ address: hostname, family: literal }]);
        return;
      }
      dns.lookup(hostname, { ...options, all: true }, (error, list) => cb(error, list ?? []));
    };
    resolve((error, list) => {
      if (error) {
        callback(error);
        return;
      }
      // Any private answer taints the name: a split answer is a rebinding attempt.
      if (list.length === 0 || list.some((entry) => !allow(entry.address))) {
        callback(new BlockedAddressError(BLOCKED_MESSAGE));
        return;
      }
      if (options.all) callback(null, list);
      else callback(null, list[0]?.address, list[0]?.family);
    });
  }) as LookupFunction;
}
