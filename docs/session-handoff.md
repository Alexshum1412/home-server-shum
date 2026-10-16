# Передача работы между сессиями

_Обновлено: 16.10.2026 (поздний вечер). Коротко: статус, что проверено, что дальше._

## Где остановились

- MVP портала реализован и проверен: сервер (`server/`), интерфейс (`web/`), скрипты (`scripts/`), документация (`docs/`). OpenSpec: changes `add-family-portal-mvp` и `add-family-backups` в архиве, основные спецификации — `openspec/specs/` (7 возможностей, включая `family-backups`).
- **Перенос из AppData (16.10.2026).** Claude Desktop — пакет MSIX: его процессы пишут в `%LOCALAPPDATA%` виртуализированно, поэтому Node.js, Git и данные «в AppData» не были видны снаружи. Всё перенесено в `C:\FamilyServer` (`tools\nodejs`, `tools\git`, `data\dashboard`, `backups\`); user PATH обновлён; `.env` задаёт `DASHBOARD_DATA_DIR` и `GIT_EXE`. Портал перезапущен из Проводника и работает из `C:\FamilyServer\tools\nodejs\node.exe`. Подробно — `docs/environment-audit.md`, раздел 12; ADR-0002.
- **Резервное копирование — Implemented / Partial.** `scripts\backup.cmd` + задача «FamilyServerBackup» (ежедневно 03:30): `C:\FamilyServer\backups` и флешка с меткой `reserve` (сейчас `D:`), 14 копий, SHA-256, `backup-status.json` → дашборд. Проверено: копия в оба места, `verify`, `test-restore`, ручное восстановление с флешки, запуск задачи (`LastTaskResult 0`). Последняя копия — `family-backup-20261016-202336` в обоих местах. Ранбук — `docs/runbooks/backup-restore.md`; ADR-0004.
- Код бэкапа и переноса закоммичен (`f7f10cb`). Имеющиеся копии содержат код до коммита `0538b45` — `f7f10cb` попадёт в следующую копию.
- Проверки 16.10.2026: `npm.cmd test` — 322 теста (27 файлов) проходят; `npm.cmd run lint` (145 файлов) и `npm.cmd run typecheck` — без ошибок; `openspec validate --all --strict` — без ошибок. Полный `npm.cmd run check` с e2e в этой сессии документации не запускался (по сообщению коммита `f7f10cb` — 30 e2e проходят).
- Рабочий экземпляр: `http://127.0.0.1:8070`; пользователей ещё нет (`users.json` отсутствует) — владелец создаёт сам.
- Tailscale Serve включён: `https://server-home.tail89d77e.ts.net` (tailnet only, без Funnel).
- GitHub: `origin` = https://github.com/Alexshum1412/home-server-shum (публичный) — код опубликован 17.10.2026 и обновляется при каждом копировании (`BACKUP_GIT_PUSH=origin/main`); e-mail в коммитах — noreply; данные семьи — никогда.

## Как продолжить

```bat
cd /d "C:\Users\PC\Desktop\THE DASHBOARD"
git log --oneline
npm.cmd run check
scripts\status.cmd
scripts\backup.cmd list
```

## Следующие шаги

1. Владелец: `scripts\user.cmd add <логин> --name "<Имя>" --role admin`, затем вход в портал.
2. Владелец: решить про автозапуск (`scripts\autostart.cmd`) и обновления Windows/ESU.
3. Владелец: проверить вход с телефона по адресу tailnet и добавить на домашний экран.
4. Готово: код на GitHub (три места копий: диск C:, флешка «reserve», GitHub).
5. Владелец: решить про зашифрованную копию вне дома (место, ключ) — `docs/runbooks/backup-restore.md`, последний раздел.
6. Разработка: этап P2 — Jellyfin (см. `docs/roadmap.md`); при установке сервисов расширить резервное копирование на их данные.

## Известные ограничения

- Второй диск `ST_M13FQBL` неисправен — не трогать (`docs/runbooks/second-disk.md`).
- Копии только дома (тот же диск + флешка в том же ПК), без шифрования; задача копирования работает только при выполненном входе в Windows.
- LAN-резерв выключен (нужно правило Firewall от администратора).
- UI/UX Pro Max: поисковый CLI требует Python 3 (не установлен).
- Старые копии Node.js, Git и данных внутри пакета Claude (`…\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\`) оставлены как есть.
