@echo off
rem Step 2 of moving the server: run on the NEW computer as administrator. Builds the same server and restores the package.
rem Usage: scripts\move-server-setup.cmd [-Package <zip>] [-Yes] [-DryRun]
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0move-server-setup.ps1" %*
if not defined NO_PAUSE pause
