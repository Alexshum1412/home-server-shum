## ADDED Requirements

### Requirement: A second address reaches ordinary features only
When a public HTTPS address is configured, requests that arrive through it (by the name they were sent to, or by the headers of the tunnel's edge) SHALL reach only the routes on an explicit allow-list of everyday family features. Everything not on the list, including administration, service control, printing, diagnostics, starting or controlling downloads and film streaming (unless the owner allowed it), SHALL be refused with 403.

#### Scenario: Administration through the public address
- **WHEN** a signed-in person requests an administration route through the public address
- **THEN** the server answers 403 `channel_restricted`

#### Scenario: A route added later
- **WHEN** a new API route is not on the allow-list
- **THEN** it is refused through the public address until it is listed on purpose

#### Scenario: A forged tunnel header at home
- **WHEN** a person on the private network sends a tunnel header on purpose
- **THEN** only that request becomes more restricted

### Requirement: The administrator does not sign in through the public address
By default an administrator's correct password through the public address SHALL be refused with `admin_not_public`, while a wrong password SHALL get the ordinary failure answer; sign-in attempts through the public address SHALL be counted apart from the private ones; the session cookie there SHALL always be `Secure`.

#### Scenario: Administrator at the public address
- **WHEN** the administrator enters the correct password through the public address
- **THEN** no session is created and the answer says the administrator signs in over Tailscale or the home network

#### Scenario: Strangers do not lock the family out
- **WHEN** many wrong passwords are tried through the public address for a family member
- **THEN** that member can still sign in from the private network

### Requirement: The public address must be a real name
The configured public address SHALL be an `https://` name with a domain; an IP address, a home-network name or a Tailscale name SHALL be refused at start-up, and a request carrying any other name SHALL be refused with 421.

#### Scenario: A Tailscale name as the public address
- **WHEN** `PUBLIC_HTTPS_URL` is a `*.ts.net` address
- **THEN** the configuration is rejected
