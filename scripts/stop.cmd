@echo off
rem Runs scripts\stop.ps1 without changing the system PowerShell execution policy.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
if /i "%~1"=="" if not defined NO_PAUSE pause
