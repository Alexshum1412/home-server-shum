import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Incident } from '../../../shared/extras.ts';
import { createSerialQueue, errorCode } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';

const KEEP = 500;

/**
 * The journal of what went wrong and what was noticed: unexpected shutdowns, programs that fell, failed copies,
 * a full disk, a new device, a touched decoy. One JSON line per entry in `incidents.jsonl`; only the last 500 stay.
 */
export function createIncidentLog(dataDir: string, clock: Clock) {
  const file = path.join(dataDir, 'incidents.jsonl');
  const queue = createSerialQueue();
  let written = 0;

  async function readAll(): Promise<Incident[]> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const out: Incident[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const item = JSON.parse(line) as Incident;
        if (typeof item.id === 'string' && typeof item.at === 'string' && typeof item.title === 'string')
          out.push(item);
      } catch {
        // a torn line (the PC went off while it was written) is skipped
      }
    }
    return out;
  }

  return {
    add(kind: Incident['kind'], title: string, detail = ''): Promise<void> {
      const item: Incident = {
        id: randomUUID(),
        at: clock().toISOString(),
        kind,
        title: title.slice(0, 200),
        detail: detail.slice(0, 500),
      };
      return queue.run(async () => {
        await appendFile(file, `${JSON.stringify(item)}\n`, 'utf8');
        written += 1;
        if (written % 50 === 0) {
          const all = await readAll();
          if (all.length > KEEP * 2) {
            await writeFile(
              file,
              `${all
                .slice(-KEEP)
                .map((entry) => JSON.stringify(entry))
                .join('\n')}\n`,
              'utf8',
            );
          }
        }
      });
    },
    /** Newest first. */
    async list(limit = 100): Promise<Incident[]> {
      return (await queue.run(readAll)).slice(-limit).reverse();
    },
    /** What happened since `sinceIso`, for the morning digest. */
    async since(sinceIso: string): Promise<Incident[]> {
      return (await queue.run(readAll)).filter((item) => item.at >= sinceIso).reverse();
    },
  };
}

export type IncidentLog = ReturnType<typeof createIncidentLog>;
