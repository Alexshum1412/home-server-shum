@echo off
rem Manage dashboard users: user.cmd add <login> --name "Name" --role family^|admin ; user.cmd list ; user.cmd passwd <login> ; user.cmd role <login> family^|admin ; user.cmd remove <login> --yes
set "NODE=%SystemDrive%\FamilyServer\tools\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
pushd "%~dp0.."
"%NODE%" --env-file-if-exists=.env server\src\cli\users.ts %*
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
