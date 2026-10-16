# Spec Delta

## Purpose

Определяет, как портал запускается и останавливается на Windows-ПК, на каких адресах он доступен по умолчанию и какие базовые сетевые меры безопасности действуют для всех ответов.

## ADDED Requirements

### Requirement: Loopback by default
The server SHALL listen on `127.0.0.1` by default. Listening on other interfaces SHALL require an explicit configuration change documented together with the firewall implications.

#### Scenario: Default start
- **WHEN** the server starts without a HOST setting
- **THEN** it accepts connections only on the loopback interface

### Requirement: Public health probe
`GET /api/health` SHALL respond without authentication with status, version and time only.

#### Scenario: Health check
- **WHEN** a monitoring script calls `/api/health`
- **THEN** it receives HTTP 200 with `status: "ok"` and no system details

### Requirement: Security headers and caching
All responses SHALL carry a restrictive Content-Security-Policy (self only, no inline scripts), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`. API responses SHALL be `Cache-Control: no-store`. Request bodies SHALL be limited to 64 KiB.

#### Scenario: Oversized body
- **WHEN** a client posts a body larger than 64 KiB
- **THEN** the server responds 413 without processing it

### Requirement: SPA routing and missing build
Non-API GET requests for unknown paths SHALL return the app shell so deep links work; unknown `/api/*` paths SHALL return a JSON 404. If the frontend has not been built, the server SHALL still serve the API and explain how to build the UI.

#### Scenario: Deep link
- **WHEN** a browser opens `/system` directly
- **THEN** the app shell is returned with status 200

### Requirement: Graceful start and stop on Windows
The project SHALL provide documented commands to build, start in the background, check status and stop the server; stopping SHALL close the listener and flush data files.

#### Scenario: Stop
- **WHEN** the owner runs the stop command
- **THEN** the server process exits and the port is released

### Requirement: Private remote access only
Remote access SHALL be provided only through the private tailnet (Tailscale Serve HTTPS to the loopback port). The project SHALL NOT enable Tailscale Funnel, router port forwarding or firewall changes.

#### Scenario: Tailnet access
- **WHEN** a family device on the tailnet opens `https://server-home.tail89d77e.ts.net`
- **THEN** it reaches the portal over HTTPS, while the address is not reachable from the public internet
