<#
.SYNOPSIS
  Включает или выключает частный HTTPS-адрес дашборда внутри tailnet (Tailscale Serve).
.DESCRIPTION
  Включение:  scripts\serve-tailnet.cmd            (портал: https://<узел>.ts.net)
              scripts\serve-tailnet.cmd -Jellyfin  (Jellyfin: https://<узел>.ts.net:8443)
  Выключение: те же команды с -Off

  Делает ровно одно: tailscale serve --bg --https=443 http://127.0.0.1:<PORT>
  (с -Jellyfin: --https=8443 http://127.0.0.1:8096).
  Это доступ ТОЛЬКО для устройств вашего tailnet. Funnel (публичный доступ) НЕ включается,
  порты роутера и Windows Firewall не меняются. Права администратора не нужны.
  Если для этого HTTPS-порта уже есть другая настройка Serve, скрипт ничего не меняет.
#>
[CmdletBinding()]
param([switch]$Off, [switch]$Jellyfin)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$cfg = Get-DashboardConfig
$ts = $cfg.TailscaleExe

if (-not (Test-Path -LiteralPath $ts)) {
  Write-Host "Tailscale CLI не найден: $ts" -ForegroundColor Red
  exit 1
}

if ($Jellyfin) {
  $httpsPort = 8443
  $target = 'http://127.0.0.1:8096'
  $what = 'Jellyfin'
} else {
  $httpsPort = 443
  $target = "http://127.0.0.1:$($cfg.Port)"
  $what = 'дашборда'
}

function Get-ServeHandlers {
  # Every Serve web handler on the chosen HTTPS port of this node: site, mount path and proxy target.
  $raw = (& $ts serve status --json | Out-String).Trim()
  $list = @()
  if (-not $raw -or $raw -eq '{}') { return $list }
  $serve = $raw | ConvertFrom-Json
  if ($serve.AllowFunnel) {
    Write-Host 'Внимание: в текущей настройке есть Funnel (публичный доступ). Скрипт его не трогает — проверьте вручную: tailscale funnel status' -ForegroundColor Yellow
  }
  if ($serve.Web) {
    foreach ($site in $serve.Web.PSObject.Properties) {
      if ($site.Name -notlike "*:$httpsPort") { continue }
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
      Write-Host "Адрес $what в Tailscale Serve не настроен; есть другие настройки — их не трогаю:" -ForegroundColor Yellow
      $foreign | ForEach-Object { Write-Host "  $($_.Site)$($_.Path) -> $($_.Proxy)" }
    } else {
      Write-Host "Частный HTTPS-адрес $what и так выключен."
    }
    exit 0
  }
  # Remove only our mount ('/') on this port, never other handlers.
  & $ts serve "--https=$httpsPort" --set-path / off
  if ($LASTEXITCODE -ne 0) { Write-Host 'Не удалось выключить Tailscale Serve.' -ForegroundColor Red; exit 1 }
  Write-Host "Частный HTTPS-адрес $what выключен." -ForegroundColor Green
  & $ts serve status
  exit 0
}

$statusJson = (& $ts status --json | Out-String) | ConvertFrom-Json
if ($statusJson.BackendState -ne 'Running') {
  Write-Host "Tailscale не подключён (состояние: $($statusJson.BackendState)). Откройте приложение Tailscale и войдите." -ForegroundColor Red
  exit 1
}
$dns = ([string]$statusJson.Self.DNSName).TrimEnd('.')

$url = if ($httpsPort -eq 443) { "https://$dns" } else { "https://${dns}:$httpsPort" }
if ($foreign.Count -gt 0) {
  Write-Host "Для порта $httpsPort в Tailscale Serve уже есть другая настройка — ничего не меняю:" -ForegroundColor Yellow
  $foreign | ForEach-Object { Write-Host "  $($_.Site)$($_.Path) -> $($_.Proxy)" }
  exit 1
}
if ($ours.Count -gt 0) {
  Write-Host "Частный HTTPS-адрес $what уже включён: $url" -ForegroundColor Green
  exit 0
}

if (-not $Jellyfin -and -not (Test-DashboardHealth $cfg.Port)) {
  Write-Host "Дашборд сейчас не отвечает на $target. Serve будет настроен, но заработает после scripts\start.cmd." -ForegroundColor Yellow
}

& $ts serve --bg "--https=$httpsPort" $target
if ($LASTEXITCODE -ne 0) { Write-Host 'Не удалось включить Tailscale Serve.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host "Готово. Адрес $what для семьи (только в tailnet): $url" -ForegroundColor Green
& $ts serve status
