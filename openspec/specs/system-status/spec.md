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

### Requirement: Programs and overall level
The system status SHALL include the programs run by the supervisor (state and restarts), trusted only while the supervisor process is alive, and one overall level — `ok`, `warning`, `error` or `unknown` — derived from the alerts the user can see and from whether core measurements exist.

#### Scenario: Jellyfin crash loop
- **WHEN** the supervisor reports Jellyfin in back-off
- **THEN** every user sees a critical alert «перезапускается после сбоя» and the overall level is `error`

#### Scenario: Stale supervisor file
- **WHEN** run/supervisor.json names a process that no longer exists
- **THEN** programs are reported as unknown with a reason and the admin gets a «Супервизор не запущен» warning

### Requirement: Hardware details are measured, administrator-only and honest
The administrator's status page SHALL show the load of every processor core, the clock, the video card, network speed per connection and the counters each drive reports about itself. Every part SHALL be a measurement with its time or «Недоступно» with a reason, never zero; the processor temperature SHALL come only from a sensor program and the motherboard zone SHALL NOT be presented as the processor's temperature. Other people SHALL NOT receive these details.

#### Scenario: No sensor program
- **WHEN** no sensor program is connected
- **THEN** the processor temperature says it is unavailable and how to get it

#### Scenario: A counter that went back
- **WHEN** a network counter is lower than the previous reading
- **THEN** no speed is shown for that reading

### Requirement: A failing drive is not poked
A drive that identifies itself with a firmware-failure name SHALL be listed without asking it for counters.

#### Scenario: The broken Seagate
- **WHEN** a drive is named like `ST_M13FQBL`
- **THEN** its counters are not queried and the page shows «Недоступно»

### Requirement: A day of history
The server SHALL keep one reading a minute for a day, survive a restart without losing it, ignore a clock that went back, and show a gap rather than a zero for a missing value; only the administrator SHALL read it.

#### Scenario: Restart
- **WHEN** the server restarts
- **THEN** the readings of the last day are still there

### Requirement: Problems reach the administrators once
A confirmed problem (a full drive, a failed backup, a stopped program, overheating by a real sensor, a drive reporting errors) SHALL be announced to administrators only after it was seen twice in a row, once, with a reminder after a day while it lasts, and again if it went away and came back.

#### Scenario: A slow probe
- **WHEN** a problem appears in only one check
- **THEN** nobody is notified
