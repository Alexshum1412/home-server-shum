# portal-access delta

## ADDED Requirements

### Requirement: Per-user rights
Besides the role, a family member MAY be granted extra rights (`downloads`, `print`) on the server with `scripts\user.cmd allow|deny`. Admins SHALL have every right. Rights SHALL be checked by the server on every request that needs them and SHALL be part of the session information.

#### Scenario: Right granted
- **WHEN** the owner runs `scripts\user.cmd allow mama downloads`
- **THEN** mama's session lists `downloads` and the download queue accepts her requests
