# service-status delta

## ADDED Requirements

### Requirement: Built-in features
A service entry marked `builtin` is a feature of the portal itself and SHALL be reported `online` whenever the portal answers, without a separate health check.

#### Scenario: Downloads on a fresh install
- **WHEN** services.json is created from the defaults
- **THEN** «Загрузки» is `online` with the message «Работает (часть портала)» while other services are `not_configured`
