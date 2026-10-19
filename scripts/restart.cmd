@echo off
rem Runs scripts\restart.ps1 (stop, then start) without changing the system PowerShell execution policy.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart.ps1" %*
if /i "%~1"=="" if not defined NO_PAUSE pause
