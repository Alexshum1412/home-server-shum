@echo off
rem Runs scripts\autostart.ps1 without changing the system PowerShell execution policy. Add -Off to undo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" %*
if /i "%~1"=="" if not defined NO_PAUSE pause
