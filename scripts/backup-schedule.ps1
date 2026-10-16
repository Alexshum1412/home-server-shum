<#
.SYNOPSIS
  Включает или выключает ежедневное резервное копирование (задача планировщика текущего пользователя).
.DESCRIPTION
  Включить:  scripts\backup-schedule.cmd
  Выключить: scripts\backup-schedule.cmd -Off
  Задача «FamilyServerBackup» каждый день в 03:30 (или при первой возможности, если компьютер был
  выключен) запускает scripts\backup.cmd run: копии на основной диск (C:\FamilyServer\backups) и на
  флешку с меткой «reserve». Журнал: <каталог данных>\logs\backup.log. Права администратора не нужны.
  Пока пользователь не вошёл в Windows, задача не выполняется (пароль в планировщике не хранится).
#>
[CmdletBinding()]
param([switch]$Off, [string]$At = '03:30')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$cfg = Get-DashboardConfig
$taskName = 'FamilyServerBackup'
$user = "$env:USERDOMAIN\$env:USERNAME"

if ($Off) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host 'Ежедневное резервное копирование выключено.' -ForegroundColor Green
  } else {
    Write-Host 'Ежедневное резервное копирование не было включено.'
  }
  exit 0
}

New-Item -ItemType Directory -Force -Path $cfg.LogDir | Out-Null
$backupCmd = Join-Path $PSScriptRoot 'backup.cmd'
$log = Join-Path $cfg.LogDir 'backup.log'
# cmd /s /c "...": the whole inner command line is quoted once; paths with spaces stay quoted inside.
$cmdArgs = "/d /s /c `"`"$backupCmd`" run >> `"$log`" 2>&1`""
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\cmd.exe') -Argument $cmdArgs
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description 'Семейный сервер: ежедневная резервная копия (основной диск + флешка reserve)' -Force | Out-Null
Write-Host "Ежедневное резервное копирование включено: задача '$taskName', каждый день в $At." -ForegroundColor Green
Write-Host "Журнал: $log"
