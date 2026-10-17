<#
.SYNOPSIS
  Запасной адрес портала в домашней сети (на случай, когда дома нет интернета и не работает Tailscale).
.DESCRIPTION
  scripts\lan-mode.cmd status   - показать, включён ли запасной адрес (ничего не меняет)
  scripts\lan-mode.cmd on       - включить: правило брандмауэра + LAN_BIND/LAN_URL в .env + перезапуск портала
  scripts\lan-mode.cmd off      - выключить: убрать правило и строки из .env + перезапуск портала
  Параметры: -Address 192.168.1.252 (если адресов несколько), -Yes (не спрашивать подтверждение)

  Что делает «on», по шагам (и больше ничего):
    1. Создаёт ОДНО правило входящих подключений Windows Firewall «Family Dashboard (LAN, <порт>)»:
       только профиль «Частная сеть», только локальная подсеть, только этот адрес и порт, только node.exe проекта.
    2. Записывает в .env две строки: LAN_BIND=<адрес> и LAN_URL=http://<адрес>:<порт>.
    3. Перезапускает портал (супервизор), чтобы он начал слушать и этот адрес.
  Портал при этом по-прежнему НЕ слушает все интерфейсы (0.0.0.0), Funnel и порты роутера не затрагиваются.

  Меняет настройки безопасности Windows, поэтому его запускает ВЛАДЕЛЕЦ сам (агент разработки его не запускает).
  Ограничения: обычный HTTP без шифрования, портал виден всем устройствам домашней сети (вход по паролю обязателен).
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('status', 'on', 'off')][string]$Action = 'status',
  [string]$Address,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$cfg = Get-DashboardConfig
$envFile = Join-Path $script:RepoRoot '.env'
$ruleName = "Family Dashboard (LAN, $($cfg.Port))"
$nodeExe = Get-NodeExe

function Test-PrivateLanAddress([string]$ip) {
  return $ip -match '^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$'
}

function Get-LanCandidates {
  # Адреса сетевых карт дома: без Tailscale, VPN и виртуальных адаптеров.
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      (Test-PrivateLanAddress $_.IPAddress) -and
      $_.InterfaceAlias -notmatch 'Loopback|Tailscale|vEthernet|VPN|Xray|Tunnel|Virtual|VMware|Hyper-V|WSL'
    } | Select-Object -ExpandProperty IPAddress
}

function Get-EnvValue([string]$name) {
  $e = Get-DotEnv
  if ($e.ContainsKey($name)) { return $e[$name] }
  return ''
}

function Set-EnvLines([hashtable]$set, [string[]]$remove) {
  # .env должен остаться UTF-8 без BOM (так его читает Node).
  $lines = @()
  if (Test-Path -LiteralPath $envFile) {
    $text = (New-Object Text.UTF8Encoding($false)).GetString([IO.File]::ReadAllBytes($envFile))
    $lines = @($text -split "`r?`n")
  }
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    $key = ($line -split '=', 2)[0].Trim()
    if ($set.ContainsKey($key) -or $remove -contains $key) { continue }
    if ($line -ne '' -or $out.Count -gt 0) { $out.Add($line) }
  }
  while ($out.Count -gt 0 -and $out[$out.Count - 1] -eq '') { $out.RemoveAt($out.Count - 1) }
  foreach ($k in $set.Keys) { $out.Add("$k=$($set[$k])") }
  [IO.File]::WriteAllText($envFile, (($out -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
}

function Test-PortReachable([string]$ip, [int]$port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($ip, $port)
    return ($task.Wait(1500) -and $client.Connected)
  } catch { return $false } finally { $client.Dispose() }
}

function Restart-Portal {
  $node = Get-NodeExe
  if (-not $node) { Write-Host 'Node.js не найден: перезапустите портал вручную (scripts\stop.cmd, затем scripts\start.cmd).' -ForegroundColor Yellow; return }
  Push-Location $script:RepoRoot
  try {
    & $node --env-file-if-exists=.env server\src\supervisor\main.ts restart dashboard
  } finally { Pop-Location }
}

$bind = Get-EnvValue 'LAN_BIND'
$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($Action -eq 'status') {
  Write-Host '=== Запасной адрес портала в домашней сети ===' -ForegroundColor Cyan
  Write-Host ("LAN_BIND в .env:      " + $(if ($bind) { $bind } else { 'не задан (запасной адрес выключен)' }))
  Write-Host ("LAN_URL в .env:       " + $(if (Get-EnvValue 'LAN_URL') { Get-EnvValue 'LAN_URL' } else { 'не задан' }))
  Write-Host ("Правило брандмауэра:  " + $(if ($rule) { "есть («$ruleName», включено: $($rule.Enabled))" } else { 'нет' }))
  $profiles = Get-NetFirewallProfile | ForEach-Object { "$($_.Name)=$($_.Enabled)" }
  Write-Host ("Брандмауэр Windows:   " + ($profiles -join ', '))
  $found = @(Get-LanCandidates)
  Write-Host ("Адреса этого ПК дома: " + $(if ($found.Count) { $found -join ', ' } else { 'не найдены' }))
  if ($bind) {
    foreach ($ip in ($bind -split '[,; ]+' | Where-Object { $_ })) {
      $ok = Test-PortReachable $ip $cfg.Port
      Write-Host ("Портал на {0}:{1}: {2}" -f $ip, $cfg.Port, $(if ($ok) { 'отвечает (проверено с этого же ПК; с телефона нужно проверить отдельно)' } else { 'НЕ отвечает' }))
    }
  }
  if ($bind -and -not $rule) {
    Write-Host 'Адрес включён в настройках, но правила брандмауэра нет: с других устройств он не откроется.' -ForegroundColor Yellow
  }
  exit 0
}

# --- on / off меняют настройки Windows: нужны права администратора --------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Нужны права администратора: запустите PowerShell «от имени администратора» и повторите команду.' -ForegroundColor Red
  exit 1
}

