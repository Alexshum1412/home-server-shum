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

$running = @(Get-DashboardProcess)
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

$proc = Start-Process -FilePath $node `
  -ArgumentList '--env-file-if-exists=.env', 'server/src/index.ts' `
  -WorkingDirectory $cfg.RepoRoot -WindowStyle Hidden `
  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru

@{ pid = $proc.Id; port = $cfg.Port; startedAt = (Get-Date).ToString('o') } |
  ConvertTo-Json | Set-Content -LiteralPath $cfg.PidFile -Encoding UTF8

$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { break }
  if (Test-DashboardHealth $cfg.Port) {
    Write-Host "Дашборд запущен (PID $($proc.Id))." -ForegroundColor Green
    Write-Host "  На этом компьютере: http://127.0.0.1:$($cfg.Port)"
    Write-Host "  Логи: $($cfg.LogDir)"
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

Write-Host 'Сервер не ответил за 25 секунд. Последние строки журнала ошибок:' -ForegroundColor Red
if (Test-Path -LiteralPath $err) { Get-Content -LiteralPath $err -Tail 20 }
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
Remove-Item -LiteralPath $cfg.PidFile -ErrorAction SilentlyContinue
exit 1
