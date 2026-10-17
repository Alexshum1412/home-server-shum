# Tasks

- [x] 1.1 Storage core: spaces, path checks with realpath, list, open, mkdir, rename, trash, upload with checks, thumbnails; verified by `server/test/files.test.ts` (7 tests incl. junction escape and privacy)
- [x] 1.2 Routes incl. sandboxed inline files and Range; raw upload CSRF rule; verified by `files.test.ts`
- [x] 1.3 «Файлы» and «Фото» pages; verified by e2e `files.spec.ts` (upload/rename/trash, privacy across accounts, photo thumbnail and viewer, fake photo refused) and layout/axe checks
- [x] 1.4 Built-in services for files and photos; e2e server isolated from real family folders
- [x] 1.5 ADR-0007 (Nextcloud/Immich evaluation), EXECUTION_STATUS
