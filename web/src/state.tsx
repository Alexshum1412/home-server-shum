/**
 * App-wide state: the signed-in session and the two polled data sources
 * (/api/services every 60 s, /api/system every 30 s) shared by all pages.
 */
import { type ComponentChildren, createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ServicesResponse, SessionResponse, SystemResponse } from '../../shared/api.ts';
import { type PollingResult, usePolling } from './hooks/usePolling.ts';

export const SERVICES_INTERVAL_MS = 60_000;
export const SYSTEM_INTERVAL_MS = 30_000;

export interface SessionContextValue {
  session: SessionResponse;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider(props: { value: SessionContextValue; children: ComponentChildren }) {
  return <SessionContext.Provider value={props.value}>{props.children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession() outside of SessionProvider');
  return value;
}

export function useIsAdmin(): boolean {
  return useSession().session.user.role === 'admin';
}

export interface DataContextValue {
  services: PollingResult<ServicesResponse>;
  system: PollingResult<SystemResponse>;
  refreshAll: () => void;
}

/** Exported for tests, which provide fixed data instead of polling the server. */
export const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider(props: { children: ComponentChildren }) {
  const services = usePolling<ServicesResponse>('/api/services', SERVICES_INTERVAL_MS);
  const system = usePolling<SystemResponse>('/api/system', SYSTEM_INTERVAL_MS);
  const value: DataContextValue = {
    services,
    system,
    refreshAll: () => {
      services.refresh();
      system.refresh();
    },
  };
  return <DataContext.Provider value={value}>{props.children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const value = useContext(DataContext);
  if (!value) throw new Error('useData() outside of DataProvider');
  return value;
}
