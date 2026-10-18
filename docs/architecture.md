# Архитектура

Статусы: **Implemented** — работает и покрыто тестами; **Planned** — следующий этап, кода нет.

## Схема

```text
 Телефон / ноутбук родственника (Tailscale включён)
        │  https://server-home.tail89d77e.ts.net  (только tailnet, сертификат Let's Encrypt)
        ▼
 ┌──────────────────────── домашний ПК (Windows 10) ─────────────────────────┐
 │ tailscaled ── Tailscale Serve :443 ──► 127.0.0.1:8070                    │
 │                                          │                               │
 │                     node.exe server/src/index.ts  (Fastify, без админ-прав)│
 │                       ├─ /api/*  JSON API (сессии, роли, CSRF, заголовки) │
 │                       ├─ /*      собранный интерфейс dist/web (PWA)      │
 │                       ├─ проверки сервисов ──► Jellyfin/Immich/… (Planned)│
 │                       └─ системные пробы (read-only, allowlist):         │
 │                            os.*, fs.statfs, powershell Get-PhysicalDisk,  │
 │                            Win32_Printer, tailscale status --json        │
 │  Данные: C:\FamilyServer\data\dashboard (users, sessions, services, audit)│
 │                                                                           │
 │  Планировщик «FamilyServerBackup» 03:30 ─► scripts\backup.cmd run         │
 │     node server/src/cli/backup.ts ─► C:\FamilyServer\backups              │
 │                                   └► флешка «reserve»:\FamilyServerBackups│
 │     итог ─► data\dashboard\backup-status.json ─► дашборд                  │
 └───────────────────────────────────────────────────────────────────────────┘
```

