import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { NetworkDevice } from '../../../shared/extras.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';

const run = promisify(execFile);
const ONLINE_MS = 15 * 60_000;

export interface Neighbor {
  ip: string;
  mac: string;
}

/** Lines like «  192.168.1.20   aa-bb-cc-dd-ee-ff   dynamic» of `arp -a`, without multicast and broadcast. */
export function parseArp(text: string): Neighbor[] {
  const out: Neighbor[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\b/i.exec(line);
    if (!match) continue;
    const ip = match[1] as string;
    const mac = (match[2] as string).toLowerCase().replace(/:/g, '-');
    const first = Number(ip.split('.')[0]);
    const last = Number(ip.split('.')[3]);
    if (first >= 224 || last === 255 || mac === 'ff-ff-ff-ff-ff-ff' || mac.startsWith('01-00-5e')) continue;
    out.push({ ip, mac });
  }
  return out;
}

/** The own home network: the first private IPv4 address of this computer with a /24 mask (anything bigger is not swept). */
export function ownSubnet(): { prefix: string; self: string } | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const [a, b] = item.address.split('.').map(Number) as [number, number];
      const privateRange = a === 192 && b === 168 ? true : a === 10 ? true : a === 172 && b >= 16 && b <= 31;
      if (!privateRange || item.netmask !== '255.255.255.0') continue;
      return { prefix: item.address.split('.').slice(0, 3).join('.'), self: item.address };
    }
  }
  return null;
}

async function readNeighbors(): Promise<Neighbor[]> {
  const { stdout } = await run('arp.exe', ['-a'], { windowsHide: true, timeout: 10_000 });
  return parseArp(stdout);
}

/** Asks every address of the own /24 once, so that the neighbour table fills up. Only on the administrator's click. */
async function sweep(prefix: string): Promise<void> {
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const ip = hosts[next++] as string;
      await run('ping.exe', ['-n', '1', '-w', '300', ip], { windowsHide: true, timeout: 5000 }).catch(
        () => undefined,
      );
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
}

interface Stored {
  ip: string;
  name: string;
  known: boolean;
  firstSeen: string;
  lastSeen: string;
}

/**
 * The devices of the home network that this computer has seen (from the neighbour table of Windows, `arp -a`), with the
 * administrator's names. A device never seen before is reported once (not on the very first scan: that one only makes
 * the list). The computer sees only the network it is in, and only devices that answered; a phone asleep is «not seen».
 */
export function createNetworkWatcher(options: {
  dataDir: string;
  clock: Clock;
  read?: () => Promise<Neighbor[]>;
  sweepOwn?: () => Promise<void>;
  onNewDevice: (device: NetworkDevice) => Promise<void>;
}) {
  const file = path.join(options.dataDir, 'network-devices.json');
  const queue = createSerialQueue();
  const read = options.read ?? readNeighbors;

  async function load(): Promise<Record<string, Stored>> {
    try {
      const data = (await readJsonFile(file)) as { devices?: Record<string, Stored> } | undefined;
      return data?.devices && typeof data.devices === 'object' ? data.devices : {};
    } catch {
      return {};
    }
  }

  const toView = (mac: string, item: Stored, now: number): NetworkDevice => ({
    mac,
    ip: item.ip,
    name: item.name,
    known: item.known,
    firstSeen: item.firstSeen,
    lastSeen: item.lastSeen,
    online: now - new Date(item.lastSeen).getTime() < ONLINE_MS,
  });

  return {
    scan(active = false): Promise<NetworkDevice[]> {
      return queue.run(async () => {
        if (active) {
          const own = ownSubnet();
          if (own) await (options.sweepOwn ?? (() => sweep(own.prefix)))();
        }
        const seen = await read();
        const devices = await load();
        const first = Object.keys(devices).length === 0;
        const now = options.clock();
        const fresh: NetworkDevice[] = [];
        for (const { ip, mac } of seen) {
          const known = devices[mac];
          if (known) {
            known.ip = ip;
            known.lastSeen = now.toISOString();
          } else {
            const item: Stored = {
              ip,
              name: '',
              known: false,
              firstSeen: now.toISOString(),
              lastSeen: now.toISOString(),
            };
            devices[mac] = item;
            if (!first) fresh.push(toView(mac, item, now.getTime()));
          }
        }
        await writeJsonAtomic(file, { version: 1, devices });
        for (const device of fresh) await options.onNewDevice(device);
        return Object.entries(devices)
          .map(([mac, item]) => toView(mac, item, now.getTime()))
          .sort(
            (a, b) =>
              Number(b.online) - Number(a.online) || a.ip.localeCompare(b.ip, 'en', { numeric: true }),
          );
      });
    },
    list(): Promise<NetworkDevice[]> {
      return queue.run(async () => {
        const now = options.clock().getTime();
        return Object.entries(await load())
          .map(([mac, item]) => toView(mac, item, now))
          .sort(
            (a, b) =>
              Number(b.online) - Number(a.online) || a.ip.localeCompare(b.ip, 'en', { numeric: true }),
          );
      });
    },
    name(mac: string, name: string, known: boolean): Promise<boolean> {
      return queue.run(async () => {
        const devices = await load();
        const item = devices[mac];
        if (!item) return false;
        item.name = name.slice(0, 60);
        item.known = known;
        await writeJsonAtomic(file, { version: 1, devices });
        return true;
      });
    },
  };
}

export type NetworkWatcher = ReturnType<typeof createNetworkWatcher>;
