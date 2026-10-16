<#
.SYNOPSIS
  Показывает состояние семейного дашборда: процесс, ответ сервера, адреса, Tailscale Serve.
  Ничего не меняет.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common.ps1')
$cfg = Get-DashboardConfig

$procs = @(Get-DashboardProcess $cfg)
if ($procs.Count -eq 0) {
  Write-Host 'Процесс дашборда: не запущен' -ForegroundColor Yellow
} else {
  foreach ($p in $procs) { Write-Host "Процесс дашборда: PID $($p.ProcessId), запущен $($p.CreationDate)" -ForegroundColor Green }
}

if (Test-DashboardHealth $cfg.Port) {
  Write-Host "Сервер отвечает: http://127.0.0.1:$($cfg.Port)/api/health — ok" -ForegroundColor Green
} else {
  Write-Host "Сервер не отвечает на http://127.0.0.1:$($cfg.Port)" -ForegroundColor Yellow
}

$listen = Get-NetTCPConnection -State Listen -LocalPort $cfg.Port -ErrorAction SilentlyContinue
foreach ($l in $listen) { Write-Host "Прослушивается: $($l.LocalAddress):$($l.LocalPort)" }

Write-Host "Каталог данных: $($cfg.DataDir)"
Write-Host "Логи: $($cfg.LogDir)"

if (Test-Path -LiteralPath $cfg.TailscaleExe) {
  Write-Host ''
  Write-Host 'Tailscale Serve (частный HTTPS в tailnet):'
  & $cfg.TailscaleExe serve status
} else {
  Write-Host 'Tailscale CLI не найден.' -ForegroundColor Yellow
}
