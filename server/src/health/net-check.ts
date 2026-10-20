import dns from 'node:dns/promises';
import net from 'node:net';

export interface InternetState {
  up: boolean | null;
  dnsUp: boolean | null;
  checkedAt: string | null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Can this computer open a connection to the internet by number (1.1.1.1:443) and does it resolve a name? */
export async function checkInternet(now: () => Date = () => new Date()): Promise<InternetState> {
  const tcp = new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  const names = withTimeout(dns.lookup('cloudflare.com'), 3000).then(
    () => true,
    () => false,
  );
  const [up, dnsUp] = await Promise.all([tcp, names]);
  return { up, dnsUp, checkedAt: now().toISOString() };
}
