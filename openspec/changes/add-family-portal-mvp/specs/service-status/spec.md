# Spec Delta

## Purpose

Показывает семье, какие домашние сервисы (кинотеатр, фото, файлы, загрузки и др.) установлены и доступны прямо сейчас, по результатам реальных сетевых проверок, а не по статичным индикаторам.

## ADDED Requirements

### Requirement: Admin-controlled service registry
The list of services SHALL come from a configuration file in the data directory that only the server owner edits. Each service has an id, kind, Russian name and description, an optional open URL, an optional health URL and an enabled flag. A missing file SHALL be created from built-in defaults where every service is not configured.

#### Scenario: Fresh install
- **WHEN** the server starts and the services file does not exist
- **THEN** it is created with default entries for media, photos, files, downloads and calendar, all without URLs
- **AND** there is no print entry: the printer state comes from the system-status printer probe

### Requirement: Honest service states
Each service SHALL report exactly one state: `online` (health check answered 2xx/3xx within the timeout), `degraded` (answered 4xx/5xx), `offline` (connection error or timeout), `not_configured` (no URL), `disabled` (switched off), or `unknown` (configured but not yet checked). The UI SHALL never show a service as available unless its state is `online`.

#### Scenario: Service not installed
- **WHEN** a service has no URL configured
- **THEN** its state is `not_configured`, `openUrl` is null and `hint` explains what to install

#### Scenario: Service down
- **WHEN** the health URL refuses the connection or does not answer within 3 seconds
- **THEN** the state is `offline`, `checkedAt` is set and the message says the service does not respond

### Requirement: Bounded, periodic checks
Health checks SHALL run in the background at a configurable interval (default 60 s), each with a timeout (default 3 s), and SHALL NOT follow redirects to other hosts. A manual refresh SHALL be available to admins and rate-limited.

#### Scenario: Manual refresh flood
- **WHEN** an admin triggers refresh twice within 10 seconds
- **THEN** the second request returns 429 and no extra checks run

### Requirement: Safe open links
`openUrl` SHALL only ever be an `http:` or `https:` URL from the configuration; any other scheme SHALL make the service `not_configured` with an explanatory message.

#### Scenario: Dangerous scheme in config
- **WHEN** the configuration contains `javascript:` as a service URL
- **THEN** the service is reported as `not_configured` and the URL is never sent to the browser

### Requirement: Clearly labelled demo data
In demo mode every service status SHALL carry `demo: true`; outside demo mode `demo` SHALL be false and no fabricated state SHALL be produced.

#### Scenario: Demo disabled
- **WHEN** the server runs without demo mode
- **THEN** every service state comes from configuration and real checks only
