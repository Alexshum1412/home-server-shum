@echo off
rem Copy a folder (USB stick, phone connected by cable) into the family files or photos: import.cmd <folder> --user <login> [--root files^|photos] [--dry-run]
set "NODE=%SystemDrive%\FamilyServer\tools\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
pushd "%~dp0.."
"%NODE%" --env-file-if-exists=.env server\src\cli\transfer.ts import %*
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
