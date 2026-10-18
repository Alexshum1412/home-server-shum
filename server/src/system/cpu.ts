import type { CpuInfo as OsCpuInfo } from 'node:os';
import type { Measured } from '../../../shared/api.ts';

export const CPU_SOURCE = 'Node.js os.cpus()';

interface CpuTotals {
  idle: number;
  total: number;
}

function totals(cpus: readonly OsCpuInfo[]): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
}

export interface CpuSampler {
  /** Takes a sample; utilisation = 1 − Δidle/Δtotal since the previous sample. */
  sample(cpus: readonly OsCpuInfo[], at: Date): Measured<number>;
  current(): Measured<number>;
  /** Load of every core over the same window, 0..100. */
  cores(): Measured<number[]>;
}

export function createCpuSampler(): CpuSampler {
  let previous: CpuTotals | null = null;
  let previousCores: CpuTotals[] | null = null;
  let perCore: Measured<number[]> = {
    value: null,
    collectedAt: null,
    source: CPU_SOURCE,
    reason: 'Идёт первое измерение',
  };
  let measured: Measured<number> = {
    value: null,
    collectedAt: null,
    source: CPU_SOURCE,
    reason: 'Идёт первое измерение',
  };
  return {
    sample(cpus, at) {
      const now = totals(cpus);
      if (cpus.length === 0) {
        measured = { value: null, collectedAt: null, source: CPU_SOURCE, reason: 'Нет данных о процессоре' };
      } else if (previous !== null) {
        const dTotal = now.total - previous.total;
        const dIdle = now.idle - previous.idle;
        if (dTotal > 0) {
          const usage = Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100));
          measured = {
            value: Math.round(usage * 10) / 10,
            collectedAt: at.toISOString(),
            source: CPU_SOURCE,
            reason: null,
          };
        }
      }
      const nowCores = cpus.map((cpu) => totals([cpu]));
      if (previousCores !== null && previousCores.length === nowCores.length && nowCores.length > 0) {
        const loads = nowCores.map((core, index) => {
          const before = previousCores?.[index];
          const dTotal = before ? core.total - before.total : 0;
          const dIdle = before ? core.idle - before.idle : 0;
          return dTotal > 0
            ? Math.round(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)) * 10) / 10
            : 0;
        });
        perCore = { value: loads, collectedAt: at.toISOString(), source: CPU_SOURCE, reason: null };
      }
      previousCores = nowCores;
      previous = now;
      return measured;
    },
    current: () => measured,
    cores: () => perCore,
  };
}
