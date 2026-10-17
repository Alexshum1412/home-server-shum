# Tasks

## 1. Planner

- [x] 1.1 Calendar store, repeats, `.ics` export and routes; verified by `server/test/planner.test.ts` and e2e `planner.spec.ts`
- [x] 1.2 Notes as files in «Заметки» with a revision check; verified by the same tests (conflict, privacy, link escape, trash)
- [x] 1.3 Pages «Календарь» and «Заметки», today's events on the home page; verified by e2e and axe on both pages

## 2. Audiobooks and media fallback

- [x] 2.1 Library «Аудиокниги» through `jellyfin-setup`; on the real Jellyfin the files are `AudioBook` items
- [x] 2.2 Read-only media player with Range support and remembered audiobook position; verified by `server/test/media.test.ts` and e2e `accounts-and-fallbacks.spec.ts`

## 3. Fallbacks

- [x] 3.1 `LAN_BIND`, `scripts\lan-mode.cmd`; verified by `server/test/lan.test.ts` and a real run on the PC's home-network address
- [x] 3.2 `scripts\import.cmd` / `export.cmd`; verified by `server/test/transfer.test.ts` and a run on temporary folders
- [x] 3.3 Waiting queue for printing; verified by `server/test/print-deferred.test.ts`
- [x] 3.4 `scripts\doctor.cmd`, `scripts\service.cmd`; verified by `server/test/doctor.test.ts` and live runs
- [x] 3.5 Optional local model for «Оливия»; verified by `server/test/olivia-llm.test.ts` (mock server; no model installed)

## 4. Accounts and UI

- [x] 4.1 User management in the portal; verified by `server/test/admin-users.test.ts` and e2e
- [x] 4.2 UI audit fixes (address state, toast, viewer, uploads, forms, tables); verified by e2e and unit tests
