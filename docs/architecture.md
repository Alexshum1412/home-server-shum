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
 │  Данные: %LOCALAPPDATA%\FamilyDashboard (users, sessions, services, audit)│
 └───────────────────────────────────────────────────────────────────────────┘
```

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
| Интерфейс (Preact): оболочка, роутер, страницы, состояния | `web/src/` | Implemented |
| Дизайн-токены (тёмная/светлая тема) | `web/src/styles/tokens.css` | Implemented |
| PWA: manifest, иконки, service worker (только оболочка) | `web/public/` | Implemented |
| Скрипты эксплуатации Windows | `scripts/*.ps1` + `.cmd` | Implemented |
| Tailscale Serve (HTTPS в tailnet) | `scripts/serve-tailnet.ps1` | Implemented (скрипт); включение — см. `roadmap.md` |
| LAN-резерв | `docs/runbooks/network.md` | Not configured (нужно решение владельца) |
| Jellyfin, файловый сервис, Immich, загрузчик | — | Planned |
| Резервное копирование | `docs/runbooks/backup-restore.md` | Blocked (нет второго носителя) |
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
| RAM, uptime | `os.*` | при запросе | — |
| Тома | `fs.statfs` | 60 с | — |
| Tailscale | `tailscale.exe status --json` (фиксированные аргументы) | 60 с | 5 с |
| Физические диски, принтер | `powershell.exe -EncodedCommand <фиксированный скрипт>` | 5 мин | 15 с |
| Сервисы | `fetch(healthUrl)` без перехода на чужие хосты | 60 с | 3 с |
| Интерфейс | `/api/system` 30 с, `/api/services` 60 с, только видимая вкладка | — | 10 с |

Запросы клиентов читают кэш и не запускают пробы — опрос из браузера не увеличивает нагрузку на систему.

## Сборка и запуск

- Сервер: Node 24 исполняет `.ts` напрямую (type stripping), отдельной сборки нет; `tsc --noEmit` проверяет типы.
- Интерфейс: `vite build` → `dist/web` (шрифт Onest и иконки упакованы локально; внешних запросов нет).
- Фоновый запуск: `scripts/start.ps1` (скрытый процесс, PID-файл, ожидание health), остановка — `scripts/stop.ps1` по PID/порту.

## Тесты

- `server/test/*.test.ts` — Vitest: unit и интеграционные через `app.inject()` (без сети, на временных каталогах данных, с подменой проб и часов).
- `web/src/**/*.test.ts` — Vitest: форматирование, подписи, приветствие, маршруты.
- `tests/e2e/*.spec.ts` — Playwright в установленном Chrome: вход, роли, честные состояния, демо-режим, 6 ширин экрана без горизонтальной прокрутки, axe (WCAG 2.1 AA), заголовки безопасности, PWA, отсутствие внешних запросов. Два изолированных сервера (8071 — обычный режим, 8072 — демо) с временными данными.
