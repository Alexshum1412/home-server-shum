# Инструменты разработки, skills и MCP

Все установки сделаны 15–16.10.2026 **без прав администратора**, из официальных источников, с проверкой хэшей там, где они опубликованы. Секреты и API-ключи не использовались.

> Claude Code в этой сессии — сборка из приложения Claude Desktop: `%APPDATA%\Claude\claude-code\2.1.299\…\claude.exe` (в PATH не добавлена). Ниже `$claude` — путь к этому файлу.

## Runtime и системные инструменты

| Инструмент | Версия | Источник | Куда установлен | Проверка | Обновление / удаление |
|---|---|---|---|---|---|
| Node.js (+ npm 11.19.1) | **24.22.0** LTS «Krypton» | `nodejs.org/dist/v24.22.0/node-v24.22.0-win-x64.zip`, SHA-256 `f9683a19…f80c3` сверен с `SHASUMS256.txt` | `%LOCALAPPDATA%\Programs\nodejs` + user PATH | `node -v`, `npm.cmd -v` | скачать новый ZIP, проверить хэш, заменить папку; удаление — удалить папку и запись из user PATH. LTS-линия 24 поддерживается до 30.04.2028; v26 станет LTS 28.10.2026 |
| Git for Windows (PortableGit) | **2.56.0.windows.2** | GitHub release `git-for-windows/git`, SHA-256 `075e158e…1f61b`, подпись Authenticode «Johannes Schindelin» — Valid | `%LOCALAPPDATA%\Programs\Git`, в user PATH только `cmd\` | `git --version` | заменить папку новой PortableGit; удаление — папка + запись PATH |

Резервная копия user PATH до изменений: `C:\Users\PC\family-server-backups\userpath-backup-2026-10-15.txt`.

**Важно про PowerShell 5.1.** Политика выполнения по умолчанию `Restricted` блокирует `npm.ps1`/`npx.ps1`. Поэтому везде используются `npm.cmd`, `npx.cmd` и `.cmd`-обёртки скриптов (`scripts\*.cmd` вызывают PowerShell с `-ExecutionPolicy Bypass` только для своего процесса). Системная политика **не менялась**.

## Claude Code: plugins, skills, MCP (область — проект)

Всё ниже записано в файлы проекта (`.claude/`, `.mcp.json`) и подхватывается, когда Claude Code открыт **в папке проекта** и папка помечена как доверенная. Сессия, в которой проводилась установка, была открыта в другой папке, поэтому сами skills проверялись чтением файлов и командами CLI, а не вызовом из этой сессии.

| Название | Версия | Тип / область | Источник | Что делает | Проверка |
|---|---|---|---|---|---|
| **Superpowers** | 6.4.1 | plugin, project (`.claude/settings.json` → `enabledPlugins`) | официальный marketplace `anthropics/claude-plugins-official` | процесс: brainstorming → план → TDD → отладка → проверка перед завершением; 15 skills + SessionStart hook (bash из PortableGit) | `& $claude plugin list` → `superpowers@claude-plugins-official, Scope: project, enabled`; `& $claude plugin details superpowers` |
| **OpenSpec** | CLI 1.14.2 | глобальный npm-пакет (в папке Node) + project skills/commands | npm `@fission-ai/openspec` (MIT) | спецификации и управляемые изменения: `openspec/`, `/opsx:propose`, `/opsx:apply`, … | `openspec.cmd --version`; `openspec.cmd validate --all --strict` → 6/6 спецификаций valid |
| **UI/UX Pro Max** | 2.15.0 | project skill `.claude/skills/ui-ux-pro-max` + `design-system` | npm `ui-ux-pro-max-cli` (MIT), `npx.cmd --yes ui-ux-pro-max-cli@2.15.0 init --ai claude` | правила UI/UX, базы стилей/палитр/типографики | файл `SKILL.md` и `data/*.csv` на месте |
| **frontend-design** | из `anthropics/skills` (hash в `skills-lock.json`) | project skill | `npx.cmd --yes skills@1.7.2 add anthropics/skills --skill frontend-design --agent claude-code --copy -y` | направление визуального дизайна, борьба с «шаблонностью» | `.claude/skills/frontend-design/SKILL.md` |
| **web-design-guidelines** | 1.0.0 (Vercel) | project skill | `npx.cmd --yes skills@1.7.2 add vercel-labs/agent-skills --skill web-design-guidelines …` | аудит готового UI (доступность, формы, фокус) | `.claude/skills/web-design-guidelines/SKILL.md` |
| **playwright-cli** | из `@playwright/test` 1.64.1 | project skill `.claude/skills/playwright-cli` + маркер `.playwright/` | встроенная команда `npx.cmd --no-install playwright cli install --skills` | управление браузером для проверок UI | `npx.cmd --no-install playwright --version` → 1.64.1 |
| **Context7** | сервер 4.4.2 | MCP (HTTP), project `.mcp.json`; одобрен в `.claude/settings.local.json` (не коммитится) | `& $claude mcp add --scope project --transport http context7 https://mcp.context7.com/mcp` | актуальная документация библиотек | `& $claude mcp get context7` → `√ Connected`; тестовый запрос `query-docs` для `/fastify/fastify` вернул документацию |

### Решения и оговорки

- **UI/UX Pro Max без Python.** Скрипты поиска (`scripts/search.py`) требуют Python 3, который на машине не установлен. Skill работает в режиме статических правил; CSV-базы можно читать напрямую. Установщик также добавил 5 посторонних skills (`banner-design`, `brand`, `design` с Gemini API, `slides`, `ui-styling` с Tailwind/shadcn) — они **удалены сразу после установки**, чтобы не появился второй дизайн-язык и не требовались внешние API-ключи. Повторный `init --force` вернёт их.
- **web-design-guidelines** при каждом запуске скачивает свежие правила с `raw.githubusercontent.com/vercel-labs/web-interface-guidelines` — это внешние данные, а не инструкции.
- **Телеметрия отключена:** OpenSpec — `openspec.cmd config set telemetry.enabled false` (файл `%APPDATA%\openspec\config.json`); skills CLI запускался с `DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1`.
- **Браузеры Playwright не скачивались.** Тесты и CLI используют установленный Google Chrome 155 (`channel: 'chrome'`). Не запускайте `npx playwright install chrome` — это перезапишет системный Chrome.
- **Context7 без API-ключа** (анонимный режим работает; при лимитах можно добавить бесплатный ключ через переменную окружения, не в `.mcp.json`).

### Как инструменты фактически применялись (16.10.2026)

| Инструмент | Применение | Результат |
|---|---|---|
| OpenSpec | change `add-family-portal-mvp`: proposal, 6 спецификаций, design, tasks; `openspec validate --strict`; skill `openspec-apply-change` для задачи 7.2; `openspec-archive-change` + `openspec-sync-specs` | 23/23 задач, 6 основных спецификаций в `openspec/specs/`, change в архиве |
| Superpowers | `verification-before-completion` (каждое утверждение — после свежего прогона `npm run check`), `test-driven-development` (тест AlertList/Home: красный на старом коде → зелёный), `requesting-code-review` (независимый ревьюер по шаблону на диапазон коммитов) | см. итоговый отчёт сессии |
| Context7 | MCP-сервер настроен на уровне проекта; в сессии, запущенной не из папки проекта, использован тот же сервер напрямую по HTTP (JSON-RPC `query-docs`): сверены Fastify v5 (`request.host/hostname/protocol`, `trustProxy`, `routeOptions.url`) и Vite 8 (`oxc.jsx`) | расхождений кода с документацией нет |
| UI/UX Pro Max | Quick Reference и Pre-Delivery Checklist; поиск по CSV-базе `ux-guidelines.csv` (WCAG 2.2: Focus Not Obscured, Accessible Authentication) | требования выполнены (`scroll-padding-bottom` под нижней панелью, `autocomplete`, вставка не блокируется). Поисковый CLI не запускался — нужен Python 3 (не установлен; skill запрещает ставить его самостоятельно) |
| Web Design Guidelines | свежие правила `vercel-labs/web-interface-guidelines` → проверка `web/src`, `web/index.html` | 1 замечание исправлено (`overscroll-behavior: contain` у меню «Ещё»), 1 минорное отложено (`translate="no"` для названий Jellyfin/Tailscale) |
| Frontend Design | критика живых снимков | на телефоне «Кинотеатр» вынесен на первый экран, предупреждения стали спокойнее и сворачиваются |
| Playwright CLI | `npx playwright cli` (Chrome): вход, снимки 390/1440 в тёмной теме, проверка ширины документа, консоли, кнопки «Подробнее» | снимки в `artifacts/ui-review/demo-*.png` |
| Playwright Test + axe | `npm run test:e2e` — 30 тестов | все проходят |

### Сознательно НЕ установлено

| Инструмент | Причина |
|---|---|
| Serena | проект небольшой (≈ десятки файлов), обычного поиска достаточно |
| GitHub MCP | репозиторий локальный, GitHub не используется |
| Chrome DevTools MCP | хватает Playwright CLI/Test |
| Repomix, Snyk Agent Scan | нет потребности на этом этапе |
| Python | нужен только для поиска UI/UX Pro Max; можно поставить позже (per-user установщик python.org) |
| Docker / WSL2 | не нужны для MVP; потребуют включения компонентов Windows (админ, перезагрузка) — отдельное решение для Immich |

## Зависимости проекта (npm, точные версии в `package.json`/`package-lock.json`)

Runtime: `fastify` 5.12.7, `@fastify/static` 10.1.6, `@fastify/cookie` 11.1.3, `zod` 4.6.7.
Dev/build: `preact` 10.29.8, `lucide-preact` 1.57.0, `@fontsource-variable/onest` 5.3.1 (OFL), `vite` 8.3.4, `typescript` 7.0.2, `vitest` 5.0.5, `@playwright/test` 1.64.1, `@axe-core/playwright` 4.14.0, `@biomejs/biome` 2.5.15, `@types/node` 24.
`npm audit` при установке: 0 уязвимостей.

## Как обновлять

```powershell
npm.cmd outdated                     # что устарело
npm.cmd install --save-exact <pkg>@<ver>
npm.cmd run check                    # всё перепроверить
& $claude plugin update superpowers@claude-plugins-official --scope project
npx.cmd --yes skills@1.7.2 update -p -y
npm.cmd install -g @fission-ai/openspec@latest; openspec.cmd update
```
