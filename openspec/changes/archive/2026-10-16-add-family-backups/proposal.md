# Proposal

## Why

Данные портала (пользователи с хэшами паролей, журнал, список сервисов), настройки и код хранились в одном экземпляре на единственном рабочем диске; дашборд честно показывал «Резервные копии не настроены». Теперь у владельца есть USB-флешка (NTFS, метка `reserve`), поэтому нужна проверяемая ежедневная копия в два места и честный статус по каждому месту. Попутно выяснилось, что процессы из приложения Claude Desktop (пакет MSIX) пишут в `%LOCALAPPDATA%` виртуализированно — инструменты и данные «в AppData» не были видны Проводнику и Планировщику, поэтому всё серверное перенесено в `C:\FamilyServer`.

## What Changes

- Новый механизм резервного копирования (`server/src/backup/`, CLI `server/src/cli/backup.ts`, `scripts\backup.cmd`): `run | list | verify | restore | test-restore | prune`.
- Места хранения из `BACKUP_TARGETS`: полный путь или `label:<метка>\<папка>`; по умолчанию `C:\FamilyServer\backups` и флешка с меткой `reserve`.
- Копия `family-backup-YYYYMMDD-HHMMSS`: данные портала (без сессий, логов и временных файлов), `config\.env`, `repo.bundle` (вся история Git), настройки Tailscale Serve, сведения о системе, `manifest.json` с SHA-256; запись через `.partial` с повторной проверкой, затем переименование.
- Хранение 14 копий в каждом месте (`BACKUP_KEEP`); восстановление только в новую пустую папку с проверкой; пробное восстановление записывает `restoreTestedAt`.
- `backup-status.json` с результатом по каждому месту; дашборд показывает «Последняя копия …: основной диск — да, флешка «reserve» — да», а ошибку любого места — как состояние «ошибка».
- Ежедневная задача планировщика «FamilyServerBackup» (03:30, `scripts\backup-schedule.cmd`).
- Каталог данных по умолчанию на Windows — `%SystemDrive%\FamilyServer\data\dashboard`; скрипты предпочитают `C:\FamilyServer\tools\nodejs\node.exe`; `GIT_EXE` — путь к git.exe.
- В GitHub предназначен только код; семейные данные туда не попадают.

## Capabilities

### New Capabilities
- `family-backups`: создание, проверка, хранение и восстановление резервных копий семейного сервера, места хранения и статус по каждому месту.

### Modified Capabilities
- `system-status`: требование «Backup status is never assumed» дополнено итогом по местам хранения при успешной копии и состоянием «ошибка» при сбое любого места.

## Impact

- Новый код: `server/src/backup/*`, `server/src/cli/backup.ts`, `scripts/backup.cmd`, `scripts/backup-schedule.{cmd,ps1}`; изменены `server/src/config.ts`, `server/src/system/backup.ts`, `server/src/system/powershell.ts` (read-only скрипт `volumes`), `server/src/system/tailscale.ts` (`serve status --json`), `server/src/admin/routes.ts` (настройки бэкапа в диагностике), `scripts/common.ps1`, `scripts/user.cmd`; тесты `server/test/backup*.test.ts`.
- Новых npm-зависимостей нет; используется установленный Git.
- Система: папка `C:\FamilyServer` (инструменты, данные, копии) с ограниченными правами; user PATH указывает на `C:\FamilyServer\tools`; задача планировщика текущего пользователя; запись на флешку `reserve`. Firewall, Defender, UAC, Tailscale и диск `ST_M13FQBL` не затрагиваются.
- Не входит: шифрование, копия вне дома, копирование будущих данных сервисов (фото, медиа).
