# Design

## Temporary password

- **Where it is stored.** `users.json` gets two optional fields: `mustChangePassword` and `passwordExpiresAt`. Older files stay valid.
  - The password itself is never stored. The CLI prints it once, and only its scrypt hash is written.
- **Format.** Four groups of five characters from a 56-character alphabet with no look-alikes (0/O, 1/l/I). That gives about 116 bits from `crypto.randomInt`, and the password can be typed from a phone screen.
- **Expiry check.** The expiry is checked only after the password matched (403 `temporary_password_expired`). A wrong password still gets the generic 401, so an outsider learns nothing.
- **Guards.**
  - `requireUser` and `requireAdmin` answer 403 `password_change_required` to a user with a temporary password.
  - `requireSignedIn` lets that user reach only `GET /api/session` and `POST /api/password`. Logout needs no guard.
- **Server writes to users.json.** The password change is the first place where the server writes `users.json`. Until now only the CLI did.
  - The store re-reads the file inside its serial queue before writing.
  - The remaining risk is a CLI change made in the same millisecond, which can be lost. It is accepted and documented.
- **Status code for a wrong current password.** It is 400 `wrong_password`, not 401: the web client treats any 401 as "session gone" and signs out.

## Supervisor instead of a Windows service

Options considered:

1. **Logon task that starts `start.ps1`** (the old way): no restart after a crash, and nothing runs before sign-in.
2. **A Windows service** (NSSM/WinSW): a third-party binary running as LocalSystem; the brief asks to avoid dubious process managers.
3. **Task Scheduler with an S4U principal plus a small supervisor in the project's own code** (chosen).
   - It runs as the owner's account with limited rights, before sign-in, without a stored password and without a console window.
   - The supervisor code is about 400 lines, reviewed and unit-tested.

Behaviour of option 3:

- **Single instance.** A named pipe `\\.\pipe\family-server-supervisor-<hash of data dir>` is the lock and the control channel. A second instance finds the pipe taken and exits 0. The 5-minute trigger is therefore a safe watchdog: `MultipleInstances=IgnoreNew` covers the task, and the pipe covers manual starts.
- **Restarts.** Back-off of 1 s, then 2, 4 … up to 60 s. It resets after 2 minutes of stable running. Three failed health checks in a row after the start-up grace period count as a hang, and the app is restarted.
- **Clean stop.**
  - The portal gets the IPC message `{type:'shutdown'}`; Windows has no SIGTERM.
  - Jellyfin gets `POST /System/Shutdown` with an API key from the data directory.
  - After the timeout the app is killed.
- **Respecting the owner's stop.** `shutdown` writes `run/supervisor-stopped.json`. The supervisor exits at once while that file is newer than the boot time, so the watchdog does not undo `scripts\stop.cmd`.
- **Known limit.** Tailscale on Windows connects only after a user signs in, unless the owner enables Unattended mode. Before sign-in the portal runs, but it is reachable only on the PC itself.
