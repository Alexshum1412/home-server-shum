# Spec Delta

## ADDED Requirements

### Requirement: Code mirror to GitHub
When a mirror branch is configured, every backup run SHALL push the committed code of the project to it after the local targets are written. The push SHALL be fast-forward only, SHALL never ask for a login and SHALL be allowed only to a repository on `https://github.com/`. The mirror is optional: its failure SHALL be reported as a remark and SHALL NOT make the backup run fail.

#### Scenario: Successful mirror
- **WHEN** a backup runs with `BACKUP_GIT_PUSH=origin/main` and GitHub is reachable
- **THEN** the remote branch points to the local commit and the status lists «GitHub (код)» as done with that commit

#### Scenario: Diverged remote is never overwritten
- **WHEN** the GitHub branch has commits that the local repository does not have
- **THEN** nothing is overwritten, the mirror is reported with the reason, and the local backups still succeed

#### Scenario: Only GitHub is allowed
- **WHEN** the configured remote points anywhere but `https://github.com/`
- **THEN** nothing is pushed and the mirror reports that only GitHub is allowed

#### Scenario: Mirror off by default
- **WHEN** `BACKUP_GIT_PUSH` is not set or is `none`
- **THEN** no push is attempted and no mirror appears in the status

## MODIFIED Requirements

### Requirement: GitHub holds only code
Backups SHALL be written only to the configured targets and SHALL NOT upload family data to GitHub or any other external service. The project repository, published to GitHub with the owner's consent and mirrored there by the backup run, SHALL contain only code and documentation; the data folder, the settings file, logs and snapshots SHALL stay outside it and be ignored by Git.

#### Scenario: Repository contents
- **WHEN** the files tracked by Git are listed
- **THEN** there is no `.env`, no file from the portal data folder, no log and no backup snapshot among them
