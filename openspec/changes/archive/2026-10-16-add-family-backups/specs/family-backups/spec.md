# Spec Delta

## Purpose

Сохраняет данные портала, настройки и код семейного сервера в проверяемые резервные копии в нескольких местах хранения (основной диск и флешка «reserve»), честно сообщает результат по каждому месту и позволяет безопасно восстановиться, не трогая рабочие данные.

## ADDED Requirements

### Requirement: Verified snapshot in every target
Each backup run SHALL write one snapshot with the same name to every configured target. A snapshot SHALL contain the portal data files without live sessions, logs or temporary files, plus a manifest with the size and SHA-256 of every file. The snapshot SHALL get its final name only after every file was re-read from the target and matched the manifest. Settings, code history and network configuration SHALL be saved on a best-effort basis.

#### Scenario: Snapshot written to both targets
- **WHEN** a backup runs with the main disk and the flash drive both available, the project `.env` present, Git available and Tailscale answering
- **THEN** each target holds a folder `family-backup-YYYYMMDD-HHMMSS` with the same name, containing `data/`, `config/.env`, `repo.bundle`, `network/tailscale-serve.json`, `system-info.json` and `manifest.json`, and every file matches its SHA-256 in the manifest
- **AND** `sessions.json`, logs and temporary files are not in the snapshot

#### Scenario: Integrity check fails
- **WHEN** a file written to a target does not match the manifest during the check
- **THEN** the unfinished folder is removed, no snapshot with a final name appears in that target, and that target is reported as failed

#### Scenario: Code bundle cannot be created
- **WHEN** Git is missing or the code bundle cannot be created
- **THEN** the snapshot with the data is still written and verified, and the reason is recorded in the manifest and reported as a warning

#### Scenario: Data folder missing
- **WHEN** the portal data folder does not exist
- **THEN** no snapshot is written and every target is reported as failed

### Requirement: Per-target result and status record
Every target SHALL be written and reported independently; a failing target SHALL NOT stop the others. A run SHALL count as successful only when every target succeeded. Each run SHALL be recorded in a status record with the run time, the result, the time of the last fully successful run, the time of the last passed restore test, each target's result with a Russian reason, and warnings. The backup command SHALL exit with code 1 when any target failed.

#### Scenario: Flash drive not connected
- **WHEN** a backup runs while the flash drive target is not connected
- **THEN** the main-disk snapshot is still written and verified, the flash drive target is reported as failed with the reason «Флешка «reserve» не подключена», the run result is `failed`, the time of the last fully successful run keeps its previous value, and the command exits with code 1

#### Scenario: All targets succeed
- **WHEN** every target is written and verified
- **THEN** the run result is `ok`, the time of the last fully successful run equals this run's time, the previous restore test time is kept, and the command exits with code 0

### Requirement: Retention per target
Each target SHALL keep the newest complete snapshots up to the configured number (default 14) and SHALL delete older ones only after the new snapshot is written and verified. Unfinished snapshot folders older than 24 hours SHALL be removed. Nothing else in the target folder SHALL be deleted, links SHALL never be followed, and a drive root or the live data folder SHALL never be used as a target.

#### Scenario: Oldest snapshot removed
- **WHEN** a target already holds 14 complete snapshots and a new snapshot is written and verified
- **THEN** the oldest snapshot is deleted, 14 snapshots remain including the new one, and other files in the target folder are untouched

#### Scenario: Unsafe target refused
- **WHEN** a configured target is a drive root or lies inside the live data folder
- **THEN** that target fails with a Russian reason and nothing is written or deleted there

### Requirement: Restore never touches live data
Restoring SHALL verify the snapshot first and SHALL write only into a new or empty folder that is neither the live data folder nor inside it. Every restored file SHALL be re-read and compared with the manifest, and the code SHALL be cloned from the bundle unless the operator skips it. Replacing the live data SHALL remain a manual step done with the server stopped; live sessions are not restored.

#### Scenario: Restore into the live data folder refused
- **WHEN** an operator restores a snapshot into the live data folder, a folder inside it, or a non-empty folder
- **THEN** the restore is refused with a Russian message and nothing is written

#### Scenario: Damaged snapshot refused
- **WHEN** a file of the snapshot is missing, extra or does not match its SHA-256
- **THEN** the restore is refused and names the problem file

#### Scenario: Successful restore
- **WHEN** an operator restores a valid snapshot into a new empty folder
- **THEN** every file of the manifest is present there with a matching SHA-256 and the code is cloned at the commit recorded in the manifest

### Requirement: Restore test before trusting backups
A restore test SHALL restore the newest snapshot of every target into a temporary folder, verify every file, clone the code (when the snapshot has it) and compare its commit with the manifest, and SHALL remove the temporary folders afterwards. The restore test time SHALL be recorded only when every target passed.

#### Scenario: Restore test passes
- **WHEN** the newest snapshot of every target restores and matches its manifest and code commit
- **THEN** the restore test time is recorded in the status record and the temporary folders are removed

#### Scenario: A target has no snapshot
- **WHEN** one target has no complete snapshot
- **THEN** that target is reported as failed and the restore test time is not updated

### Requirement: Flash drive identified by volume label
A target given as `label:<label>\<folder>` SHALL resolve to that folder on the single mounted volume with that label, whatever its drive letter; the folder part SHALL be mandatory. A missing volume, or several volumes with the same label, SHALL fail only that target with a Russian reason.

#### Scenario: Drive letter changed
- **WHEN** the flash drive labelled `reserve` is mounted as `E:` instead of `D:`
- **THEN** the snapshot is written to `E:\FamilyServerBackups`

#### Scenario: Two volumes with the same label
- **WHEN** two mounted volumes carry the label `reserve`
- **THEN** that target fails with a message asking to keep the label on one volume, and the other targets are still written

### Requirement: GitHub holds only code
Backups SHALL be written only to the configured targets and SHALL NOT upload family data to GitHub or any other external service. The project repository, which may be published to GitHub only after the owner confirms, SHALL contain only code and documentation; the data folder, the settings file, logs and snapshots SHALL stay outside it and be ignored by Git.

#### Scenario: Repository contents
- **WHEN** the files tracked by Git are listed
- **THEN** there is no `.env`, no file from the portal data folder, no log and no backup snapshot among them
