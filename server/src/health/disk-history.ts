import path from 'node:path';
import type { DiskForecast } from '../../../shared/extras.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEEP_MS = 60 * DAY;
const WINDOW_MS = 14 * DAY;

type Series = Record<string, Array<[number, number]>>;

/**
 * Free space of every volume, once an hour for two months, and the forecast from it: at the speed of the last two
 * weeks, in how many days the free space reaches the reserve. Not a promise — a straight line through the points.
 */
export function createDiskHistory(
  dataDir: string,
  options: {
    clock: Clock;
    probe: () => Promise<Array<{ path: string; freeBytes: number | null }>>;
    reserveBytes: number;
  },
) {
  const file = path.join(dataDir, 'disk-history.json');
  const queue = createSerialQueue();

  async function load(): Promise<Series> {
    try {
      const data = (await readJsonFile(file)) as { series?: Series } | undefined;
      return data?.series && typeof data.series === 'object' ? data.series : {};
    } catch {
      return {};
    }
  }

  /** Least squares through (time, free) of the points of the window. */
  function forecastOf(volume: string, points: Array<[number, number]>, now: number): DiskForecast {
    const recent = points.filter(([at]) => at >= now - WINDOW_MS);
    const last = points[points.length - 1];
    const freeBytes = last ? last[1] : 0;
    const base = {
      volume,
      freeBytes,
      points: recent.length,
      daysLeft: null,
      perDayBytes: null,
    } as DiskForecast;
    const first = recent[0];
    if (recent.length < 12 || !first || recent[recent.length - 1]![0] - first[0] < DAY) return base;
    const n = recent.length;
    const mx = recent.reduce((s, [t]) => s + (t - first[0]), 0) / n;
    const my = recent.reduce((s, [, v]) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (const [t, v] of recent) {
      num += (t - first[0] - mx) * (v - my);
      den += (t - first[0] - mx) ** 2;
    }
    if (den === 0) return base;
    const perMs = num / den;
    if (perMs >= 0) return base;
    const perDay = -perMs * DAY;
    // Less than 100 MB a day is noise.
    if (perDay < 100 * 1024 * 1024) return { ...base, perDayBytes: Math.round(perDay) };
    return {
      ...base,
      perDayBytes: Math.round(perDay),
      daysLeft: Math.max(0, Math.round((freeBytes - options.reserveBytes) / perDay)),
    };
  }

  return {
    /** Adds a point for every volume (call once an hour; it ignores calls that come too soon). */
    record(): Promise<void> {
      return queue.run(async () => {
        const series = await load();
        const now = options.clock().getTime();
        const readings = await options.probe();
        let changed = false;
        for (const { path: volume, freeBytes } of readings) {
          if (freeBytes === null) continue;
          const list = series[volume] ?? [];
          const last = list[list.length - 1];
          if (last && now - last[0] < HOUR - 60_000) continue;
          list.push([now, freeBytes]);
          series[volume] = list.filter(([at]) => at >= now - KEEP_MS);
          changed = true;
        }
        if (changed) await writeJsonAtomic(file, { version: 1, series });
      });
    },
    forecast(): Promise<DiskForecast[]> {
      return queue.run(async () => {
        const series = await load();
        const now = options.clock().getTime();
        return Object.entries(series).map(([volume, points]) => forecastOf(volume, points, now));
      });
    },
  };
}

export type DiskHistory = ReturnType<typeof createDiskHistory>;
