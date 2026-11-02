@echo off
rem Step 1 of moving the server to another computer: run on the OLD one. Collects settings, accounts and secrets into one zip.
rem Usage: scripts\move-server-pack.cmd [-To <folder>]
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0move-server-pack.ps1" %*
if not defined NO_PAUSE pause
