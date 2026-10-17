/**
 * Independent diagnosis of the family server, for the day the portal does not open:
 *   node server/src/cli/doctor.ts [--json]      (scripts\doctor.cmd)
 * It reads the machine directly (supervisor file, local addresses, disks, Tailscale, backup status,
 * Windows settings) and changes nothing. Exit code: 0 — all fine, 1 — warnings, 2 — errors.
 */
import { execFile } from 'node:child_process';
import { loadConfig } from '../config.ts';
import { isoNow, systemClock } from '../lib/time.ts';
import { readAppVersion } from '../lib/version.ts';
import { createSystemCollector } from '../system/collector.ts';
import {
  type Check,
  type DoctorInputs,
  evaluate,
  exitCodeOf,
  type HostFacts,
  renderReport,
} from '../system/doctor.ts';
import { runPowerShellScript } from '../system/powershell.ts';
import { createDefaultProbes } from '../system/probes.ts';

async function probeHttp(url: string): Promise<DoctorInputs['portal']> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return {
      url,
      ok: response.ok,
      status: response.status,
      detail: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return {
      url,
      ok: false,
      status: null,
      detail: code ?? (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Addresses a TCP port is listening on, from `netstat -ano -p TCP` (a fixed read-only command). */
function listeningAddresses(port: number): Promise<string[]> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    execFile(
      'netstat.exe',
      ['-ano', '-p', 'TCP'],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve([]);
        const found = new Set<string>();
        for (const line of stdout.split(/\r?\n/)) {
          const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING/i.exec(line);
          if (match?.[1] && Number(match[2]) === port) found.add(match[1].replace(/^\[|\]$/g, ''));
        }
        resolve([...found]);
      },
    );
  });
}

async function readHost(): Promise<{ host: HostFacts | null; error: string | null }> {
  try {
    const raw = await runPowerShellScript('doctorHost');
    if (raw === 'unsupported') return { host: null, error: 'доступно только в Windows' };
    return { host: raw as HostFacts, error: null };
  } catch (error) {
    return { host: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<number> {
  const asJson = process.argv.includes('--json');
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      'Диагностика семейного сервера (ничего не меняет): scripts\\doctor.cmd [--json]\n' +
        'Код выхода: 0 — всё в порядке, 1 — есть предупреждения, 2 — есть ошибки.',
    );
    return 0;
  }
  const config = loadConfig(process.env);
  const collector = createSystemCollector({
    config,
    clock: systemClock,
    probes: createDefaultProbes(config),
    version: readAppVersion(),
    startedAt: isoNow(systemClock),
    servicesConfigError: () => null,
  });
  await collector.collectAll();
  collector.stop();
  const [portal, jellyfin, bound, hostResult] = await Promise.all([
    probeHttp(`http://127.0.0.1:${config.port}/api/health`),
    probeHttp('http://127.0.0.1:8096/health'),
    listeningAddresses(config.port),
    readHost(),
  ]);
  const checks: Check[] = evaluate({
    system: collector.snapshot('admin'),
    portal,
    jellyfin,
    host: hostResult.host,
    hostError: hostResult.error,
    lanBind: config.lanBind,
    portalBoundTo: bound,
  });
  if (asJson) console.log(JSON.stringify({ time: isoNow(systemClock), checks }, null, 2));
  else console.log(renderReport(checks, systemClock()));
  return exitCodeOf(checks);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`Диагностика не выполнена: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
