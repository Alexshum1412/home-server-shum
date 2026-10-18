/**
 * Processor clock, video card, network and drive counters for the administrator's «Состояние» page.
 * Every reading is a measurement or an honest «Недоступно» with the reason: a sensor that is not
 * there is never shown as 0. Nothing here changes anything on the PC; the programs run with fixed
 * arguments (see powershell.ts for the allowlist) or read a program's local page.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  DiskReliabilityInfo,
  GpuInfo,
  HardwareInfo,
  Measured,
  NetworkAdapterInfo,
} from '../../../shared/api.ts';
import type { Config } from '../config.ts';
import { type Clock, formatSeconds, isoNow } from '../lib/time.ts';
import { ProbeError } from './powershell.ts';
import type { SystemProbes } from './probes.ts';

const NOT_MEASURED = 'Ещё не измерено';
const SENSOR_HINT =
  'Температуру процессора Windows не сообщает. Её покажет бесплатная программа LibreHardwareMonitor с включённым локальным веб-сервером (HWMONITOR_URL в .env).';

export const SOURCES = {
  cores: 'Node.js os.cpus()',
  clock: 'PowerShell Win32_Processor',
  board: 'Windows ACPI (зона платы, не процессор)',
  gpu: 'nvidia-smi',
  network: 'PowerShell Get-NetAdapterStatistics',
  disks: 'PowerShell Get-StorageReliabilityCounter',
  sensor: 'LibreHardwareMonitor',
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
}

/** A finite number from a number or a numeric string; anything else (also «[N/A]») is null. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function unmeasured<T>(source: string, reason = NOT_MEASURED): Measured<T> {
  return { value: null, collectedAt: null, source, reason };
}

// --- video card ------------------------------------------------------------------------------

export const NVIDIA_SMI_QUERY = [
  'name',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
  'fan.speed',
  'driver_version',
] as const;

/** `nvidia-smi --query-gpu=… --format=csv,noheader,nounits` (memory in MiB). */
export function parseNvidiaSmi(output: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < NVIDIA_SMI_QUERY.length) continue;
    const mib = (value: string | undefined) => {
      const n = num(value);
      return n === null ? null : Math.round(n * 1024 * 1024);
    };
    gpus.push({
      name: cells[0] || 'Видеокарта NVIDIA',
      loadPercent: num(cells[1]),
      memoryUsedBytes: mib(cells[2]),
      memoryTotalBytes: mib(cells[3]),
      temperatureC: num(cells[4]),
      powerWatts: num(cells[5]),
      fanPercent: num(cells[6]),
      driver: cells[7] || null,
    });
  }
  return gpus;
}

const NVIDIA_SMI_PATHS = (env: NodeJS.ProcessEnv): string[] => {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  return [
    path.win32.join(systemRoot, 'System32', 'nvidia-smi.exe'),
    path.win32.join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ];
};

