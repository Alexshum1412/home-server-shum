<#
.SYNOPSIS
  Запускает семейный портал в фоне под наблюдением супервизора.
.DESCRIPTION
  Проверяет Node.js и зависимости, при необходимости собирает интерфейс и запускает супервизор
  (server\src\supervisor\main.ts): через задачу планировщика «FamilyServer», если автозапуск включён,
  иначе скрытым процессом в этом сеансе. Супервизор держит портал (и Jellyfin, если установлен),
  перезапускает их после сбоя и зависания. Скрипт ждёт ответа /api/health.
  Логи: <каталог данных>\logs\supervisor.log, dashboard.out.log, dashboard.err.log
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$cfg = Get-DashboardConfig

$node = Get-NodeExe
if (-not $node) {
  Write-Host 'Node.js не найден. Установите Node.js 24 LTS (см. README, раздел «Установка»).' -ForegroundColor Red
  exit 1
}
$nodeVersion = (& $node --version).TrimStart('v')
if ([version]$nodeVersion -lt [version]'24.11.0') {
  Write-Host "Нужен Node.js 24.11 или новее, найден $nodeVersion." -ForegroundColor Red
  exit 1
}

Set-Location -LiteralPath $cfg.RepoRoot
if (-not (Test-Path -LiteralPath (Join-Path $cfg.RepoRoot 'node_modules'))) {
  Write-Host 'Зависимости не установлены. Выполните: npm.cmd ci' -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $cfg.RepoRoot 'dist\web\index.html'))) {
  Write-Host 'Интерфейс ещё не собран — собираю (npm.cmd run build)...'
  $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
  & $npm run build
  if ($LASTEXITCODE -ne 0) { Write-Host 'Сборка интерфейса не удалась.' -ForegroundColor Red; exit 1 }
}

New-Item -ItemType Directory -Force -Path $cfg.LogDir, $cfg.RunDir | Out-Null
# start.cmd cancels an earlier stop.cmd: the scheduler watchdog may start the supervisor again.
Remove-Item -LiteralPath (Join-Path $cfg.RunDir 'supervisor-stopped.json') -ErrorAction SilentlyContinue

$status = Invoke-Supervisor @('status')
if ($status -and $status.ok) {
  if (-not (Test-DashboardHealth $cfg.Port)) {
    Write-Host 'Супервизор работает — прошу его запустить портал...'
    Invoke-Supervisor @('start', 'dashboard') | Out-Null
  }
} elseif (Test-DashboardHealth $cfg.Port) {
  $running = @(Get-DashboardProcess $cfg)
  $who = if ($running.Count -gt 0) { " (PID $($running[0].ProcessId))" } else { '' }
  Write-Host "Портал уже запущен без супервизора$who`: http://127.0.0.1:$($cfg.Port)" -ForegroundColor Green
  Write-Host 'Чтобы портал перезапускался после сбоя, выполните scripts\stop.cmd и затем scripts\start.cmd.'
  exit 0
} else {
  $busy = Get-NetTCPConnection -State Listen -LocalPort $cfg.Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($busy) {
    $owner = (Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Write-Host "Порт $($cfg.Port) уже занят процессом '$owner' (PID $($busy.OwningProcess)). Укажите другой PORT в .env." -ForegroundColor Red
    exit 1
  }
  if (Get-SupervisorTask) {
    Write-Host "Запускаю задачу планировщика «$script:SupervisorTask» (супервизор портала)..."
    Start-ScheduledTask -TaskName $script:SupervisorTask
  } else {
    # Without the autostart task: the supervisor runs hidden in this user's session. cmd.exe via
    # ShellExecute (no -Redirect*) so the background process does not inherit this window's handles:
    # a caller capturing the output of start.cmd would otherwise hang until the server stops.
    $console = Join-Path $cfg.LogDir 'supervisor.console.log'
    $cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $cmdArgs = "/d /s /c `"`"$node`" --env-file-if-exists=.env server/src/supervisor/main.ts 1>>`"$console`" 2>&1`""
    Start-Process -FilePath $cmdExe -ArgumentList $cmdArgs -WorkingDirectory $cfg.RepoRoot -WindowStyle Hidden | Out-Null
  }
}

$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
  if (Test-DashboardHealth $cfg.Port) {
    $server = @(Get-DashboardProcess $cfg) | Select-Object -First 1
    $serverPid = if ($server) { [int]$server.ProcessId } else { $null }
    @{ pid = $serverPid; port = $cfg.Port; startedAt = (Get-Date).ToString('o') } |
      ConvertTo-Json | Set-Content -LiteralPath $cfg.PidFile -Encoding UTF8
    Write-Host "Портал запущен (PID $serverPid) под наблюдением супервизора." -ForegroundColor Green
    Write-Host "  На этом компьютере: http://127.0.0.1:$($cfg.Port)"
    Write-Host "  Логи: $($cfg.LogDir) (supervisor.log, dashboard.out.log, dashboard.err.log)"
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

Write-Host 'Портал не ответил за 40 секунд. Последние строки журналов:' -ForegroundColor Red
# Fastify logs (including listen errors such as a busy or reserved port) go to stdout -> out.log;
# configuration errors go to stderr -> err.log; the supervisor writes supervisor.log. All UTF-8.
foreach ($name in 'supervisor.log', 'supervisor.console.log', 'dashboard.out.log', 'dashboard.err.log') {
  $f = Join-Path $cfg.LogDir $name
  if (Test-Path -LiteralPath $f) {
    Write-Host "--- $f"
    Get-Content -LiteralPath $f -Tail 15 -Encoding UTF8
  }
}
exit 1
