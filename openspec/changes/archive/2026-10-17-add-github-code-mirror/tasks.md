# Tasks

## 1. Mirror

- [x] 1.1 `pushBranch` in `server/src/backup/git.ts`: remote URL guard (https://github.com/ only), fast-forward push with `GCM_INTERACTIVE=never`, Russian reasons; verified by `server/test/backup-mirror.test.ts`
- [x] 1.2 Optional mirror target in `runBackup`, `optional` flag in `backup-status.json`, dashboard treats a failed mirror as a remark; verified by the mirror and dashboard tests (red on old code, green now)
- [x] 1.3 `BACKUP_GIT_PUSH` setting (off by default, strict `<remote>/<branch>`), CLI output, diagnostics key, `.env.example`; verified by the setting test and `npm run check` (328 unit tests, 30 e2e)

## 2. Publication and operation

- [x] 2.1 Publish the repository with the owner's consent and the GitHub noreply e-mail; verified via the GitHub API (head `ce04f38`, only noreply e-mails, no `.env`/data files)
- [x] 2.2 Real runs: manual `scripts\backup.cmd` and the scheduled task «FamilyServerBackup» push to GitHub without a login window; verified (GitHub head = local head `872b1ce`, task result 0)
- [x] 2.3 Docs: runbook backup-restore, ADR-0004, security, roadmap, tooling, README, session handoff; verified by review
