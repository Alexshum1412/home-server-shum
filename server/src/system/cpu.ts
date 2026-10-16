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
}

export function createCpuSampler(): CpuSampler {
  let previous: CpuTotals | null = null;
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
      previous = now;
      return measured;
    },
    current: () => measured,
  };
}
