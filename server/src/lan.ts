/**
 * Home-network fallback («запасной адрес дома, если пропал интернет»): the portal can listen on the
 * PC's own address in the home network IN ADDITION to the loopback address, never on all
 * interfaces. Off by default; it is switched on with LAN_BIND in .env (scripts\lan-mode.cmd).
 *
 * Windows Firewall still decides who may connect: the inbound rule is created by the owner
 * (scripts\lan-mode.cmd on), this code never touches the firewall.
 */
import http from 'node:http';
import type { DashboardApp } from './app.ts';

/** Addresses the portal may be bound to besides HOST: private IPv4 of the home network (and loopback for tests). */
export function isPrivateLanAddress(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((part) => part > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a === 127;
}

export interface LanListeners {
  /** Addresses the portal now listens on. */
  bound: string[];
  failed: Array<{ address: string; reason: string }>;
  close(): Promise<void>;
}

function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRNOTAVAIL') return 'такого адреса нет на этом компьютере (сменился IP?)';
  if (code === 'EADDRINUSE') return 'порт на этом адресе уже занят';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts one extra HTTP listener per address with the portal's own request handler. A failure to
 * bind (the IP changed, the adapter is down) never stops the portal: it is reported in `failed`.
 */
export async function listenOnLan(
  app: DashboardApp,
  addresses: readonly string[],
  port: number,
): Promise<LanListeners> {
  const servers: http.Server[] = [];
  const bound: string[] = [];
  const failed: LanListeners['failed'] = [];
  for (const address of addresses) {
    const server = http.createServer(app.routing);
    server.keepAliveTimeout = app.server.keepAliveTimeout;
    server.requestTimeout = app.server.requestTimeout;
    server.headersTimeout = app.server.headersTimeout;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: address, port }, () => {
          server.off('error', reject);
          resolve();
        });
      });
      servers.push(server);
      bound.push(address);
    } catch (error) {
      failed.push({ address, reason: reasonOf(error) });
    }
  }
  return {
    bound,
    failed,
    async close() {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
    },
  };
}
