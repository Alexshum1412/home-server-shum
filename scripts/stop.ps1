<#
.SYNOPSIS
  Останавливает фоновый процесс семейного дашборда.
.DESCRIPTION
  Останавливает только процессы node.exe, запущенные с server/src/index.ts.
  Данные пишутся на диск атомарно сразу при изменении, поэтому остановка безопасна.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$cfg = Get-DashboardConfig

$procs = @(Get-DashboardProcess)
if ($procs.Count -eq 0) {
  Write-Host 'Дашборд не запущен.'
  Remove-Item -LiteralPath $cfg.PidFile -ErrorAction SilentlyContinue
  exit 0
}

foreach ($p in $procs) {
  Write-Host "Останавливаю процесс дашборда PID $($p.ProcessId)..."
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline -and @(Get-DashboardProcess).Count -gt 0) { Start-Sleep -Milliseconds 300 }
Remove-Item -LiteralPath $cfg.PidFile -ErrorAction SilentlyContinue

if (@(Get-DashboardProcess).Count -gt 0) {
  Write-Host 'Не удалось остановить процесс. Попробуйте ещё раз или перезагрузите компьютер.' -ForegroundColor Red
  exit 1
}
$stillListening = Get-NetTCPConnection -State Listen -LocalPort $cfg.Port -ErrorAction SilentlyContinue
if ($stillListening) {
  Write-Host "Процесс остановлен, но порт $($cfg.Port) всё ещё занят другим процессом." -ForegroundColor Yellow
} else {
  Write-Host "Дашборд остановлен, порт $($cfg.Port) свободен." -ForegroundColor Green
}
exit 0
