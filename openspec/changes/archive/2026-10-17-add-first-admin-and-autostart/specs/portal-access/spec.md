# portal-access delta

## MODIFIED Requirements

### Requirement: First administrator is created on the server
The portal SHALL NOT allow creating accounts from the browser. When no users exist, the login screen SHALL explain the exact command to run on the server to create the first administrator. The server-side command SHALL be able to generate a random temporary password instead of asking for one; the sources SHALL contain no default password.

#### Scenario: No users yet
- **WHEN** `GET /api/setup-state` is called and the user store is empty
- **THEN** the response contains `hasUsers: false` and the CLI command to create an admin

#### Scenario: Generated first password
- **WHEN** the owner runs `scripts\user.cmd add <login> --role admin --generate-password`
- **THEN** a random password of at least 100 bits is printed once, only its scrypt hash is stored, and the account is marked to change it within 7 days

## ADDED Requirements

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
