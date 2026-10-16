# Ранбук: запуск, остановка, обновление

Все команды — из папки проекта `C:\Users\PC\Desktop\THE DASHBOARD` (двойной щелчок по `.cmd` тоже работает). Скрипты берут Node.js из `C:\FamilyServer\tools\nodejs\node.exe`; данные и логи — в `C:\FamilyServer\data\dashboard`.

Запускайте портал из Проводника, командной строки или планировщика. Процесс, запущенный из приложения Claude Desktop, видит AppData иначе, чем остальная Windows (`docs/environment-audit.md`, раздел 12); пути в `C:\FamilyServer` от этого не зависят.

| Действие | Команда | Что происходит |
|---|---|---|
| Запустить в фоне | `scripts\start.cmd` | проверяет Node и зависимости, при необходимости собирает интерфейс, запускает скрытый процесс, ждёт `/api/health` |
| Остановить | `scripts\stop.cmd` | останавливает только процессы `node … server/src/index.ts`, проверяет, что порт освободился |
| Состояние | `scripts\status.cmd` | процесс, ответ сервера, порты, Tailscale Serve |
| Автозапуск при входе | `scripts\autostart.cmd` / `scripts\autostart.cmd -Off` | задача планировщика «FamilyDashboard» для текущего пользователя (без прав администратора) |
| Частный HTTPS | `scripts\serve-tailnet.cmd` / `-Off` | см. `network.md` |
| Резервная копия сейчас | `scripts\backup.cmd` | копия на основной диск и флешку «reserve» с проверкой; см. `backup-restore.md` |
| Ежедневная копия | `scripts\backup-schedule.cmd` / `-Off` | задача планировщика «FamilyServerBackup», 03:30 (включена 16.10.2026) |
| Режим разработки | `npm.cmd run dev` | API :8070 с автоперезапуском + Vite :5173; Ctrl+C — остановить |

Остановка безопасна в любой момент: пользователи, сессии и журнал записываются на диск атомарно сразу при изменении (теряется максимум отметка «последняя активность» сессии за последнюю минуту).

## Пользователи

```bat
scripts\user.cmd add mama --name "Мама" --role family
scripts\user.cmd add alex --name "Алекс" --role admin
scripts\user.cmd list
scripts\user.cmd passwd mama
scripts\user.cmd role mama admin
scripts\user.cmd remove mama --yes
```
Пароль вводится дважды и не отображается; минимум 10 символов. Последнего администратора удалить или понизить нельзя. Смена пароля завершает все сессии этого пользователя. Изменения подхватываются работающим сервером автоматически (в течение пары секунд).

## Обновление кода

```bat
scripts\stop.cmd
git pull            (или скопировать новую версию)
npm.cmd ci
npm.cmd run check
scripts\start.cmd
```
Каталог данных (`C:\FamilyServer\data\dashboard`) при обновлении не трогается. Перед крупным обновлением полезно сделать копию: `scripts\backup.cmd`.

## Логи

`C:\FamilyServer\data\dashboard\logs\dashboard.out.log` и `dashboard.err.log` (предыдущий запуск — `*.log.1`); журнал копирования — `backup.log` там же. Журнал действий пользователей — `audit.jsonl` (виден администратору на странице «Администрирование»).
