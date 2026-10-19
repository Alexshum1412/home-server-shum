# Proposal

## Why

The owner's brief of 19.10.2026 asks to continue from the working portal and add the most real, safe functionality in big batches: a way to find things in one place, family tasks, personal cinema lists, uploads of photos and files that survive a bad connection on a phone, a page and a desktop window to start, stop and restart the server programs, encrypted off-site backups and the real installation of the torrent client and the local model that were only prepared before. Nothing may weaken the existing protection, and everything is to stay inside the family's own computer.

## What Changes

- **Unified search** (Ctrl+K): films, photos, files, notes, events, tasks and chats, with the asker's rights, each source with its own time limit and an honest reason when a source did not answer.
- **Family tasks**: lists (personal and shared), dates, repeats, assignees, shopping lists, reminders as notifications, a block on the home page.
- **Cinema lists**: favourites, watch later, watched, «for you» with a reason, «new», history and family suggestions; a cache so that the page opens at once.
- **Files and photos**: uploads in pieces that continue after a broken connection, a queue with one summary and retry, skipping of exactly equal photos, optional removal of EXIF/GPS from JPEG, albums, a trash that gives things back, moving, bulk selection, a quota per person, an in-page viewer.
- **Server page and desktop window** for administrators: programs with start/stop/restart, the last log lines without secrets, a report that can be copied after passing a leak test; a window on the desktop with three buttons.
- **Local model**: installed and measured; started with an access key and low priority.
- **Torrent client**: installed and checked on one real legal torrent.
- **Encrypted off-site backup**: one authenticated encrypted file per snapshot, key kept outside Git, restore into an empty folder.
- **Calls**: relay credentials from the owner's own Cloudflare Realtime TURN key when configured.

## Capabilities

### New Capabilities

- `unified-search`: one search over everything the person may see.

### Modified Capabilities

- `family-storage`: resumable uploads, duplicates, metadata, trash, albums, quota, viewer.
- `family-planner`: tasks and reminders.
- `media-server`: personal lists and suggestions.
- `admin-tools`: server page, desktop window, report without secrets.
- `family-backups`: encrypted off-site copy.
- `family-assistant`: access key and low priority for the local model.

## Out of scope

Docker, WSL, Python, background photo upload from phones, perceptual image matching, version history of stored files, any change of the firewall, Defender, UAC, Windows updates, Tailscale ACL/DNS/routes, Funnel and port forwarding, and any download that the owner did not allow.