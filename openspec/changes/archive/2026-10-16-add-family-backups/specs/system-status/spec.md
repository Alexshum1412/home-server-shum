# Spec Delta

## MODIFIED Requirements

### Requirement: Backup status is never assumed
Until a backup job reports a successful run, backup state SHALL be `not_configured` and an alert SHALL say so. `restoreTested` SHALL be true only after a recorded restore test. When the status record lists targets, a successful run SHALL be shown with the time of the last copy and a yes/no summary for every target, and a run where any target failed SHALL make the state `failed` with a critical alert for everyone and the reason for each failed target.

#### Scenario: No backup configured
- **WHEN** no backup status record exists
- **THEN** backup state is `not_configured`, `restoreTested` is false, and a warning alert is shown to everyone

#### Scenario: Successful backup with target summary
- **WHEN** the last run succeeded on the main disk and on the flash drive «reserve» less than 8 days ago
- **THEN** backup state is `ok` and the message reads «Последняя копия <дата время>: основной диск — да, флешка «reserve» — да.», and no backup alert is shown

#### Scenario: One target failed
- **WHEN** the last run wrote the main disk but the flash drive «reserve» was not connected
- **THEN** backup state is `failed`, the message lists «основной диск — да, флешка «reserve» — нет» with the reason, and a critical alert «Резервное копирование не удалось» is shown to everyone
