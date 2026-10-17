<#
.SYNOPSIS
  Включает или выключает автозапуск семейного сервера (портал + Jellyfin под супервизором).
.DESCRIPTION
  Включить:  scripts\autostart.cmd          (нужны права администратора — один раз)
  Выключить: scripts\autostart.cmd -Off
  Задача планировщика «FamilyServer» запускает супервизор (server\src\supervisor\main.ts):
    * при включении компьютера — ещё до входа в Windows (режим S4U: пароль не хранится, окон нет);
    * при входе пользователя и каждые 5 минут — как сторож: если супервизор уже работает, второй
      экземпляр сразу завершается; если его остановили scripts\stop.cmd — ждёт start.cmd или перезагрузки.
  Супервизор сам перезапускает портал и Jellyfin после сбоя или зависания.
  Без прав администратора (S4U недоступен) задача создаётся в режиме «только при входе пользователя».
  Старая задача «FamilyDashboard» (запуск при входе) удаляется.
#>
[CmdletBinding()]
param([switch]$Off)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$cfg = Get-DashboardConfig
$taskName = $script:SupervisorTask
$legacyTask = 'FamilyDashboard'
$user = "$env:USERDOMAIN\$env:USERNAME"

if (Get-ScheduledTask -TaskName $legacyTask -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $legacyTask -Confirm:$false
  Write-Host "Старая задача «$legacyTask» удалена."
}

if ($Off) {
  if (Get-SupervisorTask) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host 'Автозапуск выключен. Работающий сейчас портал не остановлен (scripts\stop.cmd).' -ForegroundColor Green
  } else {
    Write-Host 'Автозапуск не был включён.'
  }
  exit 0
}

$node = Get-NodeExe
if (-not $node) { Write-Host 'Node.js не найден (см. README).' -ForegroundColor Red; exit 1 }
New-Item -ItemType Directory -Force -Path $cfg.LogDir, $cfg.RunDir | Out-Null

$action = New-ScheduledTaskAction -Execute $node `
  -Argument '--env-file-if-exists=.env server\src\supervisor\main.ts' -WorkingDirectory $cfg.RepoRoot
$watchdog = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$description = 'Семейный сервер: супервизор портала и Jellyfin (перезапуск после сбоя). scripts\autostart.cmd -Off — выключить.'

$mode = 'S4U'
try {
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $user), $watchdog)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal `
    -Settings $settings -Description $description -Force | Out-Null
} catch {
  # S4U and the boot trigger need administrator rights; fall back to "while the user is signed in".
  $mode = 'Interactive'
  Write-Host "Режим «при включении компьютера» недоступен: $($_.Exception.Message)" -ForegroundColor Yellow
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  # No 5-minute watchdog here: in the user's session every run would flash a console window.
  $triggers = @(New-ScheduledTaskTrigger -AtLogOn -User $user)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal `
    -Settings $settings -Description $description -Force | Out-Null
}

if ($mode -eq 'S4U') {
  Write-Host "Автозапуск включён: задача «$taskName» запускает портал при включении компьютера (до входа в Windows)," -ForegroundColor Green
  Write-Host 'при входе пользователя и проверяет его каждые 5 минут. Пароль Windows в планировщике не хранится.'
} else {
  Write-Host "Автозапуск включён: задача «$taskName» запускает портал при входе пользователя $user" -ForegroundColor Green
  Write-Host 'Для запуска до входа и проверки каждые 5 минут выполните этот скрипт от имени администратора.'
}
Write-Host 'Важно: удалённый доступ (Tailscale) на Windows по умолчанию работает только после входа в Windows.'
