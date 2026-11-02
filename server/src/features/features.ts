import path from 'node:path';
import { FEATURES, type FeatureStates } from '../../../shared/features.ts';
import { createSerialQueue, errorCode, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';

export interface FeatureStore {
  states(): FeatureStates;
  isOn(id: string): boolean;
  /** The function that owns this API path and is switched off, if any. */
  offFeatureFor(urlPath: string): string | null;
  set(id: string, on: boolean): Promise<void>;
  load(): Promise<void>;
}

/**
 * What the administrator switched is kept in `features.json` of the data folder: `off` — the functions that are on by
 * default and were switched off, `on` — the new functions (marked `defaultOff`) that were switched on. Everything else
 * follows the default: old functions are on, new ones wait for the administrator.
 */
export function createFeatureStore(dataDir: string): FeatureStore {
  const file = path.join(dataDir, 'features.json');
  const queue = createSerialQueue();
  const off = new Set<string>();
  const on = new Set<string>();
  const known = new Set(FEATURES.map((feature) => feature.id));
  const defaultOff = new Set(
    FEATURES.filter((feature) => feature.defaultOff === true).map((feature) => feature.id),
  );
  const enabled = (id: string) => (defaultOff.has(id) ? on.has(id) : !off.has(id));

  const store: FeatureStore = {
    states() {
      return Object.fromEntries(FEATURES.map((feature) => [feature.id, enabled(feature.id)]));
    },
    isOn: (id) => enabled(id),
    offFeatureFor(urlPath) {
      for (const feature of FEATURES) {
        if (enabled(feature.id)) continue;
        if (feature.prefixes.some((prefix) => urlPath === prefix || urlPath.startsWith(`${prefix}/`))) {
          return feature.id;
        }
      }
      return null;
    },
    async set(id, value) {
      if (!known.has(id)) throw new Error('Такой функции нет.');
      await queue.run(async () => {
        if (defaultOff.has(id)) {
          if (value) on.add(id);
          else on.delete(id);
        } else if (value) off.delete(id);
        else off.add(id);
        await writeJsonAtomic(file, { version: 1, off: [...off].sort(), on: [...on].sort() });
      });
    },
    async load() {
      try {
        const data = (await readJsonFile(file)) as { off?: unknown; on?: unknown } | null;
        off.clear();
        on.clear();
        for (const id of Array.isArray(data?.off) ? data.off : []) {
          if (typeof id === 'string' && known.has(id) && !defaultOff.has(id)) off.add(id);
        }
        for (const id of Array.isArray(data?.on) ? data.on : []) {
          if (typeof id === 'string' && defaultOff.has(id)) on.add(id);
        }
      } catch (error) {
        // A missing or damaged file means «defaults»: a broken file must not lock the family out.
        if (errorCode(error) !== 'ENOENT') {
          off.clear();
          on.clear();
        }
      }
    },
  };
  return store;
}
