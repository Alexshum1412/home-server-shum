# Tasks

## 1. Перенос из AppData в C:\FamilyServer

- [x] 1.1 Перенести Node.js 24.22.0 (+ npm 11.19.1, openspec) и Git 2.56.0.windows.2 в `C:\FamilyServer\tools`, обновить user PATH с сохранением прежнего (`userpath-backup-2026-10-16.txt`); проверено: `node -v` → v24.22.0, `git --version` → 2.56.0.windows.2, в реестре HKCU\Environment новый PATH
- [x] 1.2 Перенести данные портала в `C:\FamilyServer\data\dashboard`, задать права (data\ и backups\ — только PC, SYSTEM, администраторы), `.env`: `DASHBOARD_DATA_DIR`, `GIT_EXE`; проверено: `Get-Acl`, проба из Проводника (`OLD_NODE=absent`, `OLD_DATA=absent`, `NEW_NODE=present`)
- [x] 1.3 Каталог данных по умолчанию на Windows — `%SystemDrive%\FamilyServer\data\dashboard`; `scripts\common.ps1` и `scripts\user.cmd` предпочитают `C:\FamilyServer\tools\nodejs\node.exe`; проверено: `config.test.ts` («puts the data dir and the main-disk backups on the system drive»), портал перезапущен из Проводника и работает из `C:\FamilyServer\tools\nodejs\node.exe`

## 2. Механизм резервного копирования

- [x] 2.1 Места хранения: путь или `label:<метка>\<папка>`, разбор `BACKUP_TARGETS`/`BACKUP_KEEP`/`BACKUP_REPO_DIR`/`BACKUP_EXTRA_FILES`/`GIT_EXE`, read-only скрипт `volumes`; проверено: `config.test.ts` (parses / rejects backup settings), `backup.test.ts` → describe `targets` (буква по метке, флешка не подключена)
- [x] 2.2 Сбор источников (данные без сессий, `.env`, `git bundle`, Tailscale Serve, system-info) и снимок `.partial` → проверка SHA-256 и `git bundle verify` → переименование; проверено: `backup.test.ts` → describe `backup sources`, `snapshot`, `verify`, `git bundle of the code`
- [x] 2.3 Запуск по всем местам с независимым результатом и `backup-status.json`, хранение 14 копий, защита корня диска и папки данных; проверено: `backup.test.ts` → describe `runBackup`, `retention`
- [x] 2.4 Восстановление в пустую папку с проверкой и пробное восстановление с записью `restoreTestedAt`; проверено: `backup.test.ts` → describe `restore`, `testRestore`
- [x] 2.5 CLI `server/src/cli/backup.ts` и `scripts\backup.cmd` (run, list, verify, restore, test-restore, prune; коды 0/1/2); проверено: `backup-cli.test.ts` (полный цикл на двух временных местах, повреждённая копия → 1, сбой места → 1, ошибки использования → 2)

## 3. Статус на дашборде и расписание

- [x] 3.1 Итог по местам в `/api/system` («Последняя копия …: основной диск — да, флешка «reserve» — да»), сбой места → `failed` и критическое предупреждение; настройки бэкапа в диагностике; проверено: `system.test.ts` («summarises every target…», «is failed and names the failed target»), `admin.test.ts`
- [x] 3.2 Задача «FamilyServerBackup» (`scripts\backup-schedule.cmd`, ежедневно 03:30, StartWhenAvailable, только при входе, журнал `logs\backup.log`); проверено: `Start-ScheduledTask` → `LastTaskResult 0`, новая копия `family-backup-20261016-202336` в обоих местах

## 4. Проверка на реальных носителях

- [x] 4.1 `scripts\backup.cmd` → оба места ОК (по 8,1 МБ, `family-backup-20261016-202247`); `scripts\backup.cmd verify` → оба ОК
- [x] 4.2 `scripts\backup.cmd test-restore` → оба места ОК, HEAD `0538b45418fa` совпал с манифестом
- [x] 4.3 Ручное восстановление с флешки в пустую временную папку: SHA-256 `services.json` и `audit.jsonl` совпали с рабочими, код склонирован на `0538b45`
- [x] 4.4 Документация: `docs/runbooks/backup-restore.md`, ADR-0002 (перенос), ADR-0004 (бэкап), README, AGENTS, security, roadmap, tooling, environment-audit (раздел 12), ранбуки, `.env.example`; проверено: поиск `LOCALAPPDATA` по README, AGENTS и docs — старые пути остались только в описании истории переноса; `.env.example` загружается `loadConfig` без ошибок

## Workflow follow-up

- Синхронизировать delta-спецификации в `openspec/specs/` и заархивировать change.
- Отправка кода в GitHub (`Alexshum1412/home-server-shum`) — только после подтверждения владельца; данные семьи — никогда.
