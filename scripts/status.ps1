<#
.SYNOPSIS
  Показывает состояние семейного сервера: супервизор и программы под ним, ответ портала, адреса,
  автозапуск, Tailscale Serve. Ничего не меняет.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common.ps1')
$cfg = Get-DashboardConfig

$stateLabel = @{
  running = 'работает'; starting = 'запускается'; backoff = 'сбой, ждёт перезапуска'; stopping = 'останавливается'
  stopped = 'остановлен'; external = 'работает отдельно от супервизора'
}
$status = Invoke-Supervisor @('status')
if ($status -and $status.ok) {
  $s = $status.state
  Write-Host "Супервизор: работает (PID $($s.pid), с $($s.startedAt))" -ForegroundColor Green
  foreach ($app in $s.apps) {
    $label = $stateLabel[$app.state]
    if (-not $label) { $label = $app.state }
    $color = if ($app.state -eq 'running' -or $app.state -eq 'external') { 'Green' } else { 'Yellow' }
    $pidText = if ($app.pid) { ", PID $($app.pid)" } else { '' }
    Write-Host ("  {0}: {1}{2}; перезапусков после сбоя: {3}. {4}" -f $app.title, $label, $pidText, $app.restarts, $app.message) -ForegroundColor $color
  }
} else {
  Write-Host 'Супервизор: не запущен' -ForegroundColor Yellow
  $procs = @(Get-DashboardProcess $cfg)
  foreach ($p in $procs) { Write-Host "Процесс портала без супервизора: PID $($p.ProcessId), запущен $($p.CreationDate)" }
}

if (Test-DashboardHealth $cfg.Port) {
  Write-Host "Портал отвечает: http://127.0.0.1:$($cfg.Port)/api/health — ok" -ForegroundColor Green
} else {
  Write-Host "Портал не отвечает на http://127.0.0.1:$($cfg.Port)" -ForegroundColor Yellow
}

$listen = Get-NetTCPConnection -State Listen -LocalPort $cfg.Port -ErrorAction SilentlyContinue
foreach ($l in $listen) { Write-Host "Прослушивается: $($l.LocalAddress):$($l.LocalPort)" }

$task = Get-SupervisorTask
if ($task) {
  $info = $task | Get-ScheduledTaskInfo
  $mode = if ($task.Principal.LogonType -eq 'S4U') { 'при включении компьютера, при входе и каждые 5 минут' } else { 'при входе пользователя' }
  Write-Host "Автозапуск: включён (задача «$($task.TaskName)»: $mode; последний запуск $($info.LastRunTime), результат $($info.LastTaskResult))"
} else {
  Write-Host 'Автозапуск: выключен (включить: scripts\autostart.cmd)' -ForegroundColor Yellow
}

Write-Host "Каталог данных: $($cfg.DataDir)"
Write-Host "Логи: $($cfg.LogDir)"

if (Test-Path -LiteralPath $cfg.TailscaleExe) {
  Write-Host ''
  Write-Host 'Tailscale Serve (частный HTTPS в tailnet):'
  & $cfg.TailscaleExe serve status
} else {
  Write-Host 'Tailscale CLI не найден.' -ForegroundColor Yellow
}
