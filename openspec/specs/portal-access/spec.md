# portal-access Specification

## Purpose

Определяет, кто и как входит в семейный портал, какие роли существуют и как сервер защищает сессии и учётные записи от перебора и подделки запросов.

## Requirements

### Requirement: Account-based sign-in
The portal SHALL require sign-in with a username and password for every page and API except the public health probe, the setup-state probe, the login endpoint and static assets. Passwords SHALL be stored only as salted scrypt hashes.

#### Scenario: Correct credentials
- **WHEN** a user submits a valid username and password to `POST /api/login`
- **THEN** the server responds 200 with the session user (id, username, displayName, role) and sets an HttpOnly, SameSite=Strict session cookie

#### Scenario: Wrong password
- **WHEN** a user submits a wrong password or unknown username
- **THEN** the server responds 401 with the same generic Russian message for both cases and records `login.failure` in the audit log without the password

#### Scenario: Anonymous API access
- **WHEN** a request without a valid session calls a protected API such as `GET /api/services`
- **THEN** the server responds 401 with a JSON error body

### Requirement: First administrator is created on the server
The portal SHALL NOT allow creating accounts from the browser. When no users exist, the login screen SHALL explain the exact command to run on the server to create the first administrator. The server-side command SHALL be able to generate a random temporary password instead of asking for one; the sources SHALL contain no default password.

#### Scenario: No users yet
- **WHEN** `GET /api/setup-state` is called and the user store is empty
- **THEN** the response contains `hasUsers: false` and the CLI command to create an admin

#### Scenario: Generated first password
- **WHEN** the owner runs `scripts\user.cmd add <login> --role admin --generate-password`
- **THEN** a random password of at least 100 bits is printed once, only its scrypt hash is stored, and the account is marked to change it within 7 days

### Requirement: Roles enforced on the server
Every signed-in user SHALL have exactly one role, `family` or `admin`. Admin-only APIs SHALL return 403 to `family` users regardless of what the UI shows.

#### Scenario: Family user calls an admin API
- **WHEN** a `family` user calls `GET /api/admin/audit`
- **THEN** the server responds 403 and the audit log is not returned

### Requirement: Session lifetime and logout
Sessions SHALL expire after 30 days of inactivity, survive a server restart, and be revocable by logout. Session tokens SHALL be random (≥256 bits) and stored only as hashes.

#### Scenario: Logout
- **WHEN** a signed-in user calls `POST /api/logout`
- **THEN** the session is deleted on the server, the cookie is cleared, and the next protected request returns 401

#### Scenario: Server restart
- **WHEN** the server restarts while a user has a valid session
- **THEN** the user remains signed in

### Requirement: Brute-force protection
The login endpoint SHALL limit failed attempts per username and per client address and answer 429 with a Russian message and retry time once the limit is reached.

#### Scenario: Too many failures
- **WHEN** more than 10 failed logins for the same username happen within 15 minutes
- **THEN** further attempts for that username are rejected with 429 until the window passes, even with the correct password

### Requirement: Cross-site request protection
State-changing requests (POST/PUT/PATCH/DELETE) SHALL be accepted only with a JSON content type and from the portal's own origin.

#### Scenario: Foreign origin
- **WHEN** a POST arrives with an `Origin` header that does not match the portal host
- **THEN** the server responds 403 and performs no action

### Requirement: Temporary password must be replaced
A user signed in with a generated (temporary) password SHALL be able to use only the session probe, the password change and logout until an own password is set. An expired temporary password SHALL NOT sign in.

#### Scenario: Portal locked until the password is changed
- **WHEN** a user with a temporary password signs in and calls `GET /api/services`
- **THEN** the sign-in succeeds with `mustChangePassword: true` and the call is answered 403 `password_change_required`

#### Scenario: Expired temporary password
- **WHEN** the correct temporary password is used after its expiry time
- **THEN** the server answers 403 `temporary_password_expired` and creates no session, while a wrong password still gets the generic 401

### Requirement: Own password change
Every signed-in user SHALL be able to change the own password in the portal after confirming the current one. Wrong current passwords SHALL count against the sign-in limit. A change SHALL end all other sessions of the user and keep the current device signed in.

#### Scenario: Password changed
- **WHEN** a user posts the correct current password and a valid new one to `POST /api/password`
- **THEN** the new password works, the old one does not, other sessions answer 401 and this device gets a fresh session cookie

#### Scenario: Wrong current password
- **WHEN** the current password is wrong
- **THEN** the server answers 400 `wrong_password`, nothing changes and the user stays signed in

### Requirement: Per-user rights
Besides the role, a family member MAY be granted extra rights (`downloads`, `print`) on the server with `scripts\user.cmd allow|deny`. Admins SHALL have every right. Rights SHALL be checked by the server on every request that needs them and SHALL be part of the session information.

#### Scenario: Right granted
- **WHEN** the owner runs `scripts\user.cmd allow mama downloads`
- **THEN** mama's session lists `downloads` and the download queue accepts her requests

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
