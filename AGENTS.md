# AGENTS.md — правила проекта «Семейный сервер» (для любых coding-агентов)

## Что это
Семейный портал (PWA) на Windows 10: Node.js 24 + TypeScript, Fastify (`server/`), Preact + Vite (`web/`), общий контракт API `shared/api.ts`. Подробности: `docs/architecture.md`, решения: `docs/decisions/`, спецификации: `openspec/`.

## Команды (Windows PowerShell 5.1 — всегда `npm.cmd`/`npx.cmd`)
```
npm.cmd ci                 # зависимости
npm.cmd run dev            # API :8070 + Vite :5173
npm.cmd run build          # интерфейс -> dist/web
npm.cmd run lint           # Biome
npm.cmd run typecheck      # tsc (server+shared+tests и web)
npm.cmd test               # Vitest
npm.cmd run test:e2e       # Playwright в установленном Chrome (сначала build)
npm.cmd run check          # всё вместе
scripts\start.cmd | stop.cmd | status.cmd | serve-tailnet.cmd | user.cmd
```
Если `node`/`git` не находятся в новой оболочке: `$env:Path = "$env:LOCALAPPDATA\Programs\nodejs;$env:LOCALAPPDATA\Programs\Git\cmd;$env:Path"`.

## Правила кода
- Сервер исполняется Node напрямую (type stripping): только стираемый TypeScript (без `enum`, `namespace`, parameter properties), относительные импорты с `.ts`, типы — через `import type`.
- Типы API меняются только в `shared/api.ts`, сервер и клиент — вместе.
- Никаких выдуманных значений: нет данных → `null` + причина; демо-данные только при `DASHBOARD_DEMO=1` и с `demo: true`.
- Тексты для людей — на русском, простым языком; статус всегда «иконка + слово», не только цвет.
- Новые системные пробы — только фиксированные read-only команды из allowlist, с таймаутом и кэшем.
- Новые зависимости — только при реальной необходимости, точная версия, запись в `docs/tooling.md`.
- Перед завершением работы: `npm.cmd run check` и честный отчёт о результатах.

## Границы (без явного согласия владельца — нельзя)
Форматировать/размечать диски (особенно устройство `ST_M13FQBL`); менять Firewall, Defender, UAC, политики выполнения, обновления Windows; включать Tailscale Funnel, менять ACL/DNS/маршруты Tailscale, пробрасывать порты; удалять/перемещать пользовательские данные; публиковать данные, логи или код во внешние сервисы; хранить секреты в Git; давать UI/LLM выполнение команд.

## Где что лежит
- Данные приложения: `%LOCALAPPDATA%\FamilyDashboard` (вне репозитория).
- Логи фонового запуска: `%LOCALAPPDATA%\FamilyDashboard\logs`.
- Резервная копия исходного состояния: `C:\Users\PC\family-server-backups\`.
