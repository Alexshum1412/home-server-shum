# Design

## Context

See proposal.md. The local backup engine (`server/src/backup`) already bundles the git history into every snapshot; the GitHub repository is public, so only committed code and documentation may go there.

## Goals / Non-Goals

**Goals:** keep the GitHub copy of the code current without manual steps; never lose or overwrite history; never block a scheduled run on a login window.

**Non-Goals:** pushing family data, encrypted data backups to the cloud, pull/merge automation.

## Decisions

- **Optional target, not a file target.** The mirror is recorded in `backup-status.json` with `optional: true`; the run result depends only on the local targets. Alternative — making GitHub a required target — rejected: an internet outage would raise a critical «backup failed» alert while the family data is safe.
- **Fast-forward only.** `git push <remote> refs/heads/<branch>:refs/heads/<branch>` without `--force`; a rejected push is explained in Russian and left for a human. Alternative — force push — rejected: it can destroy history on GitHub.
- **No prompts.** `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`: an expired GitHub login fails fast in the scheduled task; the owner signs in again with `git push` in the project folder.
- **URL guard.** Only `https://github.com/<owner>/<repo>` is allowed by default (tests inject a local bare remote); credentials embedded in a URL are never printed.
- **Off by default.** `BACKUP_GIT_PUSH` must be set explicitly (`origin/main` on this PC).

## Risks / Trade-offs

- [The repository is public] → only code/docs; e-mail replaced by the GitHub noreply address; `.gitignore` keeps `.env`, data, logs and snapshots out (verified via the GitHub API).
- [The GitHub token in Windows Credential Manager can push to the owner's repositories] → documented in `docs/security.md` with how to revoke it.
- [A commit containing a mistake is published automatically] → pushes happen only for committed code; every change goes through `npm run check` before commit.
