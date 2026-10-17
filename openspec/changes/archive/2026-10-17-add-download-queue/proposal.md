# Proposal

## Why

Stage P3 of the owner's brief: family members should be able to queue a file for download on the home server and pick it up later. The queue must have its own rights, a confirmation step, restricted destinations, pause/resume/cancel, progress, disk limits, no command execution and lawful use only.

## What Changes

- Per-user rights (`downloads`, `print`), granted with `scripts\user.cmd allow|deny`; admins have all rights.
- A download queue inside the portal for direct HTTP(S) links, with a two-step check/confirm flow, an SSRF guard on every connection and redirect, per-user folders, blocked program types, Mark of the Web, size and free-space limits, pause/resume (Range + If-Range), cancel, restart recovery and audit entries.
- Built-in portal features are shown as available in the service registry (`builtin: true`).
- The «Загрузки» page replaces the placeholder.

## Capabilities

### New Capabilities
- `downloads`: the download queue.

### Modified Capabilities
- `portal-access`: per-user rights.
- `service-status`: built-in features.

## Impact

- New: `server/src/downloads/{net-guard,manager,routes}.ts`, `server/src/files/names.ts`, `web/src/pages/Downloads.tsx`.
- Changed: users store and CLI (`permissions`), session/admin API, config (`FAMILY_FILES_DIR`, `FAMILY_PHOTOS_DIR`, `DOWNLOAD_MAX_FILE_GB`, `MIN_FREE_GB`), services registry.
- Data: `downloads.json` in the data dir; files under `C:\FamilyData\Files\users\<login>\Загрузки`.
