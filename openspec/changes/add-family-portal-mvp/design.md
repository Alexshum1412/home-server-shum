# Design

## Context

Чистая Windows 10 Home 22H2, без Docker/WSL2, один рабочий диск 2 ТБ, Tailscale 1.104.1 работает (`server-home.tail89d77e.ts.net`, HTTPS-сертификаты в tailnet разрешены). Стек выбран в `docs/decisions/0001-stack.md`: Node.js 24 LTS + TypeScript, Fastify, Preact + Vite. Контракт API — `shared/api.ts` (единственный источник типов для сервера и клиента).

## Goals / Non-Goals

**Goals:**
- Один процесс Node.js, отдающий и API, и собранный фронтенд; запуск без прав администратора.
- Все проверки — с таймаутами и кэшем; клиентский опрос не умножает нагрузку на систему.
- Тестируемость: все внешние зависимости (часы, файловая система данных, системные пробы, сеть) внедряются и подменяются в тестах.

**Non-Goals:**
- Установка Jellyfin/Immich/файлового сервиса, реальный бэкап, печать из портала, «Оливия» — следующие этапы.
- SSO, OAuth, управление пользователями из браузера, перезапуск служб из UI.

## Decisions

### D1. Структура кода
```
shared/api.ts                 типы контракта API (только `import type` с сервера)
server/src/index.ts           точка входа: конфиг → buildApp → listen; SIGINT/SIGTERM/SIGBREAK → close
server/src/app.ts             buildApp(deps) — Fastify, хуки безопасности, регистрация маршрутов
server/src/config.ts          env → типизированный Config (zod), значения по умолчанию
server/src/lib/               json-store (атомарная запись temp+rename), time, ids
server/src/auth/              passwords (scrypt), users store, sessions store, rate-limit, guards, routes
server/src/audit/             JSONL-журнал с ротацией и чтением последних N записей
server/src/services/          config (zod), checker (fetch + AbortSignal.timeout), routes
server/src/system/            cpu sampler, volumes (fs.statfs), powershell probe runner, disks, printer,
                              tailscale, backup, alerts, collector (кэш + расписание), routes
server/src/admin/routes.ts    audit, users (read-only), diagnostics
server/src/static.ts          dist/web + SPA fallback + страница «интерфейс не собран»
server/src/cli/users.ts       add | list | passwd | remove (ввод пароля без эха)
server/test/*.test.ts         Vitest: unit + интеграция через app.inject()
web/                          Vite root: index.html, public/ (manifest, иконки, sw.js), src/
tests/e2e/                    Playwright (Chrome, channel 'chrome'), axe-core
scripts/                      start/stop/status/serve PowerShell + .cmd-обёртки
```
Сервер исполняется напрямую Node 24 (type stripping): только стираемый синтаксис TypeScript (без enum/namespace/parameter properties), относительные импорты с расширением `.ts`.

### D2. Конфигурация (переменные окружения, `.env` необязателен)
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `HOST` | `127.0.0.1` | адрес прослушивания |
| `PORT` | `8070` | порт (не пересекается с Jellyfin 8096, Immich 2283, qBittorrent 8080) |
| `DASHBOARD_DATA_DIR` | `%LOCALAPPDATA%\FamilyDashboard` | данные приложения вне репозитория |
| `DASHBOARD_DEMO` | `0` | демо-режим (`1` — включить) |
| `LOG_LEVEL` | `info` | уровень логов (pino), секреты редактируются |
| `SERVICE_CHECK_INTERVAL_SEC` / `SERVICE_CHECK_TIMEOUT_MS` | `60` / `3000` | проверки сервисов |
| `VOLUMES` | `C:\` | тома для контроля места, через `;` |
| `LOW_SPACE_PERCENT` | `10` | порог предупреждения |
| `PRINTER_NAME` | пусто → принтер по умолчанию | какой принтер показывать |
| `TAILSCALE_EXE` | `C:\Program Files\Tailscale\tailscale.exe` | путь к CLI |
| `PUBLIC_URL` | `https://server-home.tail89d77e.ts.net` | показывается на странице «Подключение» |
| `LAN_URL` | пусто | резервный адрес в LAN, если включён |

