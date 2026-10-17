# system-status delta

## ADDED Requirements

### Requirement: Programs and overall level
The system status SHALL include the programs run by the supervisor (state and restarts), trusted only while the supervisor process is alive, and one overall level — `ok`, `warning`, `error` or `unknown` — derived from the alerts the user can see and from whether core measurements exist.

#### Scenario: Jellyfin crash loop
- **WHEN** the supervisor reports Jellyfin in back-off
- **THEN** every user sees a critical alert «перезапускается после сбоя» and the overall level is `error`

#### Scenario: Stale supervisor file
- **WHEN** run/supervisor.json names a process that no longer exists
- **THEN** programs are reported as unknown with a reason and the admin gets a «Супервизор не запущен» warning
