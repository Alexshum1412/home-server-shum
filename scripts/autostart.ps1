<#
.SYNOPSIS
  Включает или выключает автозапуск дашборда при входе в Windows (задача планировщика текущего пользователя).
.DESCRIPTION
  Включить:  scripts\autostart.cmd
  Выключить: scripts\autostart.cmd -Off
  Задача «FamilyDashboard» запускает scripts\start.ps1 при входе ЭТОГО пользователя, с обычными
  (не администраторскими) правами. Ничего другого в системе не меняется.
#>
[CmdletBinding()]
param([switch]$Off)

$ErrorActionPreference = 'Stop'
$taskName = 'FamilyDashboard'
$start = Join-Path $PSScriptRoot 'start.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

if ($Off) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host 'Автозапуск выключен.' -ForegroundColor Green
  } else {
    Write-Host 'Автозапуск не был включён.'
  }
  exit 0
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description 'Семейный сервер: запуск дашборда при входе пользователя' -Force | Out-Null
Write-Host "Автозапуск включён: задача '$taskName' запустит дашборд при входе пользователя $user." -ForegroundColor Green
Write-Host 'Важно: без входа в Windows после перезагрузки Tailscale на Windows по умолчанию тоже не подключён.'