### D3. Данные (каталог данных)
`users.json` (scrypt N=2^15, r=8, p=1, соль 16 байт; формат `scrypt$N$r$p$salt$hash`), `sessions.json` (sha256 токена → userId, createdAt, lastSeenAt; скользящий срок 30 дней; запись на диск не чаще раза в минуту на сессию), `services.json`, `audit.jsonl` (ротация при 5 МБ, 3 файла), `backup-status.json` (пишет будущая задача бэкапа; сейчас отсутствует). Всё записывается атомарно; секретов для подписи не нужно — cookie содержит случайный токен.

### D4. Проверка сервисов
`fetch(healthUrl ?? openUrl, { redirect: 'manual', signal: AbortSignal.timeout(ms) })`; 2xx/3xx → online, 4xx/5xx → degraded, исключение → offline. Все проверки параллельны, результат кэшируется; `GET /api/services` отдаёт кэш. Ручное обновление — admin, не чаще раза в 10 с. URL принимаются только `http:`/`https:`.

### D5. Системные пробы
- CPU: выборка `os.cpus()` каждые 5 с, загрузка = 1 − Δidle/Δtotal.
- RAM: `os.totalmem()/freemem()`; uptime: `os.uptime()`; ОС: `os.version()` + `os.release()`.
- Тома: `fs.statfs` каждые 60 с.
- Физические диски, принтер: `powershell.exe -NoProfile -NonInteractive -Command <фиксированный скрипт>` из allowlist (без аргументов от пользователя), `windowsHide`, таймаут 15 с, `maxBuffer` 1 МБ, раз в 5 мин; результат JSON → разбор и нормализация в коде.
- Tailscale: `execFile(TAILSCALE_EXE, ['status','--json'])`, таймаут 5 с, раз в 60 с.
- Температура: источника нет → `null` + причина.
- Предупреждения строятся только из этих результатов.

### D6. Безопасность HTTP
CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `Permissions-Policy` без камеры/микрофона/геолокации; `Cross-Origin-Opener-Policy: same-origin`. `trustProxy` — только loopback (Tailscale Serve проксирует на 127.0.0.1); cookie `Secure`, когда запрос пришёл по HTTPS. Лимит тела 64 КиБ. Логи pino с `redact` для `authorization`, `cookie`, `password`.

### D7. Интерфейс
- Preact без UI-библиотек; собственный маленький роутер на History API; иконки `lucide-preact`; системные шрифты.
- Дизайн-токены в `web/src/styles/tokens.css` (цвета, отступы, радиусы, тени, типографика, состояния); тёмная тема по умолчанию (slate/zinc), светлая — по `prefers-color-scheme: light`.
- Навигация: нижняя панель (≤ 768 px) / боковая (> 768 px). Цели касания ≥ 44 px.
- Опрос: `/api/services` раз в 60 с, `/api/system` раз в 30 с, только когда вкладка видима; таймаут запроса 10 с.
- Service worker кэширует только оболочку и `/assets/*`; `/api/*` всегда из сети.

### D8. Альтернативы
- Своя сборка сервера через `tsc` → `dist/server`: отклонено, type stripping в Node 24 убирает шаг сборки без потери проверки типов (`tsc --noEmit`).
- `vite-plugin-pwa` (Workbox): отклонено ради минимума зависимостей; service worker ~60 строк.
- SQLite: не нужна — данных мало, нет конкурентной записи.

## Risks / Trade-offs

- [Windows 10 Home без обновлений безопасности] → только loopback + tailnet, без Funnel и проброса портов.
- [Один физический диск] → бэкап на том же диске защищает только от удаления; предупреждение на дашборде, решение — внешний носитель (решение пользователя).
- [PowerShell-пробы медленные (~1–3 с)] → редкий запуск, кэш, таймауты.
- [Tailscale Serve публикует имя узла в журналах Certificate Transparency] → доступа это не даёт; отмечено в `docs/security.md`.
- [Политика выполнения PowerShell `Restricted` у пользователя] → `.cmd`-обёртки запускают скрипты с `-ExecutionPolicy Bypass` только для своего процесса, системная политика не меняется.

## Migration Plan

Новая установка: `npm ci` → `npm run build` → `npm run user -- add …` → `scripts\start.cmd` → (опционально) `scripts\serve-tailnet.cmd`. Откат: `scripts\stop.cmd`, `scripts\serve-tailnet.cmd -Off` (удаляет только адрес дашборда в Serve); каталог данных можно оставить.
