@echo off
rem Runs scripts\status.ps1 without changing the system PowerShell execution policy.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0status.ps1" %*
if /i "%~1"=="" if not defined NO_PAUSE pause
