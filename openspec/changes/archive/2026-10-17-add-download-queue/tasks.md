# Tasks

## 1. Rights and queue

- [x] 1.1 `permissions` in users.json, `effectivePermissions`, session/admin API, `user.cmd allow|deny`; verified by unit tests and typecheck
- [x] 1.2 Network guard (BlockList, safe lookup, URL check) and safe names; verified by `downloads.test.ts` (guard and names)
- [x] 1.3 Manager: check/confirm, per-user folder, limits, pause/resume/cancel, restart recovery, audit; verified by `downloads.test.ts` (13 tests)
- [x] 1.4 Routes with right check, rate limit and owner isolation; verified by `downloads.test.ts`

## 2. Portal

- [x] 2.1 «Загрузки» page (check → confirm → list with progress and actions); verified by e2e `downloads.spec.ts` and axe/layout at 6 widths
- [x] 2.2 Built-in services in the registry; verified by `services.test.ts`
- [x] 2.3 Real run on the production portal: OVH 1 MB file completed (SHA-256 equal, ZoneId=3), 100 MB file paused, resumed and canceled (part removed)
