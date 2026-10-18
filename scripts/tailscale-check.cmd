@echo off
rem Reads the Tailscale settings of this server (exit node, published services, stale devices); changes nothing
rem unless called with -DisableExitNode -Yes. Usage: scripts\tailscale-check.cmd [-DisableExitNode -Yes] [-StaleDays 30]
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tailscale-check.ps1" %*
set "RC=%ERRORLEVEL%"
if not defined NO_PAUSE if "%~1"=="" pause
exit /b %RC%
