import { useEffect, useState } from 'preact/hooks';

/** Current time, re-rendered every `intervalMs` so relative labels («2 мин назад») stay fresh. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
