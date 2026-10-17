# admin-tools Specification

## Purpose

Даёт администратору минимальные безопасные средства наблюдения: кто входил и что делал, какие есть учётные записи, и технический отчёт без секретов для диагностики.

## Requirements

### Requirement: Audit log
The server SHALL append an audit entry for sign-in success and failure, logout, rate-limit blocks, manual service refresh and diagnostics export. Entries SHALL never contain passwords, tokens, cookies or file contents. Admins SHALL be able to read the most recent entries.

#### Scenario: Admin reviews log
- **WHEN** an admin opens the audit view
- **THEN** recent entries are shown newest first with time, action, actor and client address

### Requirement: User management from the server console
Users SHALL be created, listed, have passwords changed, and be removed only via a CLI on the server; passwords SHALL be entered without echo and SHALL have a minimum length of 10 characters. The admin UI SHALL list users read-only.

#### Scenario: Add a family member
- **WHEN** the owner runs the CLI add command with a username, display name and role and enters a password twice
- **THEN** the user can sign in, and the CLI never prints the password or its hash

### Requirement: Diagnostics export without secrets
Admins SHALL be able to download a JSON diagnostics report with app version, Node version, effective non-secret configuration, current system and service status.

#### Scenario: Export
- **WHEN** an admin downloads diagnostics
- **THEN** the file contains no password hashes, session tokens or cookies, and an audit entry is written

### Requirement: No command execution from the UI
The admin area SHALL NOT offer arbitrary shell commands, file browsing, or service restarts in this version.

#### Scenario: Admin API surface
- **WHEN** the admin API is enumerated
- **THEN** it exposes only read-only endpoints plus the rate-limited service refresh

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
