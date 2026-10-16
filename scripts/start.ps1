<#
.SYNOPSIS
  Запускает семейный дашборд в фоне (права администратора не нужны).
.DESCRIPTION
  Проверяет Node.js и зависимости, при необходимости собирает интерфейс,
  запускает сервер скрытым процессом, пишет PID и ждёт ответа /api/health.
  Логи: <каталог данных>\logs\dashboard.out.log и dashboard.err.log
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

$running = @(Get-DashboardProcess $cfg)
if ($running.Count -gt 0) {
  if (Test-DashboardHealth $cfg.Port) {
    Write-Host "Дашборд уже запущен (PID $($running[0].ProcessId)): http://127.0.0.1:$($cfg.Port)" -ForegroundColor Green
    exit 0
  }
  Write-Host "Найден процесс дашборда (PID $($running[0].ProcessId)), но он не отвечает. Выполните scripts\stop.cmd и повторите." -ForegroundColor Yellow
  exit 1
}

$busy = Get-NetTCPConnection -State Listen -LocalPort $cfg.Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
  $owner = (Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue).ProcessName
  Write-Host "Порт $($cfg.Port) уже занят процессом '$owner' (PID $($busy.OwningProcess)). Укажите другой PORT в .env." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $cfg.RepoRoot 'dist\web\index.html'))) {
  Write-Host 'Интерфейс ещё не собран — собираю (npm.cmd run build)...'
  $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
  & $npm run build
  if ($LASTEXITCODE -ne 0) { Write-Host 'Сборка интерфейса не удалась.' -ForegroundColor Red; exit 1 }
}

New-Item -ItemType Directory -Force -Path $cfg.LogDir, $cfg.RunDir | Out-Null
$out = Join-Path $cfg.LogDir 'dashboard.out.log'
$err = Join-Path $cfg.LogDir 'dashboard.err.log'
foreach ($f in $out, $err) {
  if (Test-Path -LiteralPath $f) { Move-Item -LiteralPath $f -Destination "$f.1" -Force }
}

# cmd.exe writes the server output to the log files. Start-Process WITHOUT -Redirect* goes through
# ShellExecute, so the background server does not inherit this window's handles: a caller that
# captures the output of start.cmd (scripts, agents, CI) would otherwise hang until the server stops.
$cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
$cmdArgs = "/d /s /c `"`"$node`" --env-file-if-exists=.env server/src/index.ts 1>`"$out`" 2>`"$err`"`""
$launcher = Start-Process -FilePath $cmdExe -ArgumentList $cmdArgs -WorkingDirectory $cfg.RepoRoot `
  -WindowStyle Hidden -PassThru

$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  if (Test-DashboardHealth $cfg.Port) {
    $server = @(Get-DashboardProcess $cfg) | Select-Object -First 1
    $serverPid = if ($server) { [int]$server.ProcessId } else { $null }
    @{ pid = $serverPid; port = $cfg.Port; startedAt = (Get-Date).ToString('o') } |
      ConvertTo-Json | Set-Content -LiteralPath $cfg.PidFile -Encoding UTF8
    Write-Host "Дашборд запущен (PID $serverPid)." -ForegroundColor Green
    Write-Host "  На этом компьютере: http://127.0.0.1:$($cfg.Port)"
    Write-Host "  Логи: $($cfg.LogDir)"
    exit 0
  }
  if ($launcher.HasExited) { break }
  Start-Sleep -Milliseconds 500
}

if ($launcher.HasExited) {
  Write-Host 'Сервер завершился при запуске. Последние строки журналов:' -ForegroundColor Red
} else {
  Write-Host 'Сервер не ответил за 25 секунд. Последние строки журналов:' -ForegroundColor Red
  # Stop the half-started server (the node child of the launcher) and the launcher itself.
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $($launcher.Id)" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
}
# Fastify logs (including listen errors such as a busy or reserved port) go to stdout -> out.log;
# configuration errors go to stderr -> err.log. Both are UTF-8.
foreach ($f in $out, $err) {
  if (Test-Path -LiteralPath $f) {
    Write-Host "--- $f"
    Get-Content -LiteralPath $f -Tail 20 -Encoding UTF8
  }
}
Remove-Item -LiteralPath $cfg.PidFile -ErrorAction SilentlyContinue
exit 1
