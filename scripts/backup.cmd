@echo off
rem Family server backups (no args = run): backup.cmd run ^| list ^| verify [snapshot] ^| restore <snapshot> --to <dir> ^| test-restore ^| prune
set "NODE=%SystemDrive%\FamilyServer\tools\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
set "FIRST=%~1"
pushd "%~dp0.."
if not defined FIRST goto :default
"%NODE%" --env-file-if-exists=.env server\src\cli\backup.ts %*
goto :done
:default
"%NODE%" --env-file-if-exists=.env server\src\cli\backup.ts run
:done
set "RC=%ERRORLEVEL%"
popd
if not defined FIRST if not defined NO_PAUSE pause
exit /b %RC%