Корень сервера — `C:\FamilyServer`: `tools\nodejs` (Node.js 24, npm, openspec), `tools\git` (Git), `data\dashboard` (данные портала), `backups\` (копии на основном диске). Не `%LOCALAPPDATA%`: процессы, запущенные из приложения Claude Desktop (пакет MSIX), пишут в AppData виртуализированно, и такие файлы не видны Проводнику и Планировщику — см. [ADR-0002](decisions/0002-data-storage.md).

## Компоненты

| Компонент | Где | Статус |
|---|---|---|
| Контракт API (типы) | `shared/api.ts` | Implemented |
| HTTP-сервер, заголовки безопасности, лимиты, JSON 404, SPA-fallback | `server/src/app.ts`, `server/src/static.ts` | Implemented |
| Конфигурация из env/`.env` (zod) | `server/src/config.ts` | Implemented |
| Пользователи (scrypt), сессии (хэш токена, 30 дней), лимит попыток, роли, проверка Origin | `server/src/auth/` | Implemented |
| Журнал аудита (JSONL, ротация 5 МБ × 3) | `server/src/audit/log.ts` | Implemented |
| Реестр сервисов (`services.json`) и фоновые проверки с таймаутом | `server/src/services/` | Implemented |
| Системные показатели, диски, принтер, Tailscale, бэкап, предупреждения | `server/src/system/` | Implemented |
| Администрирование (аудит, пользователи, диагностика) | `server/src/admin/routes.ts` | Implemented |
| CLI пользователей | `server/src/cli/users.ts`, `scripts/user.cmd` | Implemented |
| Резервное копирование: места хранения (путь или метка тома), снимок с `manifest.json` и SHA-256, `git bundle`, хранение 14 копий, восстановление в пустую папку, пробное восстановление, `backup-status.json` | `server/src/backup/`, `server/src/cli/backup.ts`, `scripts/backup.cmd` | Implemented |
| Ежедневная задача копирования | `scripts/backup-schedule.ps1` + `.cmd` (задача «FamilyServerBackup», 03:30) | Implemented (включена 16.10.2026) |
| Интерфейс (Preact): оболочка, роутер, страницы, состояния | `web/src/` | Implemented |
| Дизайн-токены (тёмная/светлая тема) | `web/src/styles/tokens.css` | Implemented |
| PWA: manifest, иконки, service worker (только оболочка) | `web/public/` | Implemented |
| Скрипты эксплуатации Windows | `scripts/*.ps1` + `.cmd` | Implemented |
| Tailscale Serve (HTTPS в tailnet) | `scripts/serve-tailnet.ps1` | Implemented (скрипт); включение — см. `roadmap.md` |
| LAN-резерв | `docs/runbooks/network.md` | Not configured (нужно решение владельца) |
| Jellyfin, файловый сервис, Immich, загрузчик | — | Planned |
| Копия вне дома (зашифрованная) | `docs/runbooks/backup-restore.md` | Planned (решение владельца) |
| «Оливия» | — | Planned (P5) |

## API

| Метод и путь | Доступ | Назначение |
|---|---|---|
| `GET /api/health` | все | `{status, version, time}` |
| `GET /api/setup-state` | все | есть ли пользователи; команда создания администратора |
| `POST /api/login`, `POST /api/logout`, `GET /api/session` | все / вошедшие | вход, выход, текущая сессия |
| `GET /api/connection` | вошедшие | адреса для страницы «Подключение» |
| `GET /api/services` | вошедшие | состояния сервисов (кэш фоновых проверок) |
| `POST /api/services/refresh` | admin, не чаще 1 раза в 10 с | проверить сервисы сейчас |
| `GET /api/system` | вошедшие (технические поля — только admin) | показатели, диски, Tailscale, принтер, бэкап, предупреждения |
| `GET /api/admin/audit?limit=N` | admin | журнал (новые сверху, до 500) |
| `GET /api/admin/users` | admin | пользователи без хэшей |
| `GET /api/admin/diagnostics` | admin | JSON-отчёт без секретов (файл) |

Все ответы описаны типами в `shared/api.ts`. Ошибки: `{error, message}`, где `message` — по-русски.

## Потоки данных и частота опроса

| Источник | Как | Период | Таймаут |
|---|---|---|---|
| CPU | дельты `os.cpus()` | 5 с | — |
| RAM, uptime | `os.*` | 5 с (вместе с CPU) | — |
| Тома | `fs.statfs` | 60 с | — |
| Tailscale | `tailscale.exe status --json` (фиксированные аргументы) | 60 с | 5 с |
| Физические диски, принтер | `powershell.exe -EncodedCommand <фиксированный скрипт>` | 5 мин | 15 с |
| Сервисы | `fetch(healthUrl)` без перехода на чужие хосты | 60 с | 3 с |
| Статус резервного копирования | чтение `backup-status.json` из каталога данных | 60 с | — |
| Задача копирования (только во время запуска `scripts\backup.cmd`) | `Get-Volume` (фиксированный скрипт `volumes` — поиск флешки по метке), `tailscale serve status --json`, `git bundle create/verify` (без shell) | раз в сутки | 15 с / 10 с / 5 мин |
| Интерфейс | `/api/system` 30 с, `/api/services` 60 с, только видимая вкладка | — | 10 с |

Запросы клиентов читают кэш и не запускают пробы — опрос из браузера не увеличивает нагрузку на систему.

## Сборка и запуск

- Сервер: Node 24 исполняет `.ts` напрямую (type stripping), отдельной сборки нет; `tsc --noEmit` проверяет типы.
- Интерфейс: `vite build` → `dist/web` (шрифт Onest и иконки упакованы локально; внешних запросов нет).
- Фоновый запуск: `scripts/start.ps1` (скрытый процесс, PID-файл, ожидание health), остановка — `scripts/stop.ps1` по PID/порту.

## Тесты

- `server/test/*.test.ts` — Vitest: unit и интеграционные через `app.inject()` (без сети, на временных каталогах данных, с подменой проб и часов); `backup.test.ts` и `backup-cli.test.ts` — копирование, проверка, хранение, восстановление и CLI на временных папках.
- `web/src/**/*.test.ts` — Vitest: форматирование, подписи, приветствие, маршруты.
- `tests/e2e/*.spec.ts` — Playwright в установленном Chrome: вход, роли, честные состояния, демо-режим, 6 ширин экрана без горизонтальной прокрутки, axe (WCAG 2.1 AA), заголовки безопасности, PWA, отсутствие внешних запросов. Два изолированных сервера (8071 — обычный режим, 8072 — демо) с временными данными.


## Модули, добавленные 18.10.2026

| Модуль | Что делает | Где описано |
|---|---|---|
| `server/src/realtime/hub.ts` | поток событий сервер → страница (SSE) с пульсом | ADR-0012 |
| `server/src/chat/*`, `server/src/calls/*` | чат с проверкой участия; звонки (сигналы WebRTC) | ADR-0012, runbooks/chat-and-calls.md |
| `server/src/notify/*` | центр уведомлений и Web Push на `node:crypto` | ADR-0012 |
| `server/src/jellyfin/*` | каталог кинотеатра через ключ API на сервере, место остановки у каждого своё | ADR-0005 |
| `server/src/downloads/{bencode,magnet,aria2,torrents}.ts` | разбор `.torrent` и магнита, клиент aria2 (loopback RPC), очередь торрентов | ADR-0014 |
| `server/src/olivia/assistant/*` | инструменты «Оливии» для семьи, выбор инструмента моделью | ADR-0011 |
| `server/src/lib/channel.ts` | какой дорогой пришёл запрос (частная или публичная) и список разрешённых маршрутов публичной | ADR-0013 |
| `server/src/system/{hardware,history,alert-watcher}.ts` | показания оборудования, история за сутки, оповещения администраторам | EXECUTION_STATUS.md |
| `server/src/supervisor/apps.ts` | программы супервизора: портал, Jellyfin, aria2, llama (последние две — только когда установлены и включены) | runbooks/torrents.md, runbooks/local-ai.md |
| `scripts/install-component.ps1`, `scripts/components.json` | установка сторонних программ с проверкой размера и SHA-256, только с согласия владельца | ADR-0011, ADR-0014 |
| `tests/guide/*`, `playwright.guide.config.ts` | снимки для руководства семьи | FAMILY_USER_GUIDE.md |

Общий принцип: каждый запрос проходит проверку адреса (`Host`), источника (`Origin`), канала (частный/публичный) и входа; новые маршруты по умолчанию закрыты на публичном канале, пока их не внесут в список.
