import type {
  BackupInfo,
  Measured,
  PhysicalDiskInfo,
  PrinterInfo,
  Role,
  SystemResponse,
  TailscaleInfo,
  VolumeInfo,
} from '../../../shared/api.ts';
import type { Config } from '../config.ts';
import { type Clock, formatSeconds, isoNow } from '../lib/time.ts';
import { alertsForRole, buildAlerts } from './alerts.ts';
import { readBackupStatus } from './backup.ts';
import { createCpuSampler } from './cpu.ts';
import { parsePhysicalDisks } from './disks.ts';
import { POWERSHELL_TIMEOUT_MS, ProbeError } from './powershell.ts';
import { parsePrinters } from './printer.ts';
import type { SystemProbes } from './probes.ts';
import { parseTailscaleStatus, TAILSCALE_TIMEOUT_MS } from './tailscale.ts';
import { pendingVolume, toVolumeInfo } from './volumes.ts';

export const SCHEDULE_MS = {
  cpu: 5_000,
  volumes: 60_000,
  tailscale: 60_000,
  devices: 5 * 60_000,
} as const;

const DISKS_SOURCE = 'PowerShell Get-PhysicalDisk';
const NOT_MEASURED = 'Ещё не измерено';

export interface ProbeTimeouts {
  /** Outer guard for PowerShell probes (the process itself is killed after 15 s). */
  powershell: number;
  tailscale: number;
  statfs: number;
}

export interface SystemCollectorOptions {
  config: Config;
  clock: Clock;
  probes: SystemProbes;
  version: string;
  startedAt: string;
  servicesConfigError: () => string | null;
  timeouts?: Partial<ProbeTimeouts>;
  onProbeError?: (probe: string, message: string) => void;
}

export interface SystemCollector {
  collectCpu(): void;
  collectVolumes(): Promise<void>;
  collectBackup(): Promise<void>;
  collectTailscale(): Promise<void>;
  collectDevices(): Promise<void>;
  /** Runs every probe once (used at start and by tests). */
  collectAll(): Promise<void>;
  start(): void;
  stop(): void;
  /** Builds the response from cached results only — never runs probes. */
  snapshot(role: Role): SystemResponse;
}

