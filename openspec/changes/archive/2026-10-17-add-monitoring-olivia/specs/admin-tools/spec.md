# admin-tools delta

## ADDED Requirements

### Requirement: Rule-based assistant
The admin area SHALL offer «Оливия»: findings computed by fixed rules from measured data, each with a plain explanation and advice. It SHALL never delete data, run shell commands or take commands from text, and `OLIVIA_ENABLED=0` SHALL switch it off without affecting monitoring.

#### Scenario: Switched off
- **WHEN** `OLIVIA_ENABLED=0`
- **THEN** the assistant API answers 404 and `/api/system` still works

### Requirement: Allowlisted, confirmed and logged actions
The assistant MAY offer only actions from a fixed list in code. An action SHALL run only when it applies to the current state, only with an explicit confirmation and at most once per 30 seconds; every attempt SHALL be written to the audit log.

#### Scenario: Unknown action
- **WHEN** an admin posts to `/api/admin/olivia/actions/restart-jellyfin;calc`
- **THEN** the server answers 404 and nothing runs

#### Scenario: Not applicable
- **WHEN** an admin confirms «Запустить кинотеатр» while Jellyfin is running
- **THEN** the server answers 409 and the refusal is logged
