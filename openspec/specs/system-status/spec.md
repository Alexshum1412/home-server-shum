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
Until a backup job reports a successful run, backup state SHALL be `not_configured` and an alert SHALL say so. `restoreTested` SHALL be true only after a recorded restore test.

#### Scenario: No backup configured
- **WHEN** no backup status record exists
- **THEN** backup state is `not_configured`, `restoreTested` is false, and a warning alert is shown to everyone

### Requirement: Safe system probes
System probes SHALL run only fixed, allowlisted read-only commands with no user-provided arguments, each with a timeout, and SHALL be cached so client polling cannot multiply system load.

#### Scenario: Probe hangs
- **WHEN** a system probe does not finish within its timeout
- **THEN** it is terminated, its values become `null` with a reason, and the rest of the response is still returned
