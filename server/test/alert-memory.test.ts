import { describe, expect, it } from 'vitest';
import { createAlertWatcher } from '../src/system/alert-watcher.ts';

const admin = { id: 'a1', username: 'admin', role: 'admin' } as never;
const problem = [
  { id: 'volume-low-f', level: 'warning', title: 'Заканчивается место', text: 'мало', audience: 'admin' },
] as never;

describe('the alert watcher remembers what it announced', () => {
  it('does not announce the same problem again after a restart of the portal', async () => {
    let stored: Record<string, number> = {};
    const memory = {
      load: async () => stored,
      save: async (value: Record<string, number>) => {
        stored = value;
      },
    };
    const sent: string[] = [];
    const make = (now: () => number) =>
      createAlertWatcher({
        alerts: () => problem,
        admins: async () => [admin],
        notify: async (input) => {
          sent.push(input.title);
        },
        now,
        memory,
      });
    let clock = 1_000_000;
    const first = make(() => clock);
    await first.tick();
    await first.tick();
    expect(sent).toHaveLength(1);
    // the portal restarts three times within the hour
    for (let i = 0; i < 3; i += 1) {
      clock += 10 * 60_000;
      const again = make(() => clock);
      await again.tick();
      await again.tick();
    }
    expect(sent).toHaveLength(1);
    // a day later the reminder comes
    clock += 24 * 60 * 60_000;
    const later = make(() => clock);
    await later.tick();
    await later.tick();
    expect(sent).toHaveLength(2);
  });
});
