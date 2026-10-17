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
