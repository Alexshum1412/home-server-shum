# Proposal

## Why

Stage P4 of the owner's brief: personal and shared family files, web upload, viewing and download, role separation, a clear folder structure and photos/videos from phones — with no access to someone else's personal files. Nextcloud does not support Windows servers and Immich needs Docker/WSL2 and 6–8 GB RAM (ADR-0007), so the portal provides the feature itself.

## What Changes

- Built-in storage: personal and shared spaces for files and for photos, streaming upload with size, space and content checks, sandboxed inline viewing, Range support, folders, rename, move to trash (no permanent deletion), audit without personal file names.
- «Файлы» and «Фото» pages: tabs, breadcrumbs, upload progress, gallery by month with browser-made thumbnails and a viewer.
- Raw upload exception in the CSRF guard: only PUT to `rawUpload` routes with `application/octet-stream` and `X-Upload: 1`; route-set security headers are not overwritten.

## Capabilities

### New Capabilities
- `family-storage`: family files and photos.

## Impact

- New: `server/src/files/{storage,routes}.ts`, `web/src/pages/{Files,Photos}.tsx`, `web/src/lib/upload.ts`.
- Changed: `server/src/app.ts` (raw upload, header merge), config (`UPLOAD_MAX_FILE_GB`), services defaults (files/photos built in), e2e server isolation.
- Data: `C:\FamilyData\Files`, `C:\FamilyData\Photos` (NTFS ACL: PC, SYSTEM, Administrators).
