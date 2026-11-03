@echo off
rem Opens Sysinternals Autologon (Microsoft): Windows signs in by itself after a restart, so the server programs start without anybody at the keyboard.
rem The password is typed by the owner into the Autologon window (Windows keeps it in an encrypted form; this project never sees it).
set "TOOL=%SystemDrive%\FamilyServer\tools\autologon\Autologon64.exe"
if not exist "%TOOL%" (
  echo Autologon is not installed: %TOOL%
  echo Download AutoLogon.zip from https://learn.microsoft.com/sysinternals/downloads/autologon and unpack Autologon64.exe there.
  exit /b 1
)
start "" "%TOOL%"
