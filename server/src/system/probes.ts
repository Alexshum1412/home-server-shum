import os from 'node:os';
import type { Config } from '../config.ts';
import { runNvidiaSmi } from './hardware.ts';
import { ProbeError, runPowerShellScript } from './powershell.ts';
import { runTailscaleStatus } from './tailscale.ts';
import { statVolume, type VolumeSpace } from './volumes.ts';

/**
 * Everything the system collector reads from the machine. Production uses
 * `createDefaultProbes`; tests inject fakes (fixtures, hung promises, errors).
 * Async probes return raw data and throw ProbeError (or any Error) on failure.
 */
export interface SystemProbes {
  cpus(): os.CpuInfo[];
  totalMemoryBytes(): number;
  freeMemoryBytes(): number;
  uptimeSeconds(): number;
  hostname(): string;
  osRelease(): string;
  statfs(volumePath: string): Promise<VolumeSpace>;
  /** Raw output of the allowlisted `physicalDisks` script. */
  physicalDisks(): Promise<unknown>;
  /** Raw output of the allowlisted `printers` script. */
  printers(): Promise<unknown>;
  /** Raw `tailscale status --json`. */
  tailscaleStatus(): Promise<unknown>;
  /** Raw output of the allowlisted `osVersion` script (edition, 22H2, build.UBR); optional. */
  osVersion?(): Promise<unknown>;
  /** Processor clock, network counters and ACPI temperature zones (one PowerShell reading). */
  hardwareLive?(): Promise<unknown>;
  /** What each drive reports about itself. */
  diskReliability?(): Promise<unknown>;
  /** Raw output of `nvidia-smi --query-gpu=… --format=csv,noheader,nounits`. */
  gpu?(): Promise<string>;
  /** The tree of the sensor program's local page (LibreHardwareMonitor); only when HWMONITOR_URL is set. */
  sensors?(): Promise<unknown>;
}

async function windowsOnly(
  name: 'physicalDisks' | 'printers' | 'osVersion' | 'hardwareLive' | 'diskReliability',
): Promise<unknown> {
  const result = await runPowerShellScript(name);
  if (result === 'unsupported') throw new ProbeError('unsupported', 'Доступно только в Windows');
  return result;
}

export function createDefaultProbes(config: Config): SystemProbes {
  return {
    cpus: () => os.cpus(),
    totalMemoryBytes: () => os.totalmem(),
    freeMemoryBytes: () => os.freemem(),
    uptimeSeconds: () => os.uptime(),
    hostname: () => os.hostname(),
    osRelease: () => `${os.version()} (${os.release()})`,
    statfs: statVolume,
    physicalDisks: () => windowsOnly('physicalDisks'),
    printers: () => windowsOnly('printers'),
    tailscaleStatus: () => runTailscaleStatus(config.tailscaleExe),
    osVersion: () => windowsOnly('osVersion'),
    hardwareLive: () => windowsOnly('hardwareLive'),
    diskReliability: () => windowsOnly('diskReliability'),
    gpu: () => runNvidiaSmi(),
    sensors: async () => {
      if (!config.hwMonitorUrl) throw new ProbeError('not_installed', 'LibreHardwareMonitor не подключён');
      const response = await fetch(`${config.hwMonitorUrl}/data.json`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new ProbeError('failed', `LibreHardwareMonitor ответил ${response.status}`);
      return response.json();
    },
  };
}
