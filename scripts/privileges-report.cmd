@echo off
rem Read-only report: which accounts run the server programs and who can write to the server folders.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0privileges-report.ps1" %*
set "RC=%ERRORLEVEL%"
if not defined NO_PAUSE if "%~1"=="" pause
exit /b %RC%
