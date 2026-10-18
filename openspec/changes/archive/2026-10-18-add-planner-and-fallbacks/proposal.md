# Proposal

## Why

The owner's brief for the last stage asks for three things that were not done:

- extensions that fit the PC: a family calendar with shared notes, and audiobooks (P10);
- two working ways for every important function, so that one failure never leaves the family stuck;
- the findings of the UI audit (P8) and a security pass over the trust boundaries (P9).

No new program may be installed for this: the PC has no Python, Docker or WSL, and little memory to spare.

## What Changes

- **Planner.** A family calendar (shared and private events, repeats, `.ics` export) and notes (plain `.txt` files in the «Заметки» folder of the family storage) built into the portal. Today's events appear on the home page.
- **Audiobooks.** A Jellyfin library «Аудиокниги» in the existing media folder.
- **Fallbacks.**
  - A read-only media player in the portal that plays the library files when Jellyfin is down.
  - `scripts\import.cmd` and `export.cmd`: files and photos in and out of the storage without the browser.
  - `scripts\lan-mode.cmd` and `LAN_BIND`: an opt-in portal address in the home network for a home without internet.
  - A waiting queue for printing when the printer is off (only by the user's explicit choice).
  - `scripts\doctor.cmd` and `service.cmd`: diagnosis and manual control that work without the portal.
  - An optional local language model for «Оливия» that only re-words a finding.
- **Accounts.** Administrators add people, issue a new temporary password, change rights and remove users in the portal; `user.cmd` stays as the second way.
- **UI.** Folder, space and month live in the address; results of actions appear in a fixed toast; the photo viewer shows the photo that matches its title; uploads show progress and warn before the page is closed; wide tables become cards on phones.

## Capabilities

### New Capabilities

- `family-planner`: calendar and notes.

### Modified Capabilities

- `portal-access`: accounts are managed from the portal; an opt-in home-network listener.
- `admin-tools`: user management, independent diagnosis, optional local model for «Оливия».
- `media-server`: audiobooks and the fallback player.
- `printing`: a waiting queue when the printer does not answer.
- `family-storage`: import and export without the browser.
- `portal-ui`: folder state in the address and the toast.

## Impact

- **Code:** `server/src/{planner,media,lan.ts,cli/transfer.ts,cli/doctor.ts,files/transfer.ts,olivia/llm.ts,print/queue.ts,admin/routes.ts}`, `shared/api.ts`, web pages and components for the same.
- **Scripts:** `lan-mode`, `import`, `export`, `doctor`, `service`.
- **System:** one Jellyfin library added through its API. Firewall, UAC and Tailscale are not changed by the project; `lan-mode.cmd on` changes the firewall only when the owner runs it.
