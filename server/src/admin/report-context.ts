/** What must never leave in a report that is copied out: the family's names and the names of this computer and its addresses. */
import os from 'node:os';
import type { StoredUser } from '../auth/users.ts';
import type { Config } from '../config.ts';
import type { SanitizeContext } from './sanitize.ts';

export function reportContext(
  config: Pick<Config, 'publicUrl' | 'publicHttpsUrl' | 'lanUrl'>,
  users: readonly StoredUser[],
): SanitizeContext {
  const hosts = new Set<string>([os.hostname()]);
  for (const url of [config.publicUrl, config.publicHttpsUrl, config.lanUrl]) {
    try {
      if (url) hosts.add(new URL(url).hostname);
    } catch {
      // not an address: nothing to hide
    }
  }
  return {
    names: users.flatMap((user) => [user.username, user.displayName]),
    hosts: [...hosts],
  };
}
