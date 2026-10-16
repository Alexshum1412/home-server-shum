# Proposal

## Why

The owner asked for backups in three places: the main disk, the USB flash drive and GitHub. The first two hold the family data; GitHub was planned only for the code and published once by hand. Without an automatic push the GitHub copy goes stale after every change.

## What Changes

- Every backup run can mirror the committed code to a configured GitHub branch (`BACKUP_GIT_PUSH=origin/main`, off by default).
- The push is fast-forward only, never prompts and is allowed only to `https://github.com/...`; a failure is a remark, not a failed backup.
- The dashboard and the CLI show the mirror as «GitHub (код) — да/нет».
- The repository was published with the owner's GitHub noreply e-mail in commit metadata.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `family-backups`: GitHub becomes an optional third backup place for the code; the «GitHub holds only code» requirement is updated (the repository is published).

## Impact

- Code: `server/src/backup/git.ts` (`pushBranch`), `server/src/backup/run.ts`, `server/src/backup/status.ts` (`optional` target), `server/src/config.ts` (`BACKUP_GIT_PUSH`), `server/src/system/backup.ts`, `server/src/cli/backup.ts`, diagnostics.
- Network: outbound HTTPS to github.com during backups; credentials stay in Windows Credential Manager (Git Credential Manager).
