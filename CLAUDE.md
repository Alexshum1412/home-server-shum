# CLAUDE.md

Общие правила проекта — в [AGENTS.md](AGENTS.md) (прочитай его первым). Здесь — только то, что специфично для Claude Code.

## Инструменты, настроенные в этом проекте
- **Superpowers** (plugin, project scope): для новой функции — brainstorming → writing-plans → test-driven-development; для бага — systematic-debugging; перед заявлением «готово» — verification-before-completion.
- **OpenSpec**: значимые изменения поведения оформляй как change (`/opsx:propose`, `/opsx:apply`, `/opsx:archive`); CLI — `openspec.cmd`.
- **Дизайн UI**: направление и токены уже зафиксированы в `web/src/styles/tokens.css` и `docs/architecture.md` — не создавай второй дизайн-язык. При изменениях UI сверяйся с `frontend-design` и `ui-ux-pro-max` (Python не установлен — только правила из SKILL.md), после — аудит `web-design-guidelines` и проверка в браузере.
- **Браузерные проверки**: `npx.cmd --no-install playwright cli ...` (skill `playwright-cli`) и `npm.cmd run test:e2e`; браузер — установленный Chrome, ничего не скачивать.
- **Context7** (MCP): актуальная документация Fastify/Preact/Vite/Vitest/Playwright — запрашивай конкретный API, а не всю библиотеку.

## Оболочка
Windows PowerShell 5.1: `npm.cmd`/`npx.cmd`; `.ps1`-скрипты с кириллицей сохранять в UTF-8 **с BOM**; `.cmd` — только ASCII.

## Отчёты
Пиши пользователю по-русски. Помечай статусы `Implemented / Partial / Not configured / Blocked`. Не утверждай, что что-то работает, если команда/тест не запускались.
