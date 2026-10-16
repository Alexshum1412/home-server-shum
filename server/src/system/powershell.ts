import { execFile } from 'node:child_process';
import path from 'node:path';
import { stripBom } from '../lib/json-store.ts';
import { formatSeconds } from '../lib/time.ts';

/** Error from a system probe; `reason` is Russian and safe to show. */
export class ProbeError extends Error {
  readonly code: 'unsupported' | 'not_installed' | 'not_running' | 'timeout' | 'failed' | 'bad_output';
  constructor(code: ProbeError['code'], reason: string) {
    super(reason);
    this.name = 'ProbeError';
    this.code = code;
  }
}

const HEADER = '[Console]::OutputEncoding=[Text.Encoding]::UTF8\n$ErrorActionPreference = "Stop"\n';

/**
 * ALLOWLIST of fixed, read-only scripts. They take no parameters: nothing from a request or
 * a config file is ever spliced into a command line. `-InputObject @(...)` keeps a single
 * item serialised as an array.
 */
export const POWERSHELL_SCRIPTS = {
  physicalDisks: `${HEADER}$items = @(Get-PhysicalDisk | ForEach-Object {
  $model = ([string]$_.Model).Trim()
  if (-not $model) { $model = ([string]$_.FriendlyName).Trim() }
  [pscustomobject]@{
    model = $model
    mediaType = [string]$_.MediaType
    busType = [string]$_.BusType
    health = [string]$_.HealthStatus
    operational = (@($_.OperationalStatus) | ForEach-Object { [string]$_ }) -join ','
    sizeBytes = [int64]$_.Size
  }
})
ConvertTo-Json -Compress -Depth 3 -InputObject @($items)
`,
  printers: `${HEADER}$items = @(Get-CimInstance -ClassName Win32_Printer | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    isDefault = [bool]$_.Default
    printerStatus = [int]$_.PrinterStatus
    detectedErrorState = [int]$_.DetectedErrorState
    workOffline = [bool]$_.WorkOffline
    portName = [string]$_.PortName
  }
})
ConvertTo-Json -Compress -Depth 3 -InputObject @($items)
`,
  osVersion: `${HEADER}$p = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{
  product = [string]$p.ProductName
  displayVersion = [string]$p.DisplayVersion
  build = [string]$p.CurrentBuild
  ubr = [int]$p.UBR
})
`,
} as const;

export type PowerShellScriptName = keyof typeof POWERSHELL_SCRIPTS;

export const POWERSHELL_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 1024 * 1024;

/** -EncodedCommand expects base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Absolute path, so a powershell.exe earlier in PATH cannot be picked up. */
export function powershellExe(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function parseJsonOutput(stdout: string): unknown {
  const text = stripBom(stdout).trim();
  if (text === '') return [];
  try {
    return JSON.parse(text);
  } catch {
    throw new ProbeError('bad_output', 'Windows вернула данные в неожиданном формате');
  }
}

/** Runs one allowlisted script and returns its parsed JSON, or 'unsupported' outside Windows. */
export function runPowerShellScript(
  name: PowerShellScriptName,
  options: { timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<unknown> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return Promise.resolve('unsupported');
  const script = POWERSHELL_SCRIPTS[name];
  const timeoutMs = options.timeoutMs ?? POWERSHELL_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          if (error.killed || error.signal) {
            reject(new ProbeError('timeout', `Windows не ответила за ${formatSeconds(timeoutMs)} с`));
          } else if (error.code === 'ENOENT') {
            reject(new ProbeError('not_installed', 'PowerShell не найден'));
          } else {
            reject(new ProbeError('failed', 'Не удалось получить данные от Windows'));
          }
          return;
        }
        try {
          resolve(parseJsonOutput(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
