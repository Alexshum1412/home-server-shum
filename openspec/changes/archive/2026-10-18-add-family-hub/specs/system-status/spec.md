## ADDED Requirements

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
