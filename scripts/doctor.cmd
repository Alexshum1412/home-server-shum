@echo off
rem Independent diagnosis of the family server (changes nothing): doctor.cmd [--json]
set "NODE=%SystemDrive%\FamilyServer\tools\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
pushd "%~dp0.."
"%NODE%" --env-file-if-exists=.env server\src\cli\doctor.ts %*
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
