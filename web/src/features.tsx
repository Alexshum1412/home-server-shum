import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useContext, useMemo } from 'preact/hooks';
import { FEATURES, type FeatureStates, type FeaturesResponse } from '../../shared/features.ts';
import { useResource } from './hooks/useResource.ts';

interface FeaturesValue {
  states: FeatureStates;
  reload: () => void;
  /** Is the page at this address switched on (pages that belong to no function are always on). */
  pageOn: (path: string) => boolean;
  /** Same for a function by its name. */
  featureOn: (id: string) => boolean;
}

const Ctx = createContext<FeaturesValue>({
  states: {},
  reload: () => {},
  pageOn: () => true,
  featureOn: () => true,
});

/** What the administrator switched off: the navigation and the pages follow it (the server refuses the API anyway). */
export function FeaturesProvider(props: { children: ComponentChildren }) {
  const resource = useResource<FeaturesResponse>('/api/features');
  const value = useMemo<FeaturesValue>(() => {
    const states = resource.data?.states ?? {};
    return {
      states,
      reload: resource.reload,
      featureOn: (id) => states[id] !== false,
      pageOn: (path) => {
        const feature = FEATURES.find((item) => item.page !== '' && item.page === path);
        return feature === undefined || states[feature.id] !== false;
      },
    };
  }, [resource.data, resource.reload]);
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export const useFeatures = () => useContext(Ctx);
