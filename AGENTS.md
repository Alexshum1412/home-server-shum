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
scripts\backup.cmd [list | verify [копия] | test-restore | restore <копия> --to <пустая папка> | prune]
scripts\backup-schedule.cmd [-Off]   # задача «FamilyServerBackup», ежедневно 03:30
```
Если `node`/`git` не находятся в новой оболочке: `$env:Path = "C:\FamilyServer\tools\nodejs;C:\FamilyServer\tools\git\cmd;$env:Path"`.
OpenSpec CLI — `openspec.cmd` (лежит в `C:\FamilyServer\tools\nodejs`).

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
- Корень сервера: `C:\FamilyServer` — **не** `%LOCALAPPDATA%`: у процессов, запущенных из приложения Claude Desktop (пакет MSIX), записи в AppData виртуализируются, и такие файлы не видны остальной Windows (см. `docs/environment-audit.md`, раздел 12).
- Инструменты: Node.js 24 + npm + openspec — `C:\FamilyServer\tools\nodejs`; Git — `C:\FamilyServer\tools\git` (в PATH — `cmd\`).
- Данные приложения: `C:\FamilyServer\data\dashboard` (вне репозитория; задано в `.env` как `DASHBOARD_DATA_DIR`, это же значение по умолчанию). Права: только PC, SYSTEM, администраторы.
- Логи фонового запуска и копирования: `C:\FamilyServer\data\dashboard\logs` (`backup.log`).
- Резервные копии: `C:\FamilyServer\backups` и флешка с меткой `reserve` (`<буква>:\FamilyServerBackups`); ранбук — `docs/runbooks/backup-restore.md`. Семейные данные — никогда в Git/GitHub.
- Резервная копия исходного состояния и прежних PATH: `C:\Users\PC\family-server-backups\`.
