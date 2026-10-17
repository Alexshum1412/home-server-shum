<#
.SYNOPSIS
  Останавливает семейный портал (и Jellyfin под супервизором) до следующего scripts\start.cmd или перезагрузки.
.DESCRIPTION
  Если работает супервизор, ему отправляется команда shutdown: он мягко останавливает программы
  (портал сохраняет сеансы и журнал), затем завершается сам и оставляет отметку, чтобы задача
  планировщика не запустила всё снова до перезагрузки или scripts\start.cmd.
  Портал, запущенный без супервизора (старый способ), останавливается по PID или порту.
  Данные пишутся на диск атомарно сразу при изменении, поэтому остановка безопасна.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$cfg = Get-DashboardConfig

$status = Invoke-Supervisor @('status')
if ($status -and $status.ok) {
  Write-Host "Останавливаю супервизор (PID $($status.state.pid)) и программы под ним..."
  Invoke-Supervisor @('shutdown') | Out-Null
  $deadline = (Get-Date).AddSeconds(75)
  while ((Get-Date) -lt $deadline -and @(Get-SupervisorProcess).Count -gt 0) { Start-Sleep -Milliseconds 500 }
  if (@(Get-SupervisorProcess).Count -gt 0) {
    Write-Host 'Супервизор не завершился вовремя — завершаю принудительно.' -ForegroundColor Yellow
    Get-SupervisorProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
} else {
  # The watchdog trigger must not restart a supervisor that is not running now either.
  New-Item -ItemType Directory -Force -Path $cfg.RunDir | Out-Null
  @{ at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $cfg.RunDir 'supervisor-stopped.json') -Encoding ASCII
}

# Anything left: a portal started without the supervisor, or a child that outlived it.
$procs = @(Get-DashboardProcess $cfg)
foreach ($p in $procs) {
  Write-Host "Останавливаю процесс портала PID $($p.ProcessId)..."
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline -and @(Get-DashboardProcess $cfg).Count -gt 0) { Start-Sleep -Milliseconds 300 }
Remove-Item -LiteralPath $cfg.PidFile -ErrorAction SilentlyContinue

if (@(Get-DashboardProcess $cfg).Count -gt 0) {
  Write-Host 'Не удалось остановить процесс. Попробуйте ещё раз или перезагрузите компьютер.' -ForegroundColor Red
  exit 1
}
$stillListening = Get-NetTCPConnection -State Listen -LocalPort $cfg.Port -ErrorAction SilentlyContinue
if ($stillListening) {
  Write-Host "Портал остановлен, но порт $($cfg.Port) всё ещё занят другим процессом." -ForegroundColor Yellow
} else {
  Write-Host "Портал остановлен, порт $($cfg.Port) свободен. Снова запустить: scripts\start.cmd" -ForegroundColor Green
}
exit 0
