@echo off
rem Copy family files or photos out to a new folder (for example on a USB stick): export.cmd --user <login> --to <new folder> [--root files^|photos]
set "NODE=%SystemDrive%\FamilyServer\tools\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
pushd "%~dp0.."
"%NODE%" --env-file-if-exists=.env server\src\cli\transfer.ts export %*
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
