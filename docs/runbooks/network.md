# Ранбук: сетевой доступ

## Адреса

| Где | Адрес | Условия |
|---|---|---|
| На самом сервере | `http://127.0.0.1:8070` | дашборд запущен |
| Любое устройство в tailnet (дома и за границей) | `https://server-home.tail89d77e.ts.net` | на устройстве включён Tailscale, ПК включён, в Windows выполнен вход, дома есть интернет |
| Домашняя сеть без Tailscale | не настроено | см. «LAN-резерв» ниже |

## Включить / выключить частный HTTPS (Tailscale Serve)

```bat
scripts\serve-tailnet.cmd
```
```bat
scripts\serve-tailnet.cmd -Off
```

Скрипт выполняет `tailscale serve --bg --https=443 http://127.0.0.1:8070`, а при `-Off` — `tailscale serve --https=443 off`. Он отказывается что-либо менять, если для порта 443 уже есть другая настройка. Funnel не включается. Проверка:

```bat
"C:\Program Files\Tailscale\tailscale.exe" serve status
```

Ожидается `https://server-home.tail89d77e.ts.net (tailnet only)` и `|-- / proxy http://127.0.0.1:8070`.

## Проверка с другого устройства

1. На телефоне включить Tailscale (тот же аккаунт/tailnet).
2. Открыть `https://server-home.tail89d77e.ts.net` — должна открыться страница входа без предупреждений о сертификате.
3. Выключить Tailscale на телефоне — адрес не должен открываться (доступа из интернета нет).

## После перезагрузки ПК

Tailscale на Windows по умолчанию подключается только после входа пользователя в Windows. Варианты (решение владельца):
- входить в Windows после перезагрузки (проще всего);
- включить в Tailscale «Run unattended» (меню в трее → Preferences) — тогда Tailscale работает без входа, но управлять им сможет только включивший пользователь.

Сам дашборд стартует при входе, если включён автозапуск: `scripts\autostart.cmd` (выключить: `scripts\autostart.cmd -Off`).

## LAN-резерв (не включён)

Нужен, только если дома пропал интернет, а портал нужен с телефона в той же Wi-Fi сети. Требует изменения настроек безопасности Windows, поэтому выполняется **владельцем вручную** в PowerShell **от имени администратора**:

```powershell
New-NetFirewallRule -DisplayName 'Family Dashboard (LAN, 8070)' -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 8070 -Profile Private -RemoteAddress LocalSubnet `
  -Program "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
```

Затем в `.env` проекта: `HOST=0.0.0.0` и `LAN_URL=http://192.168.1.252:8070` (лучше закрепить этот IP за ПК в настройках роутера), перезапуск `scripts\stop.cmd` → `scripts\start.cmd`. Ограничения: обычный HTTP (без установки PWA), портал виден всем устройствам домашней сети (вход по паролю всё равно обязателен). Откат:

```powershell
Remove-NetFirewallRule -DisplayName 'Family Dashboard (LAN, 8070)'
```
и вернуть `HOST=127.0.0.1`.

## Что работает без интернета

- Дома: локальный адрес на самом ПК; LAN-резерв, если включён. Сервисы, которым не нужен интернет (Jellyfin в будущем), продолжают работать.
- Из-за границы: ничего — без домашнего интернета Tailscale не может достучаться до ПК.
- Установленная PWA откроет только «оболочку» и покажет «Нет связи с домашним сервером».
