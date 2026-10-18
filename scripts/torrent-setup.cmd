@echo off
rem Installs the torrent client (aria2) after the owner confirms the download, then restarts the supervised programs.
rem Usage: scripts\torrent-setup.cmd [-Yes]
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-component.ps1" -Name aria2 %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :end
echo.
echo Next: scripts\service.cmd restart dashboard   (the supervisor then starts aria2 by itself)
:end
if not defined NO_PAUSE pause
exit /b %RC%
