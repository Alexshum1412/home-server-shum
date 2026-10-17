# Tasks

## 1. First administrator and passwords

- [x] 1.1 `--generate-password` for `user.cmd add|passwd`, `mustChangePassword`/`passwordExpiresAt` in users.json, `list` shows the password state; verified by `server/test/password-change.test.ts` (CLI part)
- [x] 1.2 Guards refuse every API but session/password while a temporary password is in use; expired temporary password → 403 after a matching password; verified by `password-change.test.ts`
- [x] 1.3 `POST /api/password` with current-password check, rate limit, policy, fresh session and sign-out of other sessions; verified by `password-change.test.ts` and e2e `tests/e2e/password.spec.ts`
- [x] 1.4 Web: forced «Придумайте свой пароль» screen and «Мой профиль»; admin users table shows the password state; verified by e2e (both flows) and layout/axe checks for `/account`
- [x] 1.5 Real instance: admin `alex` created with a generated password; sign-in gives `mustChangePassword: true`, `/api/services` 403; throwaway admin/family accounts confirmed 200/403 on admin APIs and were removed

## 2. Supervisor and autostart

- [x] 2.1 `server/src/supervisor/{managed,apps,main}.ts`: restart with back-off, hang detection, IPC/API graceful stop, single instance by pipe, state file and log; verified by `server/test/supervisor.test.ts`
- [x] 2.2 `server/src/index.ts` stops cleanly on the IPC message and when the supervisor disconnects
- [x] 2.3 Scripts: `start` (task → supervisor), `stop` (shutdown + stop mark), `status` (apps, task), `autostart` (S4U task, fallback to logon task without admin rights)
- [x] 2.4 Real PC: task «FamilyServer» registered (Boot + Logon + 5-min watchdog, S4U, limited); portal runs in session 0 as SERVER-HOME\PC; killed process came back in 2.3 s; second instance exits; after `stop.cmd` a watchdog run does not restart; Tailscale and printer probes work under S4U
