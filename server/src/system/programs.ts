/**
 * State of the programs the supervisor runs (run/supervisor.json, written by
 * server/src/supervisor/main.ts). The file is trusted only while its writer is alive: a file left
 * by a stopped supervisor says nothing about the present.
 */
import path from 'node:path';
import type { Measured, ProgramState, ProgramStatus } from '../../../shared/api.ts';
import { readJsonFile } from '../lib/json-store.ts';

export const PROGRAMS_SOURCE = 'супервизор (run/supervisor.json)';
const STATES: ReadonlySet<string> = new Set([
  'running',
  'starting',
  'backoff',
  'stopping',
  'stopped',
  'external',
]);

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else (still alive).
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readPrograms(
  dataDir: string,
  now: Date,
  alive: (pid: number) => boolean = processAlive,
): Promise<Measured<ProgramStatus[]>> {
  const base = { collectedAt: now.toISOString(), source: PROGRAMS_SOURCE };
  let data: unknown;
  try {
    data = await readJsonFile(path.join(dataDir, 'run', 'supervisor.json'));
  } catch {
    return { ...base, value: null, reason: 'Файл состояния супервизора повреждён' };
  }
  const state = data as { pid?: unknown; apps?: unknown } | undefined;
  if (!state || typeof state.pid !== 'number' || !Array.isArray(state.apps)) {
    return { ...base, value: null, reason: 'Супервизор не запущен: автоматический перезапуск не работает' };
  }
  if (!alive(state.pid)) {
    return { ...base, value: null, reason: 'Супервизор не запущен: автоматический перезапуск не работает' };
  }
  const programs: ProgramStatus[] = [];
  for (const raw of state.apps as Array<Record<string, unknown>>) {
    if (typeof raw.name !== 'string' || typeof raw.title !== 'string') continue;
    const st =
      typeof raw.state === 'string' && STATES.has(raw.state) ? (raw.state as ProgramState) : 'unknown';
    programs.push({
      name: raw.name.slice(0, 40),
      title: raw.title.slice(0, 80),
      state: st,
      restarts: typeof raw.restarts === 'number' ? raw.restarts : 0,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    });
  }
  return { ...base, value: programs, reason: null };
}
