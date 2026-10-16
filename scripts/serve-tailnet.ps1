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

function Get-ServeHandlers {
  # Every Serve web handler on HTTPS port 443 of this node: site, mount path and proxy target.
  $raw = (& $ts serve status --json | Out-String).Trim()
  $list = @()
  if (-not $raw -or $raw -eq '{}') { return $list }
  $serve = $raw | ConvertFrom-Json
  if ($serve.AllowFunnel) {
    Write-Host 'Внимание: в текущей настройке есть Funnel (публичный доступ). Скрипт его не трогает — проверьте вручную: tailscale funnel status' -ForegroundColor Yellow
  }
  if ($serve.Web) {
    foreach ($site in $serve.Web.PSObject.Properties) {
      if ($site.Name -notlike '*:443') { continue }
      foreach ($h in $site.Value.Handlers.PSObject.Properties) {
        $list += [pscustomobject]@{ Site = $site.Name; Path = $h.Name; Proxy = [string]$h.Value.Proxy }
      }
    }
  }
  return $list
}

$handlers = @(Get-ServeHandlers)
$ours = @($handlers | Where-Object { $_.Path -eq '/' -and $_.Proxy -eq $target })
$foreign = @($handlers | Where-Object { -not ($_.Path -eq '/' -and $_.Proxy -eq $target) })

if ($Off) {
  if ($ours.Count -eq 0) {
    if ($foreign.Count -gt 0) {
      Write-Host 'Адрес дашборда в Tailscale Serve не настроен; есть другие настройки — их не трогаю:' -ForegroundColor Yellow
      $foreign | ForEach-Object { Write-Host "  $($_.Site)$($_.Path) -> $($_.Proxy)" }
    } else {
      Write-Host 'Частный HTTPS-адрес дашборда и так выключен.'
    }
    exit 0
  }
  # Remove only the dashboard mount ('/'), never other handlers on the same port.
  & $ts serve --https=443 --set-path / off
  if ($LASTEXITCODE -ne 0) { Write-Host 'Не удалось выключить Tailscale Serve.' -ForegroundColor Red; exit 1 }
  Write-Host 'Частный HTTPS-адрес дашборда выключен.' -ForegroundColor Green
  & $ts serve status
  exit 0
}

$statusJson = (& $ts status --json | Out-String) | ConvertFrom-Json
if ($statusJson.BackendState -ne 'Running') {
  Write-Host "Tailscale не подключён (состояние: $($statusJson.BackendState)). Откройте приложение Tailscale и войдите." -ForegroundColor Red
  exit 1
}
$dns = ([string]$statusJson.Self.DNSName).TrimEnd('.')

if ($foreign.Count -gt 0) {
  Write-Host 'Для порта 443 в Tailscale Serve уже есть другая настройка — ничего не меняю:' -ForegroundColor Yellow
  $foreign | ForEach-Object { Write-Host "  $($_.Site)$($_.Path) -> $($_.Proxy)" }
  exit 1
}
if ($ours.Count -gt 0) {
  Write-Host "Частный HTTPS-адрес уже включён: https://$dns" -ForegroundColor Green
  exit 0
}

if (-not (Test-DashboardHealth $cfg.Port)) {
  Write-Host "Дашборд сейчас не отвечает на $target. Serve будет настроен, но заработает после scripts\start.cmd." -ForegroundColor Yellow
}

& $ts serve --bg --https=443 $target
if ($LASTEXITCODE -ne 0) { Write-Host 'Не удалось включить Tailscale Serve.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host "Готово. Адрес для семьи (только в tailnet): https://$dns" -ForegroundColor Green
& $ts serve status
