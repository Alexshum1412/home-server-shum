<#
.SYNOPSIS
  Включает или выключает частный HTTPS-адрес дашборда внутри tailnet (Tailscale Serve).
.DESCRIPTION
  Включение:  scripts\serve-tailnet.cmd
  Выключение: scripts\serve-tailnet.cmd -Off

  Делает ровно одно: tailscale serve --bg --https=443 http://127.0.0.1:<PORT>
  Это доступ ТОЛЬКО для устройств вашего tailnet. Funnel (публичный доступ) НЕ включается,
  порты роутера и Windows Firewall не меняются. Права администратора не нужны.
  Если для порта 443 уже есть другая настройка Serve, скрипт ничего не меняет.
#>
[CmdletBinding()]
param([switch]$Off)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$cfg = Get-DashboardConfig
$ts = $cfg.TailscaleExe

if (-not (Test-Path -LiteralPath $ts)) {
  Write-Host "Tailscale CLI не найден: $ts" -ForegroundColor Red
  exit 1
}

$target = "http://127.0.0.1:$($cfg.Port)"

if ($Off) {
  & $ts serve --yes --https=443 off
  if ($LASTEXITCODE -ne 0) { Write-Host 'Не удалось выключить Tailscale Serve.' -ForegroundColor Red; exit 1 }
  Write-Host 'Частный HTTPS-адрес выключен.' -ForegroundColor Green
  & $ts serve status
  exit 0
}

$statusJson = (& $ts status --json | Out-String) | ConvertFrom-Json
if ($statusJson.BackendState -ne 'Running') {
  Write-Host "Tailscale не подключён (состояние: $($statusJson.BackendState)). Откройте приложение Tailscale и войдите." -ForegroundColor Red
  exit 1
}

$serveRaw = (& $ts serve status --json | Out-String).Trim()
if ($serveRaw -and $serveRaw -ne '{}') {
  $serve = $serveRaw | ConvertFrom-Json
  $existing = @()
  if ($serve.Web) {
    foreach ($site in $serve.Web.PSObject.Properties) {
      foreach ($h in $site.Value.Handlers.PSObject.Properties) { $existing += "$($site.Name)$($h.Name) -> $($h.Value.Proxy)" }
    }
  }
  if ($existing.Count -gt 0 -and -not ($existing | Where-Object { $_ -like "*-> $target" })) {
    Write-Host 'Для Tailscale Serve уже есть другая настройка — ничего не меняю:' -ForegroundColor Yellow
    $existing | ForEach-Object { Write-Host "  $_" }
    exit 1
  }
  if ($serve.AllowFunnel) {
    Write-Host 'Внимание: в текущей настройке есть Funnel (публичный доступ). Скрипт его не трогает — проверьте вручную: tailscale funnel status' -ForegroundColor Yellow
  }
}

if (-not (Test-DashboardHealth $cfg.Port)) {
  Write-Host "Дашборд сейчас не отвечает на $target. Serve будет настроен, но заработает после scripts\start.cmd." -ForegroundColor Yellow
}

& $ts serve --bg --https=443 $target
if ($LASTEXITCODE -ne 0) { Write-Host 'Не удалось включить Tailscale Serve.' -ForegroundColor Red; exit 1 }

$dns = ([string]$statusJson.Self.DNSName).TrimEnd('.')
Write-Host ''
Write-Host "Готово. Адрес для семьи (только в tailnet): https://$dns" -ForegroundColor Green
& $ts serve status
