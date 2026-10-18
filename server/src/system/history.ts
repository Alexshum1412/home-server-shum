/**
 * The last day of readings, one point a minute: «what was the server doing at night». Kept in memory,
 * written to disk now and then (a restart keeps the day). A point never invents a value: what was not
 * measured stays null and the chart shows a gap.
 */
import path from 'node:path';
import type { MetricsPoint } from '../../../shared/api.ts';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';

export const HISTORY_FILE = 'metrics-history.json';
export const HISTORY_KEEP_SEC = 24 * 60 * 60;
/** Never more points than this, whatever the interval (a day of minutes is 1440). */
export const HISTORY_MAX_POINTS = 2000;

export interface MetricsHistory {
  load(): Promise<void>;
  record(point: MetricsPoint): void;
  /** Newest last; at most `maxPoints` (thinned evenly when there are more). */
  points(maxPoints?: number): MetricsPoint[];
  /** Writes to disk when something changed since the last write. */
  flush(): Promise<void>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parsePoints(raw: unknown): MetricsPoint[] {
  const list = Array.isArray((raw as { points?: unknown } | null)?.points)
    ? ((raw as { points: unknown[] }).points ?? [])
    : [];
  const points: MetricsPoint[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const t = numberOrNull(item.t);
    if (t === null) continue;
    points.push({
      t,
      cpu: numberOrNull(item.cpu),
      memory: numberOrNull(item.memory),
      gpu: numberOrNull(item.gpu),
      cpuTemp: numberOrNull(item.cpuTemp),
      gpuTemp: numberOrNull(item.gpuTemp),
      rxBytesPerSec: numberOrNull(item.rxBytesPerSec),
      txBytesPerSec: numberOrNull(item.txBytesPerSec),
    });
  }
  return points.sort((a, b) => a.t - b.t);
}

export function createMetricsHistory(options: {
  dataDir: string;
  now: () => number;
  onError?: (message: string) => void;
}): MetricsHistory {
  const file = path.join(options.dataDir, HISTORY_FILE);
  let all: MetricsPoint[] = [];
  let dirty = false;

  function trim(): void {
    const oldest = options.now() / 1000 - HISTORY_KEEP_SEC;
    let start = 0;
    while (start < all.length && (all[start]?.t ?? 0) < oldest) start++;
    if (start > 0) all = all.slice(start);
    if (all.length > HISTORY_MAX_POINTS) all = all.slice(all.length - HISTORY_MAX_POINTS);
  }

  return {
    async load() {
      try {
        all = parsePoints(await readJsonFile(file));
        trim();
      } catch (error) {
        // A missing file is normal on the first start; a broken one only costs the old readings.
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
          options.onError?.(`История показаний не прочитана: ${(error as Error).message}`);
        }
        all = [];
      }
    },
    record(point) {
      const last = all.at(-1);
      // The same second twice (a retry) replaces, a clock that went back is ignored.
      if (last && point.t < last.t) return;
      if (last && point.t === last.t) all[all.length - 1] = point;
      else all.push(point);
      trim();
      dirty = true;
    },
    points(maxPoints = 288) {
      trim();
      if (all.length <= maxPoints) return all.map((point) => ({ ...point }));
      const step = all.length / maxPoints;
      const thinned: MetricsPoint[] = [];
      for (let i = 0; i < maxPoints; i++) {
        const point = all[Math.min(all.length - 1, Math.floor(i * step))];
        if (point) thinned.push({ ...point });
      }
      const last = all.at(-1);
      if (last && thinned.at(-1)?.t !== last.t) thinned.push({ ...last });
      return thinned;
    },
    async flush() {
      if (!dirty) return;
      dirty = false;
      try {
        await writeJsonAtomic(file, { version: 1, points: all });
      } catch (error) {
        dirty = true;
        options.onError?.(`История показаний не записана: ${(error as Error).message}`);
      }
    },
  };
}
