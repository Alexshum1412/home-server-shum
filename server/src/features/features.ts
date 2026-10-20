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

/** What is switched off is kept in `features.json` of the data folder; everything is on by default. */
export function createFeatureStore(dataDir: string): FeatureStore {
  const file = path.join(dataDir, 'features.json');
  const queue = createSerialQueue();
  const off = new Set<string>();
  const known = new Set(FEATURES.map((feature) => feature.id));

  const store: FeatureStore = {
    states() {
      return Object.fromEntries(FEATURES.map((feature) => [feature.id, !off.has(feature.id)]));
    },
    isOn: (id) => !off.has(id),
    offFeatureFor(urlPath) {
      for (const feature of FEATURES) {
        if (!off.has(feature.id)) continue;
        if (feature.prefixes.some((prefix) => urlPath === prefix || urlPath.startsWith(`${prefix}/`))) {
          return feature.id;
        }
      }
      return null;
    },
    async set(id, on) {
      if (!known.has(id)) throw new Error('Такой функции нет.');
      await queue.run(async () => {
        if (on) off.delete(id);
        else off.add(id);
        await writeJsonAtomic(file, { version: 1, off: [...off].sort() });
      });
    },
    async load() {
      try {
        const data = (await readJsonFile(file)) as { off?: unknown } | null;
        off.clear();
        for (const id of Array.isArray(data?.off) ? data.off : []) {
          if (typeof id === 'string' && known.has(id)) off.add(id);
        }
      } catch (error) {
        // A missing or damaged file means «everything on»: a broken file must not lock the family out.
        if (errorCode(error) !== 'ENOENT') off.clear();
      }
    },
  };
  return store;
}
