# Tasks

- [x] 1.1 Family trees in sources (skip trash/partials/temp, links never followed); verified by `backup-family.test.ts`
- [x] 1.2 Hard links for unchanged files, `mtimeMs` in the manifest, size-only check for linked files, estimate of new bytes for the free-space check; verified by `backup-family.test.ts` (same inode, full verify of both snapshots, prune keeps the newer complete)
- [x] 1.3 Jellyfin copied while paused via the supervisor (resume also on failure); verified by tests and a real run (Jellyfin stopped 0.4 s)
- [x] 1.4 Real runs on the PC: backup to C: and the flash drive, verify, test-restore; a family test file restored from the flash with an equal SHA-256
- [x] 1.5 Runbook (contents, restore of family files and Jellyfin, hardware list), ADR-0004, EXECUTION_STATUS