/** Runs nvidia-smi with fixed arguments; ProbeError when the driver tool is not there. */
export function runNvidiaSmi(
  timeoutMs = 8000,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform !== 'win32') return Promise.reject(new ProbeError('unsupported', 'Доступно только в Windows'));
  const exe = NVIDIA_SMI_PATHS(process.env).find((candidate) => existsSync(candidate));
  if (!exe) {
    return Promise.reject(new ProbeError('not_installed', 'Драйвер NVIDIA (nvidia-smi) не найден'));
  }
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      [`--query-gpu=${NVIDIA_SMI_QUERY.join(',')}`, '--format=csv,noheader,nounits'],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(
            error.killed
              ? new ProbeError('timeout', `Драйвер NVIDIA не ответил за ${formatSeconds(timeoutMs)} с`)
              : new ProbeError('failed', 'Не удалось получить данные от драйвера NVIDIA'),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// --- processor clock, network, board temperature (one PowerShell reading) ------------------------

export interface LiveReading {
  clock: { currentMhz: number; maxMhz: number } | null;
  adapters: Array<{
    name: string;
    description: string;
    physical: boolean;
    linkSpeedMbps: number | null;
    rx: number | null;
    tx: number | null;
  }>;
  /** Hottest ACPI zone in °C, null when there is none or the values are not believable. */
  boardTemperatureC: number | null;
}

export function parseLiveReading(raw: unknown): LiveReading {
  const record = asRecord(raw) ?? {};
  const current = num(record.currentMhz);
  const max = num(record.maxMhz);
  const adapters: LiveReading['adapters'] = [];
  for (const entry of asList(record.adapters)) {
    const item = asRecord(entry);
    if (!item) continue;
    const speed = num(item.speedBps);
    adapters.push({
      name: text(item.name) || 'Сеть',
      description: text(item.description),
      physical: item.hardware === true,
      linkSpeedMbps: speed !== null && speed > 0 ? Math.round(speed / 1e6) : null,
      rx: num(item.rx),
      tx: num(item.tx),
    });
  }
  // ACPI reports tenths of a kelvin; a zone outside 0–110 °C is a broken table, not a temperature.
  const zones = asList(record.thermal)
    .map((entry) => num(asRecord(entry)?.deciKelvin))
    .filter((value): value is number => value !== null)
    .map((deciKelvin) => Math.round((deciKelvin / 10 - 273.15) * 10) / 10)
    .filter((celsius) => celsius > 0 && celsius < 110);
  return {
    clock: current !== null && max !== null && current > 0 ? { currentMhz: current, maxMhz: max } : null,
    adapters,
    boardTemperatureC: zones.length > 0 ? Math.max(...zones) : null,
  };
}

// --- drives ----------------------------------------------------------------------------------

export const DISK_TEMPERATURE_WARN_C = 55;
export const DISK_WEAR_WARN_PERCENT = 90;

export function parseDiskReliability(raw: unknown): DiskReliabilityInfo[] {
  const disks: DiskReliabilityInfo[] = [];
  for (const entry of asList(raw)) {
    const item = asRecord(entry);
    if (!item) continue;
    // Windows answers 0 for «no sensor» (flash drives, a drive with a broken firmware).
    const temperature = num(item.temperature);
    const wear = num(item.wear);
    const readErrors = num(item.readErrors);
    const writeErrors = num(item.writeErrors);
    const hours = num(item.hours);
    const notes: string[] = [];
    if (temperature !== null && temperature >= DISK_TEMPERATURE_WARN_C) {
      notes.push(`температура ${temperature} °C: проверьте охлаждение`);
    }
    if (wear !== null && wear >= DISK_WEAR_WARN_PERCENT) notes.push(`износ ${wear} %: пора готовить замену`);
    if ((readErrors ?? 0) > 0) notes.push(`ошибок чтения: ${readErrors}`);
    if ((writeErrors ?? 0) > 0) notes.push(`ошибок записи: ${writeErrors}`);
    disks.push({
      model: text(item.model) || 'Неизвестный диск',
      temperatureC: temperature !== null && temperature > 0 ? temperature : null,
      wearPercent: wear !== null && wear > 0 ? wear : null,
      readErrors,
      writeErrors,
      powerOnHours: hours !== null && hours > 0 ? hours : null,
      note: notes.length > 0 ? `Диск сообщает: ${notes.join('; ')}.` : null,
    });
  }
  return disks;
}

// --- sensor program (LibreHardwareMonitor's local page) ------------------------------------------

interface SensorNode {
  Text?: unknown;
  Value?: unknown;
  Children?: unknown;
}

/**
 * The tree of `http://127.0.0.1:8085/data.json`. Only temperatures are taken, and only from a
 * sensor whose name says what it measures: the processor package (or the hottest core) and the
 * video card core.
 */
export function parseSensorTree(raw: unknown): { cpuC: number | null; gpuC: number | null } {
  const cpu: number[] = [];
  const cpuPackage: number[] = [];
  const gpu: number[] = [];
  const walk = (node: unknown, inTemperatures: boolean): void => {
    const item = asRecord(node) as SensorNode | null;
    if (!item) return;
    const label = text(item.Text);
    const here = inTemperatures || /^(temperatures|температуры)$/i.test(label);
    const match = /^(-?\d+(?:[.,]\d+)?)\s*°C$/.exec(text(item.Value));
    if (here && match) {
      const value = Number(match[1]?.replace(',', '.'));
      if (Number.isFinite(value) && value > 0 && value < 125) {
        if (/^cpu package$/i.test(label)) cpuPackage.push(value);
        else if (/^(core #\d+|cpu core|core max|core average)/i.test(label)) cpu.push(value);
        else if (/^gpu core$/i.test(label)) gpu.push(value);
      }
    }
    for (const child of asList(item.Children)) walk(child, here);
  };
  walk(raw, false);
  const pick = (values: number[]) => (values.length > 0 ? Math.max(...values) : null);
  return { cpuC: pick(cpuPackage) ?? pick(cpu), gpuC: pick(gpu) };
}

// --- the monitor -----------------------------------------------------------------------------

export interface HardwareProbes {
  hardwareLive?: SystemProbes['hardwareLive'];
  diskReliability?: SystemProbes['diskReliability'];
  gpu?: SystemProbes['gpu'];
  sensors?: SystemProbes['sensors'];
}

export interface HardwareMonitorOptions {
  config: Pick<Config, 'hwMonitorUrl'>;
  clock: Clock;
  probes: HardwareProbes;
  /** Outer guard for a probe (the probe itself has its own timeout). */
  timeoutMs: number;
  onProbeError?: (probe: string, error: unknown) => void;
}

export interface HardwareMonitor {
  /** Clock, network, board temperature, video card, sensor program. */
  collectLive(): Promise<void>;
  /** Drive counters (change slowly). */
  collectDisks(): Promise<void>;
  snapshot(cores: Measured<number[]>): HardwareInfo;
  /** What the latest reading says, for the history. */
  latest(): {
    gpuLoad: number | null;
    gpuTemp: number | null;
    cpuTemp: number | null;
    rx: number | null;
    tx: number | null;
  };
}

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof ProbeError ? error.message : fallback;
}

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

export function createHardwareMonitor(options: HardwareMonitorOptions): HardwareMonitor {
  const { clock, probes } = options;
  let clockInfo: Measured<{ currentMhz: number; maxMhz: number }> = unmeasured(SOURCES.clock);
  let board: Measured<number> = unmeasured(SOURCES.board);
  let network: Measured<NetworkAdapterInfo[]> = unmeasured(SOURCES.network);
  let gpu: Measured<GpuInfo[]> = unmeasured(SOURCES.gpu);
  let disks: Measured<DiskReliabilityInfo[]> = unmeasured(SOURCES.disks);
  let sensorCpu: Measured<number> = unmeasured(
    SOURCES.sensor,
    options.config.hwMonitorUrl ? NOT_MEASURED : SENSOR_HINT,
  );
  let sensorGpu: number | null = null;
  let previous: { at: number; totals: Map<string, { rx: number; tx: number }> } | null = null;

  const fail = (probe: string, error: unknown) => options.onProbeError?.(probe, error);

  async function readLive(): Promise<void> {
    if (!probes.hardwareLive) {
      const reason = 'Источник данных не подключён';
      clockInfo = unmeasured(SOURCES.clock, reason);
      network = unmeasured(SOURCES.network, reason);
      board = unmeasured(SOURCES.board, reason);
      return;
    }
    const at = clock();
    try {
      const reading = parseLiveReading(await withTimeout(probes.hardwareLive(), options.timeoutMs));
      const collectedAt = isoNow(clock);
      clockInfo = reading.clock
        ? { value: reading.clock, collectedAt, source: SOURCES.clock, reason: null }
        : unmeasured(SOURCES.clock, 'Windows не сообщила частоту процессора');
      board =
        reading.boardTemperatureC === null
          ? unmeasured(SOURCES.board, 'Датчик зоны платы недоступен на этом компьютере')
          : { value: reading.boardTemperatureC, collectedAt, source: SOURCES.board, reason: null };
      const totals = new Map<string, { rx: number; tx: number }>();
      const seconds = previous ? (at.getTime() - previous.at) / 1000 : 0;
      const list: NetworkAdapterInfo[] = reading.adapters.map((adapter) => {
        if (adapter.rx !== null && adapter.tx !== null)
          totals.set(adapter.name, { rx: adapter.rx, tx: adapter.tx });
        const before = previous?.totals.get(adapter.name);
        // A counter that went down was reset (the adapter restarted): no speed for that reading.
        const rate = (now: number | null, then: number | undefined) =>
          now !== null && then !== undefined && seconds > 0 && now >= then
            ? Math.round((now - then) / seconds)
            : null;
        return {
          name: adapter.name,
          description: adapter.description,
          physical: adapter.physical,
          linkSpeedMbps: adapter.linkSpeedMbps,
          rxBytesPerSec: rate(adapter.rx, before?.rx),
          txBytesPerSec: rate(adapter.tx, before?.tx),
          rxTotalBytes: adapter.rx,
          txTotalBytes: adapter.tx,
        };
      });
      previous = { at: at.getTime(), totals };
      network =
        list.length > 0
          ? { value: list, collectedAt, source: SOURCES.network, reason: null }
          : unmeasured(SOURCES.network, 'Нет подключённых сетевых адаптеров');
    } catch (error) {
      fail('hardwareLive', error);
      const reason = reasonOf(error, 'Не удалось получить данные от Windows');
      clockInfo = unmeasured(SOURCES.clock, reason);
      network = unmeasured(SOURCES.network, reason);
      board = unmeasured(SOURCES.board, reason);
      previous = null;
    }
  }

  async function readGpu(): Promise<void> {
    if (!probes.gpu) {
      gpu = unmeasured(SOURCES.gpu, 'Источник данных не подключён');
      return;
    }
    try {
      const list = parseNvidiaSmi(await withTimeout(probes.gpu(), options.timeoutMs));
      gpu =
        list.length > 0
          ? { value: list, collectedAt: isoNow(clock), source: SOURCES.gpu, reason: null }
          : unmeasured(SOURCES.gpu, 'Драйвер не нашёл видеокарту NVIDIA');
    } catch (error) {
      fail('gpu', error);
      gpu = unmeasured(SOURCES.gpu, reasonOf(error, 'Не удалось получить данные видеокарты'));
    }
  }

  async function readSensors(): Promise<void> {
    if (!probes.sensors || !options.config.hwMonitorUrl) {
      sensorCpu = unmeasured(SOURCES.sensor, SENSOR_HINT);
      sensorGpu = null;
      return;
    }
    try {
      const parsed = parseSensorTree(await withTimeout(probes.sensors(), options.timeoutMs));
      sensorGpu = parsed.gpuC;
      sensorCpu =
        parsed.cpuC === null
          ? unmeasured(SOURCES.sensor, 'LibreHardwareMonitor работает, но датчика процессора в нём нет')
          : { value: parsed.cpuC, collectedAt: isoNow(clock), source: SOURCES.sensor, reason: null };
    } catch (error) {
      fail('sensors', error);
      sensorGpu = null;
      sensorCpu = unmeasured(
        SOURCES.sensor,
        `LibreHardwareMonitor не отвечает${error instanceof ProbeError ? `: ${error.message}` : ''}. Запустите программу и включите «Remote Web Server».`,
      );
    }
  }

  return {
    async collectLive() {
      // One after another: a PowerShell process and a few HTTP calls are a load on this PC, not a burst.
      await readLive();
      await readGpu();
      await readSensors();
    },
    async collectDisks() {
      if (!probes.diskReliability) {
        disks = unmeasured(SOURCES.disks, 'Источник данных не подключён');
        return;
      }
      try {
        const list = parseDiskReliability(await withTimeout(probes.diskReliability(), options.timeoutMs));
        disks =
          list.length > 0
            ? { value: list, collectedAt: isoNow(clock), source: SOURCES.disks, reason: null }
            : unmeasured(SOURCES.disks, 'Windows не сообщила данных о дисках');
      } catch (error) {
        fail('diskReliability', error);
        disks = unmeasured(SOURCES.disks, reasonOf(error, 'Не удалось получить счётчики дисков'));
      }
    },
    snapshot(cores) {
      return {
        cpuCores: { ...cores },
        cpuClock: { ...clockInfo },
        cpuTemperatureC: { ...sensorCpu },
        boardTemperatureC: { ...board },
        gpu: { ...gpu, value: gpu.value ? gpu.value.map((item) => ({ ...item })) : null },
        network: { ...network, value: network.value ? network.value.map((item) => ({ ...item })) : null },
        diskReliability: { ...disks, value: disks.value ? disks.value.map((item) => ({ ...item })) : null },
      };
    },
    latest() {
      const card = gpu.value?.[0];
      const physical = network.value?.filter((adapter) => adapter.physical) ?? [];
      const sum = (pick: (adapter: NetworkAdapterInfo) => number | null) => {
        const values = physical.map(pick).filter((value): value is number => value !== null);
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
      };
      return {
        gpuLoad: card?.loadPercent ?? null,
        gpuTemp: card?.temperatureC ?? sensorGpu,
        cpuTemp: sensorCpu.value,
        rx: sum((adapter) => adapter.rxBytesPerSec),
        tx: sum((adapter) => adapter.txBytesPerSec),
      };
    },
  };
}
