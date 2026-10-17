# family-backups delta

## ADDED Requirements

### Requirement: Family data in every snapshot
Every snapshot SHALL contain the family files, photos with their thumbnails and home videos, without trash, unfinished downloads or uploads and temporary files. Unchanged files SHALL be hard-linked to the previous snapshot on the same target so that each snapshot stays complete while only new data takes space.

#### Scenario: Second night
- **WHEN** a backup runs again after one family file changed
- **THEN** the changed file is copied, every other family file in the new snapshot shares its data with the previous snapshot, and both snapshots pass a full verification

#### Scenario: Older snapshot pruned
- **WHEN** retention removes the older snapshot
- **THEN** the newer one still passes a full verification

### Requirement: Consistent media server copy
The media server's configuration and database SHALL be copied while it is stopped through the supervisor and SHALL be started again afterwards, also when the copy fails; metadata images, cache and transcodes SHALL be skipped. When it cannot be paused, the copy SHALL still be made and the run SHALL say so.

#### Scenario: Paused for the copy
- **WHEN** a backup runs while Jellyfin runs under the supervisor
- **THEN** Jellyfin is stopped, its config and database are copied, and it is started again

### Requirement: Clear message when a drive is too small
When a target lacks room for the new data, that target SHALL fail with the free and required space and advice to remove old snapshots or use a bigger drive, while other targets continue.

#### Scenario: Flash drive full
- **WHEN** the flash drive has less free space than the new data
- **THEN** its result is an error naming the sizes and the advice, and the main disk copy is still written
