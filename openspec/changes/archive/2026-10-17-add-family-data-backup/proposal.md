# Proposal

## Why

Stage P5 of the brief requires backups of the application configuration, the necessary databases and the user data, with integrity checks, versions and a demonstrated restore. Since P2/P4 the server holds Jellyfin's database and the family files and photos; the nightly copy covered only the portal's own data.

## What Changes

- Family files, photos (with thumbnails) and home videos are part of every snapshot; trash, partial downloads/uploads and temp files are skipped; films/series/music are deliberately excluded (replaceable, too large).
- Unchanged family files are hard-linked to the previous snapshot on the same target: every snapshot stays complete while only new data takes space; free-space checks count only the new bytes.
- Jellyfin's config and database are copied while Jellyfin is paused through the supervisor (seconds), then it starts again; metadata images, cache and transcodes are skipped.
- A too-small target fails with advice to prune or use a bigger drive.

## Capabilities

### Modified Capabilities
- `family-backups`: new requirements for family data and the media server.

## Impact

- `server/src/backup/{sources,snapshot,run,targets}.ts`; tests `server/test/backup-family.test.ts`.
- Snapshot manifest gains an optional `mtimeMs` per file (older manifests stay valid).
