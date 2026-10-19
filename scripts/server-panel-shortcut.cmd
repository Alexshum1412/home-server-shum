@echo off
rem Puts the "Semeynyi server" shortcut (on/off/restart window) on the desktop. -Off removes it.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-panel-shortcut.ps1" %*
if /i "%~1"=="" if not defined NO_PAUSE pause
