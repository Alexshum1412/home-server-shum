# Инструкция для следующей сессии

Ты продолжаешь THE DASHBOARD (`C:\Users\PC\Desktop\THE DASHBOARD`, репозиторий https://github.com/Alexshum1412/home-server-shum, ветка `main`) — семейный портал на домашнем ПК. Читай по порядку: `AGENTS.md`, `docs/EXECUTION_STATUS.md`, `docs/owner-actions.md`, `docs/feature-fallback-matrix.md`. Пиши по-русски. Ничего не переписывай с нуля, Git-историю не перезаписывай.

## Состояние на 18.10.2026

Готово и проверено (подробно — `EXECUTION_STATUS.md`): P1–P10, семейный чат, звонки (на одном ПК), уведомления, каталог кинотеатра, торрентная очередь (на макете клиента), «Оливия» для семьи, политика публичного HTTPS-канала, мониторинг оборудования, руководство для семьи со снимками. 740 unit-тестов, 83 e2e-теста, `openspec validate --all --strict` — 14 из 14.

**Ничего из того, что требует установки, аккаунта или согласия, не сделано и не считается работающим.** Работа с ними — только после явного «да» владельца в чате.

## Что осталось (по важности)

1. **Торрент-клиент.** Спросить согласие на загрузку `aria2-1.37.0-win-64bit-build1.zip` (2 475 379 байт, github.com/aria2/aria2, релиз `release-1.37.0`). После «да»: скачать **в новую пустую папку**, посчитать SHA-256, закрепить его в `scripts/components.json` (поле `aria2.sha256`), запустить `scripts\torrent-setup.cmd`, перезапустить портал, проверить настоящую законную раздачу (например, образ дистрибутива Linux): прогресс, ETA, пауза/продолжение, завершение, обновление Jellyfin. Записать результат в `docs/runbooks/torrents.md` («Не проверено» → результат).
2. **Локальная модель.** Согласие на `llama-b11717-bin-win-cpu-x64.zip` (19 662 390 байт) и `qwen2.5-1.5b-instruct-q4_k_m.gguf` (1 117 320 736 байт); суммы уже закреплены. После «да»: `scripts\ai-setup.cmd`, затем **проверить флаги** `llama-server --help` (в `server/src/supervisor/apps.ts` используются `-m --host --port --alias -c -t -np --no-webui`; их наличие в этой сборке не проверялось), добавить `OLIVIA_LLM_URL` в `.env`, замерить память и скорость и записать в `docs/runbooks/local-ai.md` и ADR-0011.
3. **Звонок на двух настоящих устройствах** и **push на телефоне** — проверки владельца (`docs/runbooks/chat-and-calls.md`); если нужен TURN — помочь поднять coturn и записать `CALLS_*`.
4. **Туннель (Cloudflare Tunnel + Access)** — нужны аккаунт и домен владельца (`docs/runbooks/public-https.md`). Скачивание `cloudflared.exe` — только с согласия.
5. **LibreHardwareMonitor** (температура процессора) — по желанию владельца, `HWMONITOR_URL`.
6. Владельцу: удалить мусор аудита (`docs/owner-actions.md`), exit node, шифрование копий, копия вне дома, второй диск.
7. Развитие по желанию: фоновая выгрузка фото, копирование вне дома, шифрование копий.

## Как работать на этом ПК

- **Node.** PATH сессии Claude Desktop может указывать на старый Node в AppData; всегда первым ставь `C:\FamilyServer\tools\nodejs`. Из Git Bash `npx.cmd` иногда падает с Segmentation fault: запускай из PowerShell и вызывай инструменты напрямую:
  ```powershell
  $env:Path = 'C:\FamilyServer\tools\nodejs;' + $env:Path
  node node_modules\vitest\vitest.mjs run
  node node_modules\typescript\bin\tsc -p tsconfig.json --noEmit
  node node_modules\@biomejs\biome\bin\biome check --write .
  ```
- **Проверки:** `npm.cmd run lint`, `typecheck`, `test`, `build`, `test:e2e`; `npm.cmd run guide:screenshots` (картинки руководства; нужен свежий `build`); `openspec.cmd validate --all --strict` (`OPENSPEC_TELEMETRY=0`); `npm.cmd audit`.
- **Сбои раннера.** Раннер тестов иногда падает (антивирус и служба памяти на этом ПК): повтори. `playwright.config.ts` уже делает один повтор; «нестабильный» тест из-за `Target crashed` — не ошибка продукта.
- **Портал и Jellyfin** работают под супервизором: `node --env-file-if-exists=.env server\src\supervisor\main.ts status|restart dashboard`. Применить новый код: `npm.cmd run build`, затем `restart dashboard`.
- **Правки файлов с обратными слэшами и обратными кавычками** делай инструментами Edit/Write, а не через `node -e` или `heredoc` в Bash: `\\`, `\d`, `` ` `` теряются или раскрываются (из-за этого в сессии ломались регулярные выражения и пути).
- **Проверки на рабочем портале** — через временные учётки (`scripts\user.cmd add <логин> --role admin --password-stdin`), пароль не печатать, учётку потом удалить.
- **Коммиты:** сообщение коммита пиши в файл, `git commit -F <файл>`; пуш — `git push origin main` (репозиторий публичный: только код и документация, секретов нет).

## Запреты (владелец)

- Не отключай защиту ради тестов; не исполняй команды, сформированные ИИ; не включай публичный доступ и Funnel; не клади семейные данные, пароли и токены в Git.
- Не трогай диск `ST_M13FQBL`; не меняй Firewall, Defender, UAC, обновления Windows, ACL/DNS/маршруты Tailscale; не пробрасывай порты; не удаляй и не переноси пользовательские данные.
- Не создавай много независимых ревьюеров и бесконечные циклы перепроверки: один аудит, одна правка.
- Скачивание любого файла — только с явного согласия владельца в чате (имя, источник, размер) и с проверкой SHA-256.
- Не заявляй готовность того, что не проверено.
