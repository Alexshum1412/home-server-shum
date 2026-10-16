# Shared helpers for the dashboard operation scripts (dot-source this file).
# Read-only helpers: nothing here changes system settings.

$script:RepoRoot = Split-Path -Parent $PSScriptRoot

function Get-DotEnv {
  # Minimal KEY=VALUE reader for the optional .env file (comments and blank lines ignored).
  $result = @{}
  $path = Join-Path $script:RepoRoot '.env'
  if (Test-Path -LiteralPath $path) {
    foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
      $t = $line.Trim()
      if ($t -eq '' -or $t.StartsWith('#')) { continue }
      $i = $t.IndexOf('=')
      if ($i -lt 1) { continue }
      $key = $t.Substring(0, $i).Trim()
      $value = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
      $result[$key] = $value
    }
  }
  return $result
}

function Get-Setting([string]$Name, [string]$Default) {
  $envValue = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ($envValue) { return $envValue }
  $dotEnv = Get-DotEnv
  if ($dotEnv.ContainsKey($Name) -and $dotEnv[$Name]) { return $dotEnv[$Name] }
  return $Default
}

function Get-DashboardConfig {
  $defaultData = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'FamilyDashboard' } else { Join-Path $HOME '.family-dashboard' }
  $dataDir = Get-Setting 'DASHBOARD_DATA_DIR' $defaultData
  [pscustomobject]@{
    RepoRoot = $script:RepoRoot
    Port     = [int](Get-Setting 'PORT' '8070')
    HostName = Get-Setting 'HOST' '127.0.0.1'
    DataDir  = $dataDir
    RunDir   = Join-Path $dataDir 'run'
    LogDir   = Join-Path $dataDir 'logs'
    PidFile  = Join-Path (Join-Path $dataDir 'run') 'dashboard.pid.json'
    TailscaleExe = Get-Setting 'TAILSCALE_EXE' 'C:\Program Files\Tailscale\tailscale.exe'
  }
}

function Get-NodeExe {
  $local = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'
  if (Test-Path -LiteralPath $local) { return $local }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return $null
}

function Test-IsDashboardCommandLine($proc) {
  return ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -and
    $proc.CommandLine -match 'server[\\/]src[\\/]index\.ts')
}

function Get-DashboardProcess($Cfg) {
  # The dashboard instance of THIS configuration: the PID recorded by start.ps1, or the node
  # process that listens on the configured port. Other node servers (e.g. e2e test servers on
  # other ports) are never matched.
  $found = @{}
  if (Test-Path -LiteralPath $Cfg.PidFile) {
    try {
      $info = Get-Content -LiteralPath $Cfg.PidFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $p = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$info.pid)" -ErrorAction SilentlyContinue
      if (Test-IsDashboardCommandLine $p) { $found[[int]$p.ProcessId] = $p }
    } catch {
      # unreadable PID file: fall back to the port check below
    }
  }
  foreach ($l in @(Get-NetTCPConnection -State Listen -LocalPort $Cfg.Port -ErrorAction SilentlyContinue)) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($l.OwningProcess)" -ErrorAction SilentlyContinue
    if (Test-IsDashboardCommandLine $p) { $found[[int]$p.ProcessId] = $p }
  }
  return @($found.Values)
}

function Test-DashboardHealth([int]$Port, [int]$TimeoutSec = 2) {
  try {
    $r = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec $TimeoutSec
    return ($r.status -eq 'ok')
  } catch {
    return $false
  }
}
