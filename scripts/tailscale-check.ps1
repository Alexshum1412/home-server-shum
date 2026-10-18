<#
.SYNOPSIS
  Проверяет настройки Tailscale на сервере: выходной узел (exit node), служебные порты и устаревшие устройства.
.DESCRIPTION
  По умолчанию только читает (tailscale status/debug prefs/serve status) и ничего не меняет.
  Отключение выходного узла — только явной командой:
      scripts\tailscale-check.cmd -DisableExitNode -Yes
  Она выполняет ровно одно действие: «tailscale set --advertise-exit-node=false». Обычный доступ к порталу
  через Tailscale Serve не затрагивается. После этого в панели администратора Tailscale (Machines → сервер →
  Edit route settings) уберите галочку «Use as exit node», если она ещё стоит.
  Удалять устройства из tailnet нужно в панели Tailscale: этот скрипт их только перечисляет.
#>
[CmdletBinding()]
param(
  [switch]$DisableExitNode,
  [switch]$Yes,
  [int]$StaleDays = 30
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$ts = Get-Setting 'TAILSCALE_EXE' 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path -LiteralPath $ts)) { Write-Host "Tailscale не найден: $ts" -ForegroundColor Red; exit 1 }

$status = & $ts status --json | ConvertFrom-Json
$self = $status.Self
Write-Host ''
Write-Host "Этот компьютер в Tailscale: $($self.HostName) (состояние: $($status.BackendState))"

# --- выходной узел ---------------------------------------------------------------------------
$advertisesExit = [bool]($self.AllowedIPs -contains '0.0.0.0/0' -or $self.ExitNodeOption)
Write-Host ''
if ($advertisesExit) {
  Write-Host 'Выходной узел (exit node): ВКЛЮЧЁН — устройства вашей сети могут направлять через этот компьютер весь интернет-трафик.' -ForegroundColor Yellow
  Write-Host '  Для портала, кинотеатра и файлов он не нужен. Если вы им не пользуетесь, отключите:'
  Write-Host '    scripts\tailscale-check.cmd -DisableExitNode -Yes'
} else {
  Write-Host 'Выходной узел (exit node): выключен.' -ForegroundColor Green
}

# --- что опубликовано ------------------------------------------------------------------------
Write-Host ''
Write-Host 'Опубликовано через Tailscale Serve (только внутри вашей сети; Funnel не используется):'
& $ts serve status 2>&1 | ForEach-Object { "  $_" }

# --- устаревшие устройства --------------------------------------------------------------------
Write-Host ''
Write-Host "Устройства, которых не было в сети больше $StaleDays дн. (удалить: панель Tailscale → Machines → «…» → Remove):"
$now = Get-Date
$stale = @()
if ($status.Peer) {
  foreach ($property in $status.Peer.PSObject.Properties) {
    $peer = $property.Value
    if ($peer.Online) { continue }
    $seen = [datetime]::Parse($peer.LastSeen, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    $days = [int]($now - $seen).TotalDays
    if ($days -ge $StaleDays) { $stale += [pscustomobject]@{ Имя = $peer.HostName; ОС = $peer.OS; 'Не было, дней' = $days; 'Был в сети' = $seen.ToString('yyyy-MM-dd') } }
  }
}
if ($stale.Count -eq 0) { Write-Host '  таких нет' } else { $stale | Sort-Object 'Не было, дней' -Descending | Format-Table -AutoSize | Out-String | Write-Host }
Write-Host 'Потерянный или проданный телефон остаётся доверенным, пока его не удалят из списка.'

# --- действие ---------------------------------------------------------------------------------
if ($DisableExitNode) {
  if (-not $advertisesExit) { Write-Host ''; Write-Host 'Выходной узел уже выключен — менять нечего.'; exit 0 }
  if (-not $Yes) { Write-Host ''; Write-Host 'Добавьте -Yes, чтобы подтвердить отключение выходного узла.' -ForegroundColor Yellow; exit 2 }
  Write-Host ''
  Write-Host 'Выключаю выходной узел: tailscale set --advertise-exit-node=false'
  & $ts set --advertise-exit-node=false
  if ($LASTEXITCODE -ne 0) { Write-Host 'Не получилось. Попробуйте в приложении Tailscale: «Run exit node» → выключить.' -ForegroundColor Red; exit 1 }
  Write-Host 'Готово. Откат: tailscale set --advertise-exit-node=true (и одобрение в панели Tailscale).' -ForegroundColor Green
  Write-Host 'Теперь в панели Tailscale (Machines → этот компьютер → Edit route settings) уберите «Use as exit node», если галочка осталась.'
}
