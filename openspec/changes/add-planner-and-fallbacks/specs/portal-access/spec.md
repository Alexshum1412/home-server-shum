# portal-access delta

## ADDED Requirements

### Requirement: Accounts are managed from the portal with generated passwords
Administrators SHALL add users, issue a new temporary password, change rights and role, and remove users in the portal. Passwords SHALL be generated and shown once; an administrator SHALL NOT choose or read another person's password. An administrator SHALL NOT remove or demote themselves or the last administrator.

#### Scenario: New person
- **WHEN** an administrator creates an account
- **THEN** a temporary password is shown once, only its hash is stored and the audit journal does not contain it

#### Scenario: Last administrator
- **WHEN** the only administrator is asked to be removed or demoted
- **THEN** the server refuses and nothing changes

### Requirement: Opt-in listener in the home network
The portal SHALL listen only on the loopback address unless the owner sets `LAN_BIND` to private addresses of the home network, in which case it SHALL listen on those addresses in addition, never on all interfaces. The configured address SHALL be shown to users only while the portal really listens on it.

#### Scenario: Public address refused
- **WHEN** `LAN_BIND` is `0.0.0.0` or a public address
- **THEN** the configuration is rejected with an explanation

#### Scenario: Foreign host name
- **WHEN** a request to the home-network address carries another `Host`
- **THEN** it is answered 421
