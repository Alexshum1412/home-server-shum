@echo off
rem Manual control of the programs the supervisor runs: service.cmd status ^| start ^| stop ^| restart <dashboard^|jellyfin^|aria2^|llama>
rem (the same commands the automatic supervisor uses; if the supervisor itself is down, run start.cmd)
set "NODE=%SystemDrive%\FamilyServer\tools\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
pushd "%~dp0.."
"%NODE%" --env-file-if-exists=.env server\src\supervisor\main.ts %*
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
