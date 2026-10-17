# portal-runtime delta

## MODIFIED Requirements

### Requirement: Graceful start and stop on Windows
The project SHALL provide documented commands to build, start in the background, check status and stop the server. Start and stop SHALL go through the supervisor when it is in use; stopping SHALL end the server cleanly and release the port. Every data change SHALL be written to disk atomically when it happens, so a forced stop loses at most the last-activity time of sessions from the last minute.

#### Scenario: Stop
- **WHEN** the owner runs the stop command
- **THEN** the server process exits and the port is released
- **AND** data saved before the stop is intact; only session last-activity times from the last minute may be lost

#### Scenario: Interrupted write
- **WHEN** the server starts and the data directory holds a temporary file left by an atomic write cut off by a forced stop
- **THEN** the server removes that file and keeps the last complete version of the data file

#### Scenario: Ctrl+C in development mode
- **WHEN** the developer presses Ctrl+C in the terminal where the server runs in the foreground (`npm.cmd start`, `npm.cmd run dev:server`)
- **THEN** the server closes gracefully: pending writes are flushed and the port is released

#### Scenario: Clean stop under the supervisor
- **WHEN** the owner runs `scripts\stop.cmd` while the supervisor runs the portal
- **THEN** the portal receives the IPC shutdown message, exits with code 0 and the supervisor exits too

## ADDED Requirements

### Requirement: Autostart and crash recovery
The family server SHALL start by itself after Windows starts, without a stored Windows password and without a visible window, and SHALL restart its programs after a crash or a hang. Exactly one supervisor SHALL run per data directory. A stop by the owner SHALL hold until the next start command or reboot. Autostart SHALL be removable with one command.

#### Scenario: Crash
- **WHEN** the portal process exits unexpectedly
- **THEN** the supervisor logs the exit and starts it again after a back-off of at most 60 s

#### Scenario: Hang
- **WHEN** a running program fails its health check 3 times in a row after the start-up grace period
- **THEN** the supervisor restarts it

#### Scenario: Second instance
- **WHEN** another supervisor is started for the same data directory (e.g. by the 5-minute watchdog trigger)
- **THEN** it exits at once without starting programs

#### Scenario: Stopped by the owner
- **WHEN** the watchdog trigger fires after `scripts\stop.cmd` and before a reboot or `scripts\start.cmd`
- **THEN** nothing is started
