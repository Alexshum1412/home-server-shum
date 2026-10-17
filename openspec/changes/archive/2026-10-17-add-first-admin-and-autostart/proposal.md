# Proposal

## Why

Stage P1 of the owner's brief (1.txt, section 6) is not finished:

- no administrator account exists yet;
- the portal does not start by itself after a reboot;
- after a crash nobody restarts it.

The brief forbids a default password in the sources. It asks for a random strong password that is handed to the owner once and kept nowhere. The brief also asks for an autostart that:

- does not start a second copy;
- restarts after a failure;
- stops cleanly;
- logs errors;
- can be switched off.

## What Changes

- **Temporary password for a new account.** `scripts\user.cmd add|passwd ... --generate-password` creates a random temporary password (about 116 bits).
  - It is shown once and expires after 7 days.
  - It works only for the first sign-in. Until the user chooses an own password, the server refuses every API except the session probe, the password change and logout.
- **Password change in the portal.** Any signed-in user can change the own password: `POST /api/password` and the page «Мой профиль».
  - The current password is verified.
  - Guesses of the current password count against the sign-in limit.
  - The change ends the user's other sessions.
- **Supervisor** (`server/src/supervisor/`). It runs the portal and later Jellyfin, which are fixed in code:
  - restarts with back-off after a crash, and after 3 failed health checks (a hang);
  - stops cleanly over IPC or the app's API;
  - allows a single instance through a named pipe;
  - keeps its own log and a state file.
- **Scheduler task «FamilyServer».** It starts the supervisor in S4U mode (no stored password, no window) at boot, at logon and every 5 minutes as a watchdog.
  - `scripts\stop.cmd` holds everything off until `start.cmd` or the next reboot.
  - `scripts\autostart.cmd -Off` removes the task.

## Capabilities

### Modified Capabilities

- `portal-access`:
  - the first administrator can get a generated temporary password;
  - temporary passwords must be replaced before the portal opens;
  - self-service password change is added.
- `portal-runtime`: start and stop go through the supervisor; autostart and crash recovery are added.

## Impact

- **Code:**
  - `server/src/auth/{users,passwords,guards,routes}.ts`, `server/src/cli/users.ts`, `server/src/admin/routes.ts`, `shared/api.ts`;
  - `server/src/supervisor/*`, `server/src/index.ts` (IPC shutdown);
  - web: `PasswordForm`, `Account`, `ForcedPassword`, app routing.
- **Scripts:** `scripts/{start,stop,status,autostart,common}.ps1`.
- **System:** one scheduler task under the owner's account (S4U, limited rights). Firewall, UAC and Tailscale settings are unchanged.
