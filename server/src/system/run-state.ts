/**
 * Did the previous run of the portal end cleanly? The portal writes «running» with a time when it
 * starts, refreshes the time every minute, and writes «stopped» when it is closed on purpose (the
 * supervisor asks it to, a restart, scripts\stop.cmd). A file that still says «running» at the next start
 * means the portal was killed, crashed, or the PC lost power: the administrators are told once.
 * A normal restart never raises it.
 */
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';

export interface RunRecord {
  state: 'running' | 'stopped';
  startedAt: string;
  /** Last time the portal was seen alive (every minute), or the time it stopped. */
  at: string;
  pid: number;
}

export interface PreviousRun {
  /** 'clean' — it stopped on purpose; 'crashed' — it did not; 'unknown' — there is no record (the very first start). */
  how: 'clean' | 'crashed' | 'unknown';
  /** When it was last seen alive (crashed) or stopped (clean). */
  at: string | null;
}

export interface RunState {
  /** Reads what the previous run left and marks this run as started. */
  begin(): Promise<{ previous: PreviousRun; startedAt: string }>;
  /** Called every minute while the portal runs. */
  heartbeat(): Promise<void>;
  /** The portal is being closed on purpose. */
  end(): Promise<void>;
}

function parse(value: unknown): RunRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<RunRecord>;
  if (
    (record.state === 'running' || record.state === 'stopped') &&
    typeof record.startedAt === 'string' &&
    typeof record.at === 'string'
  ) {
    return { state: record.state, startedAt: record.startedAt, at: record.at, pid: Number(record.pid) || 0 };
  }
  return null;
}

export function createRunState(options: { dataDir: string; clock: Clock; pid?: number }): RunState {
  const file = path.join(options.dataDir, 'run-state.json');
  const pid = options.pid ?? process.pid;
  let current: RunRecord | null = null;

  async function write(record: RunRecord): Promise<void> {
    current = record;
    await writeJsonAtomic(file, record);
  }

  return {
    async begin() {
      let previous: PreviousRun = { how: 'unknown', at: null };
      try {
        const last = parse(await readJsonFile(file));
        if (last) previous = { how: last.state === 'running' ? 'crashed' : 'clean', at: last.at };
      } catch {
        // an unreadable file is the same as none: nothing to report
      }
      const startedAt = isoNow(options.clock);
      await write({ state: 'running', startedAt, at: startedAt, pid });
      return { previous, startedAt };
    },
    async heartbeat() {
      if (current?.state !== 'running') return;
      await write({ ...current, at: isoNow(options.clock) });
    },
    async end() {
      if (!current) return;
      await write({ ...current, state: 'stopped', at: isoNow(options.clock) });
    },
  };
}

/** «18:40» in the server's own time zone. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
