# Shared helpers for the dashboard operation scripts (dot-source this file).
# Read-only helpers: nothing here changes system settings.

$script:RepoRoot = Split-Path -Parent $PSScriptRoot

function Get-DotEnv {
  # Minimal KEY=VALUE reader for the optional .env file (comments and blank lines ignored).
  $result = @{}
  $path = Join-Path $script:RepoRoot '.env'
  if (Test-Path -LiteralPath $path) {
    # Node reads .env as UTF-8 without BOM: a BOM breaks the first key and UTF-16 (what
    # `> .env` produces in Windows PowerShell 5.1) is ignored entirely. Refuse both so the
    # scripts never check a different PORT/data dir than the server actually uses.
    $bytes = [IO.File]::ReadAllBytes($path)
    if (($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) -or
        ($bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF)))) {
      throw "Файл .env сохранён с BOM или в UTF-16. Сохраните его в кодировке UTF-8 без BOM (например, в Блокноте: «Сохранить как» → UTF-8)."
    }
    $text = (New-Object Text.UTF8Encoding($false)).GetString($bytes)
    foreach ($line in ($text -split "`r?`n")) {
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

# Everything the server needs lives under one non-AppData root. AppData is avoided on purpose:
# packaged apps (e.g. the Claude desktop app) virtualize AppData writes, which would hide the
# tools and data from Explorer and Task Scheduler.
$script:FamilyRoot = Join-Path $(if ($env:SystemDrive) { $env:SystemDrive } else { 'C:' }) 'FamilyServer'

function Get-DashboardConfig {
  $defaultData = Join-Path $script:FamilyRoot 'data\dashboard'
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
  $own = Join-Path $script:FamilyRoot 'tools\nodejs\node.exe'
  if (Test-Path -LiteralPath $own) { return $own }
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

# --- Supervisor (server/src/supervisor/main.ts) ------------------------------------------------
# The scheduler task that starts the supervisor at boot (S4U: no password stored, no window).
$script:SupervisorTask = 'FamilyServer'

function Test-IsSupervisorCommandLine($proc) {
  return ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -and
    $proc.CommandLine -match 'server[\\/]src[\\/]supervisor[\\/]main\.ts')
}

function Get-SupervisorProcess {
  return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { Test-IsSupervisorCommandLine $_ })
}

# Runs `node server/src/supervisor/main.ts <args>` and returns the parsed JSON answer, or $null
# when the supervisor is not running (exit code 3) or answered nothing useful.
function Invoke-Supervisor([string[]]$Arguments) {
  $node = Get-NodeExe
  if (-not $node) { return $null }
  Push-Location -LiteralPath $script:RepoRoot
  # Node prints UTF-8; without this Windows PowerShell decodes it with the OEM code page.
  $previousEncoding = [Console]::OutputEncoding
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  try {
    $out = & $node --env-file-if-exists=.env server/src/supervisor/main.ts @Arguments 2>$null
    if ($LASTEXITCODE -eq 3 -or -not $out) { return $null }
    return (($out -join "`n") | ConvertFrom-Json)
  } catch {
    return $null
  } finally {
    [Console]::OutputEncoding = $previousEncoding
    Pop-Location
  }
}

function Get-SupervisorTask {
  return Get-ScheduledTask -TaskName $script:SupervisorTask -ErrorAction SilentlyContinue
}