if ($Action -eq 'on') {
  if (-not $nodeExe) { Write-Host 'Node.js не найден.' -ForegroundColor Red; exit 1 }
  if (-not $Address) {
    $found = @(Get-LanCandidates)
    if ($found.Count -eq 1) { $Address = $found[0] }
    elseif ($found.Count -eq 0) { Write-Host 'Адрес этого ПК в домашней сети не найден. Укажите его: -Address 192.168.1.252' -ForegroundColor Red; exit 1 }
    else { Write-Host ('Найдено несколько адресов: ' + ($found -join ', ') + '. Выберите нужный: -Address <адрес>') -ForegroundColor Yellow; exit 1 }
  }
  if (-not (Test-PrivateLanAddress $Address)) {
    Write-Host "«$Address» не похож на адрес домашней сети (192.168.x.x, 10.x.x.x, 172.16-31.x.x)." -ForegroundColor Red
    exit 1
  }
  Write-Host 'Будет сделано:' -ForegroundColor Cyan
  Write-Host "  1. Правило брандмауэра «$ruleName»: вход TCP $($cfg.Port) на $Address, только «Частная сеть», только локальная подсеть, только $nodeExe"
  Write-Host "  2. В .env: LAN_BIND=$Address и LAN_URL=http://${Address}:$($cfg.Port)"
  Write-Host '  3. Перезапуск портала.'
  Write-Host 'Адрес будет работать по HTTP (без шифрования), доступен всем устройствам домашней сети; вход по паролю обязателен.' -ForegroundColor Yellow
  Write-Host 'Совет: закрепите этот IP за ПК в настройках роутера, иначе после смены адреса запасной путь перестанет работать.'
  if (-not $Yes) {
    $answer = Read-Host 'Продолжить? Введите ДА'
    if ($answer -ne 'ДА') { Write-Host 'Отменено, ничего не изменено.'; exit 0 }
  }
  if ($rule) { Remove-NetFirewallRule -DisplayName $ruleName }
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $cfg.Port `
    -LocalAddress $Address -Profile Private -RemoteAddress LocalSubnet -Program $nodeExe | Out-Null
  Set-EnvLines @{ LAN_BIND = $Address; LAN_URL = "http://${Address}:$($cfg.Port)" } @()
  Restart-Portal
  Write-Host "Готово. С телефона в домашнем Wi-Fi откройте http://${Address}:$($cfg.Port)" -ForegroundColor Green
  Write-Host 'Проверьте с телефона (при выключенном Tailscale). Выключить: scripts\lan-mode.cmd off'
  exit 0
}

if ($Action -eq 'off') {
  if ($rule) { Remove-NetFirewallRule -DisplayName $ruleName; Write-Host 'Правило брандмауэра удалено.' }
  Set-EnvLines @{} @('LAN_BIND', 'LAN_URL')
  Restart-Portal
  Write-Host 'Запасной адрес выключен: портал снова слушает только 127.0.0.1.' -ForegroundColor Green
  exit 0
}
