@echo off
rem First-time setup of the local Jellyfin: wizard, admin with a generated password (shown once),
rem API key for the supervisor, libraries under C:\FamilyData\Media. Safe to run again.
rem Usage: scripts\jellyfin-setup.cmd [--admin <login>]
set "NODE=%SystemDrive%\FamilyServer\tools\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
pushd "%~dp0.."
"%NODE%" --env-file-if-exists=.env server\src\cli\jellyfin-setup.ts %*
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