/** Rejects with a ProbeError when the probe does not settle in time; the rest of the response is unaffected. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ProbeError('timeout', `Проверка не завершилась за ${formatSeconds(ms)} с`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof ProbeError ? error.message : fallback;
}

/** "Windows не ответила" stays capitalised; only the first letter of the sentence is lowered. */
function lowerFirst(text: string): string {
  if (/^[A-Z]/.test(text)) return text; // a proper name such as "Windows" or "PowerShell"
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function createSystemCollector(options: SystemCollectorOptions): SystemCollector {
  const { config, clock, probes } = options;
  const timeouts: ProbeTimeouts = {
    powershell: POWERSHELL_TIMEOUT_MS + 5_000,
    tailscale: TAILSCALE_TIMEOUT_MS + 2_000,
    statfs: 10_000,
    ...options.timeouts,
  };
  const report = (probe: string, error: unknown) =>
    options.onProbeError?.(probe, error instanceof Error ? error.message : String(error));

  const cpuInfo = probes.cpus();
  const cpuModel = cpuInfo[0]?.model.trim() || 'Неизвестный процессор';
  const cores = cpuInfo.length;
  const hostname = probes.hostname();
  const osRelease = probes.osRelease();
  const totalMemoryBytes = probes.totalMemoryBytes();
  const cpu = createCpuSampler();

  let memoryUsed: Measured<number> = {
    value: null,
    collectedAt: null,
    source: 'Node.js os.totalmem()/os.freemem()',
    reason: NOT_MEASURED,
  };
  let uptime: Measured<number> = {
    value: null,
    collectedAt: null,
    source: 'Node.js os.uptime()',
    reason: NOT_MEASURED,
  };
  let volumes: VolumeInfo[] = config.volumes.map((path) => pendingVolume(path, NOT_MEASURED));
  let disks: Measured<PhysicalDiskInfo[]> = {
    value: null,
    collectedAt: null,
    source: DISKS_SOURCE,
    reason: NOT_MEASURED,
  };
  let printer: PrinterInfo = {
    name: config.printerName,
    state: 'unknown',
    message: 'Состояние принтера ещё не получено',
    collectedAt: null,
  };
  let tailscale: TailscaleInfo = {
    state: 'unknown',
    dnsName: null,
    peersOnline: null,
    version: null,
    collectedAt: null,
    reason: 'Ещё не проверено',
  };
  let backup: BackupInfo = {
    state: 'unknown',
    lastSuccessAt: null,
    restoreTested: false,
    message: 'Состояние резервного копирования ещё не проверено',
  };

  const busy = new Set<string>();
  /** Skips a run while the previous one of the same probe is still in flight. */
  async function exclusive(name: string, task: () => Promise<void>): Promise<void> {
    if (busy.has(name)) return;
    busy.add(name);
    try {
      await task();
    } finally {
      busy.delete(name);
    }
  }

  function collectCpu(): void {
    const at = clock();
    try {
      cpu.sample(probes.cpus(), at);
      memoryUsed = {
        value: Math.max(0, totalMemoryBytes - probes.freeMemoryBytes()),
        collectedAt: at.toISOString(),
        source: memoryUsed.source,
        reason: null,
      };
      uptime = {
        value: Math.round(probes.uptimeSeconds()),
        collectedAt: at.toISOString(),
        source: uptime.source,
        reason: null,
      };
    } catch (error) {
      report('cpu', error);
    }
  }

  function collectVolumes(): Promise<void> {
    return exclusive('volumes', async () => {
      volumes = await Promise.all(
        config.volumes.map(async (path) => {
          try {
            const space = await withTimeout(probes.statfs(path), timeouts.statfs);
            return toVolumeInfo(path, space, clock(), config.lowSpacePercent);
          } catch (error) {
            report(`volume ${path}`, error);
            return pendingVolume(path, reasonOf(error, `Не удалось прочитать свободное место на ${path}`));
          }
        }),
      );
    });
  }

  function collectBackup(): Promise<void> {
    return exclusive('backup', async () => {
      backup = await readBackupStatus(config.dataDir, clock);
    });
  }

  function collectTailscale(): Promise<void> {
    return exclusive('tailscale', async () => {
      try {
        const raw = await withTimeout(probes.tailscaleStatus(), timeouts.tailscale);
        tailscale = { ...parseTailscaleStatus(raw), collectedAt: isoNow(clock) };
      } catch (error) {
        report('tailscale', error);
        if (error instanceof ProbeError && error.code === 'not_installed') {
          tailscale = {
            state: 'not_installed',
            dnsName: null,
            peersOnline: null,
            version: null,
            collectedAt: isoNow(clock),
            reason: error.message,
          };
        } else {
          tailscale = {
            state: 'unknown',
            dnsName: null,
            peersOnline: null,
            version: null,
            collectedAt: null,
            reason: reasonOf(error, 'Не удалось получить состояние Tailscale'),
          };
        }
      }
    });
  }

  function collectDevices(): Promise<void> {
    return exclusive('devices', async () => {
      // Sequential on purpose: two PowerShell processes at once are a noticeable load on this PC.
      try {
        const raw = await withTimeout(probes.physicalDisks(), timeouts.powershell);
        disks = {
          value: parsePhysicalDisks(raw),
          collectedAt: isoNow(clock),
          source: DISKS_SOURCE,
          reason: null,
        };
      } catch (error) {
        report('physicalDisks', error);
        disks = {
          value: null,
          collectedAt: null,
          source: DISKS_SOURCE,
          reason: reasonOf(error, 'Не удалось получить данные о дисках от Windows'),
        };
      }
      try {
        const raw = await withTimeout(probes.printers(), timeouts.powershell);
        printer = { ...parsePrinters(raw, config.printerName), collectedAt: isoNow(clock) };
      } catch (error) {
        report('printers', error);
        printer = {
          name: config.printerName,
          state: 'unknown',
          message: `Состояние принтера неизвестно: ${lowerFirst(reasonOf(error, 'не удалось получить данные от Windows'))}`,
          collectedAt: null,
        };
      }
    });
  }

  async function collectAll(): Promise<void> {
    collectCpu();
    await Promise.all([collectVolumes(), collectBackup(), collectTailscale(), collectDevices()]);
  }

  const timers: NodeJS.Timeout[] = [];
  function every(ms: number, task: () => unknown): void {
    const timer = setInterval(() => {
      Promise.resolve()
        .then(task)
        .catch((error: unknown) => report('scheduler', error));
    }, ms);
    timer.unref();
    timers.push(timer);
  }

  return {
    collectCpu,
    collectVolumes,
    collectBackup,
    collectTailscale,
    collectDevices,
    collectAll,
    start() {
      if (timers.length > 0) return;
      collectAll().catch((error: unknown) => report('startup', error));
      every(SCHEDULE_MS.cpu, collectCpu);
      every(SCHEDULE_MS.volumes, () => Promise.all([collectVolumes(), collectBackup()]));
      every(SCHEDULE_MS.tailscale, collectTailscale);
      every(SCHEDULE_MS.devices, collectDevices);
    },
    stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
    snapshot(role) {
      const isAdmin = role === 'admin';
      const alerts = buildAlerts({
        backup,
        volumes,
        disks: disks.value,
        tailscale,
        servicesConfigError: options.servicesConfigError(),
      });
      return {
        generatedAt: isoNow(clock),
        demo: config.demo,
        server: {
          version: options.version,
          startedAt: options.startedAt,
          hostname: isAdmin ? hostname : null,
          osRelease: isAdmin ? osRelease : null,
          uptimeSeconds: { ...uptime },
        },
        cpu: { model: cpuModel, cores, usagePercent: { ...cpu.current() } },
        memory: { totalBytes: totalMemoryBytes, usedBytes: { ...memoryUsed } },
        temperatureC: {
          value: null,
          collectedAt: null,
          source: 'нет поддерживаемого источника',
          reason: 'Датчик температуры недоступен на этом компьютере',
        },
        volumes: volumes.map((volume) => ({ ...volume })),
        physicalDisks: isAdmin
          ? { ...disks, value: disks.value ? disks.value.map((disk) => ({ ...disk })) : null }
          : {
              value: null,
              collectedAt: null,
              source: DISKS_SOURCE,
              reason: 'Подробности доступны администратору',
            },
        tailscale: isAdmin ? { ...tailscale } : { ...tailscale, dnsName: null, peersOnline: null },
        printer: { ...printer },
        backup: { ...backup },
        alerts: alertsForRole(alerts, role),
      };
    },
  };
}
