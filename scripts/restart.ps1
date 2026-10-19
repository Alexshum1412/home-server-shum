<#
.SYNOPSIS
  Перезапускает семейный сервер целиком: останавливает портал и программы под супервизором, затем запускает снова.
.DESCRIPTION
  То же, что scripts\stop.cmd и сразу scripts\start.cmd. Нужен, чтобы подхватить новую версию кода
  или настройки .env. Данные не затрагиваются. Занимает около полуминуты.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'stop.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Start-Sleep -Seconds 1
& (Join-Path $PSScriptRoot 'start.ps1')
exit $LASTEXITCODE
