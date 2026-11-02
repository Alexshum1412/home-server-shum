# AGENTS.md — правила проекта «Семейный сервер»

Семейный портал (PWA) на Windows: Node.js 24 + TypeScript, Fastify (`server/`), Preact + Vite (`web/`), общий контракт `shared/`.

## Команды (Windows PowerShell 5.1 — всегда `npm.cmd`/`npx.cmd`)
```
npm.cmd ci          # зависимости
npm.cmd run dev     # сервер и интерфейс для разработки
npm.cmd run build   # интерфейс -> dist/web
npm.cmd run lint    # Biome
npm.cmd run typecheck
npm.cmd test        # Vitest
npm.cmd run test:e2e   # Playwright в установленном Chrome (сначала build)
npm.cmd run check   # всё вместе
```

## Правила кода
- Сервер исполняется Node напрямую (type stripping): только стираемый TypeScript (без `enum`, `namespace`, parameter properties), относительные импорты с `.ts`, типы через `import type`.
- Типы API меняются в `shared/`, сервер и клиент — вместе.
- Никаких выдуманных значений: нет данных → `null` + причина; демо-данные только при `DASHBOARD_DEMO=1`.
- Тексты для людей — по-русски, простым языком; статус всегда «иконка + слово».
- Секреты, данные семьи и личные адреса в репозиторий не попадают.
- Перед завершением работы: `npm.cmd run check` и честный отчёт о результате.

## Границы
Без явного согласия владельца не менять системные настройки Windows (брандмауэр, Defender, UAC, обновления), сеть Tailscale, не форматировать диски, не удалять пользовательские данные и не публиковать данные или логи.
