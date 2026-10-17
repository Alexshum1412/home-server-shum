# service-status delta

## MODIFIED Requirements

### Requirement: Honest service states
Each service SHALL report exactly one state: `online` (health check answered 2xx/3xx within the timeout), `degraded` (answered 4xx/5xx), `offline` (connection error or timeout), `not_configured` (no URL), `disabled` (switched off), or `unknown` (configured but not yet checked). The UI SHALL never show a service as available unless its state is `online`. When a service names a supervised program and its check fails, the message SHALL say whether the program was stopped, is starting or is being restarted after a crash.

#### Scenario: Service not installed
- **WHEN** a service has no URL configured
- **THEN** its state is `not_configured`, `openUrl` is null and `hint` explains what to install

#### Scenario: Service down
- **WHEN** the health URL refuses the connection or does not answer within 3 seconds
- **THEN** the state is `offline`, `checkedAt` is set and the message says the service does not respond

#### Scenario: Supervised program stopped
- **WHEN** the health check of a service with `process: "jellyfin"` fails and the supervisor reports that program as `stopped`
- **THEN** the state is `offline`, the message is «Остановлен» and only admins see the supervisor state in `detail`
