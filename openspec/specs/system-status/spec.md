# system-status Specification

## Purpose

Даёт семье и администратору достоверную картину состояния домашнего ПК — нагрузку, место на дисках, здоровье накопителей, удалённый доступ, принтер и резервные копии — только из реальных источников и с указанием времени измерения.

## Requirements

### Requirement: Measured values with provenance
Every system value SHALL include when it was collected and its source. A value that cannot be measured SHALL be `null` with a Russian reason; `null` SHALL never be rendered as `0`.

#### Scenario: Temperature sensor unavailable
- **WHEN** no supported temperature source exists on the machine
- **THEN** `temperatureC.value` is null and `reason` explains that the sensor is unavailable

### Requirement: Resource metrics
The server SHALL report CPU model, core count and recent average utilisation, total and used memory, server uptime, and total/free bytes for each configured volume with a low-space flag (default threshold 10 % free).

#### Scenario: Low disk space
- **WHEN** a configured volume has less free space than the threshold
- **THEN** the volume is flagged `lowSpace` and an alert is produced

### Requirement: Physical disk health
On Windows the server SHALL read physical disks through a fixed read-only system query and map Windows health to `healthy / warning / unhealthy / unknown`. A disk whose reported identity looks like a firmware or failure state (for example model `ST_M13FQBL` with only a few GB) SHALL be flagged as a warning with a note.

#### Scenario: Suspicious second disk
- **WHEN** Windows reports a disk with model matching a Seagate firmware identity and a capacity under 16 GB
- **THEN** that disk is shown with health `warning`, a Russian note, and an alert advising not to initialise or format it

### Requirement: Remote access status
The server SHALL report the Tailscale backend state using the local Tailscale CLI with fixed arguments and a timeout. Device names and counts SHALL be visible to admins only.

#### Scenario: Tailscale stopped
- **WHEN** the Tailscale backend is not running
- **THEN** the state is not `running` and an alert says remote access from other countries does not work

### Requirement: Printer status from Windows
The server SHALL report the state of the configured (or default) printer as Windows reports it, and SHALL NOT invent ink, toner or paper levels.

#### Scenario: Printer idle
- **WHEN** Windows reports the printer as idle
- **THEN** the printer state is `ready` with a message noting the data comes from Windows

### Requirement: Backup status is never assumed
Until a backup job has run at least once, backup state SHALL be `not_configured` with an alert; a recorded failed run SHALL be `failed`, never `not_configured`. `restoreTested` SHALL be true only after a recorded restore test. A successful run SHALL show the time of the last copy and a yes/no summary per target; a run where any target failed SHALL show `failed` with a critical alert naming each failed target.

#### Scenario: No backup configured
- **WHEN** no backup status record exists
- **THEN** backup state is `not_configured`, `restoreTested` is false, and a warning alert is shown to everyone

#### Scenario: Successful backup with target summary
- **WHEN** the last run succeeded on the main disk and on the flash drive «reserve» less than 8 days ago
- **THEN** backup state is `ok` and the message reads «Последняя копия <дата время>: основной диск — да, флешка «reserve» — да.», and no backup alert is shown

#### Scenario: One target failed
- **WHEN** the last run wrote the main disk but the flash drive «reserve» was not connected
- **THEN** backup state is `failed`, the message lists «основной диск — да, флешка «reserve» — нет» with the reason, and a critical alert «Резервное копирование не удалось» is shown to everyone

### Requirement: Safe system probes
System probes SHALL run only fixed, allowlisted read-only commands with no user-provided arguments, each with a timeout, and SHALL be cached so client polling cannot multiply system load.

#### Scenario: Probe hangs
- **WHEN** a system probe does not finish within its timeout
- **THEN** it is terminated, its values become `null` with a reason, and the rest of the response is still returned
