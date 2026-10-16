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
