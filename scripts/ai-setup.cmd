@echo off
rem Installs the local language model for Olivia (llama.cpp CPU build + a ~1.1 GB model) after the owner
rem confirms each download. Nothing leaves the PC afterwards: the model runs on 127.0.0.1 only.
rem Usage: scripts\ai-setup.cmd [-Yes]
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-component.ps1" -Name llama %*
if errorlevel 1 goto :failed
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-component.ps1" -Name model %*
if errorlevel 1 goto :failed
echo.
echo Next: add the line OLIVIA_LLM_URL=http://127.0.0.1:8081/v1 to .env (UTF-8 without BOM),
echo       then run scripts\service.cmd restart dashboard
goto :end
:failed
echo.
echo Installation stopped, see the message above.
:end
if not defined NO_PAUSE pause
exit /b 0
