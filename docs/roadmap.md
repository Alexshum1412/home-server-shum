# Дорожная карта

Статусы: **Implemented** · **Partial** · **Not configured** · **Blocked** · **Planned**. Обновлено: 17.10.2026.

> Этапы ниже — исходная дорожная карта (P0–P5). Ход выполнения этапов P1–P10 из ТЗ владельца (`1.txt`) — в [EXECUTION_STATUS.md](EXECUTION_STATUS.md).

## P0 — безопасный фундамент

| Задача | Статус | Подтверждение |
|---|---|---|
| Аудит ПК и папки проекта, резервная копия исходных файлов | Implemented | `docs/environment-audit.md`; `C:\Users\PC\family-server-backups\the-dashboard-original-2026-10-15.zip`; первый git-коммит |
| Стек выбран и описан | Implemented | `docs/decisions/0001-stack.md` |
| Node.js, Git, skills, MCP установлены и проверены | Implemented | `docs/tooling.md`; с 16.10.2026 Node.js и Git — в `C:\FamilyServer\tools` |
| Локальный запуск по инструкции | Implemented | `scripts/start.cmd` → `/api/health` 200; `scripts/stop.cmd` освобождает порт (проверено) |
| Адаптивная главная страница и навигация | Implemented | e2e: 6 ширин без горизонтальной прокрутки |
| Честные состояния «не настроено / нет данных / не отвечает» | Implemented | e2e `honest-status.spec.ts`; unit-тесты сервисов и системы |
| Тесты, lint, типизация, сборка | Implemented | `npm.cmd run check` (результаты — в итоговом отчёте) |
| Нет секретов в Git; безопасные значения по умолчанию; список портов | Implemented | `.gitignore`, `docs/security.md` |

## P1 — единая точка входа и приватный доступ

| Задача | Статус | Комментарий |
|---|---|---|
| PWA: manifest, иконки, service worker | Implemented | установка на домашний экран — только по HTTPS-адресу tailnet |
| Инструкция установки на iOS/Android/Windows | Implemented | страница «Подключение» и README |
| HTTPS через Tailscale Serve | Implemented | включён 16.10.2026: `https://server-home.tail89d77e.ts.net` (tailnet only, без Funnel) → `127.0.0.1:8070`; с этого ПК проверены TLS, `/api/health` 200, заголовки и CSRF-защита за прокси |
| Проверка со второго устройства | Not configured | нужен телефон/ноутбук владельца с включённым Tailscale — см. `docs/runbooks/network.md` |
| LAN-резерв | Not configured | требует правила Firewall (админ) — решение владельца |
| Реальные проверки доступности служб | Implemented | фоновые проверки с таймаутом 3 с |
| Страница диагностики подключения | Implemented | «Подключение» + «Состояние системы» |
| Роли family/admin | Implemented | проверки на сервере, e2e |
| Первый администратор | Implemented (17.10.2026) | `alex`, временный пароль `--generate-password` (смена при первом входе); «Мой профиль» — смена своего пароля |
| Автозапуск и перезапуск после сбоя | Implemented (17.10.2026) | задача «FamilyServer» (S4U: при включении ПК, при входе, сторож 5 мин) → супервизор `server/src/supervisor`; проверено — см. `docs/runbooks/start-stop.md`. Реальная перезагрузка — ручная проверка владельца |

## P2 — медиатека и файлы (следующий этап)

| Задача | Статус |
|---|---|
| Установить Jellyfin (Windows-версия, без Docker), библиотека в `C:\FamilyData\Media`, проверить direct play на телефоне и Samsung QN800B | Planned |
| Подключить Jellyfin в `services.json` (`openUrl`, `healthUrl=/health`) | Planned |
| Выбрать файловый сервис (лёгкий вариант vs Nextcloud) после замера нагрузки | Planned |
| Фото-бэкап с телефонов (Immich требует Docker/WSL2 — отдельное решение) | Planned |
| Загрузка файлов через портал (прогресс, лимиты, защита путей) | Planned |

## P3 — хранение и восстановление

| Задача | Статус |
|---|---|
| Диагностика второго диска `ST_M13FQBL` | Blocked — действие владельца (`docs/runbooks/second-disk.md`) |
| Перенос инструментов и данных из `%LOCALAPPDATA%` в `C:\FamilyServer` (AppData виртуализируется для процессов Claude Desktop) | Implemented — портал перезапущен из Проводника и работает с `C:\FamilyServer\tools\nodejs\node.exe` (ADR-0002) |
| Резервное копирование с версиями | Implemented / Partial — ежедневно 03:30 на `C:\FamilyServer\backups` и флешку «reserve», 14 копий, SHA-256 (ADR-0004). Осталось: зашифрованная копия вне дома; исправный второй диск |
| Шифрование копий | Not configured — копии пока не зашифрованы (решение владельца, вместе с копией вне дома) |
| Тест восстановления | Implemented — `scripts\backup.cmd test-restore` и ручное восстановление с флешки 16.10.2026 прошли |
| Статус бэкапа на дашборде | Implemented — реальный статус по каждому месту из `backup-status.json`; ошибка места → «ошибка» и предупреждение |
| Код на GitHub (только код, без данных) | Implemented — `Alexshum1412/home-server-shum` (публичный) обновляется при каждом копировании (`BACKUP_GIT_PUSH=origin/main`); проверено вручную и из Планировщика 17.10.2026 |

## P4 — дополнительные интеграции

Загрузчик (qBittorrent/Transmission), печать через портал (HP M283fdw — сетевой IPP), аудиокниги/музыка, календарь и заметки — **Planned**, по одному, с тестами и возможностью отключить.

## P5 — «Оливия»

Planned, только после стабильного мониторинга и замеров свободной RAM/CPU. Только интерпретация метрик, действия — через allowlist с подтверждением человека.

## Ближайшая задача

**Первый вход и проверка с телефона:** создать свою учётную запись администратора (`scripts\user.cmd add <логин> --name "<Имя>" --role admin`), включить автозапуск (`scripts\autostart.cmd`, т.к. ПК перезагружается из-за обновлений), открыть `https://server-home.tail89d77e.ts.net` на телефоне с включённым Tailscale → войти → добавить на домашний экран. Ожидаемый результат: портал открывается с телефона по HTTPS без предупреждений, а без Tailscale — не открывается. После этого — этап P2 (Jellyfin).
