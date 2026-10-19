# Design

## Decisions

1. **Own resumable protocol** instead of tus or a library: five requests (start, piece with `offset`, status, finish, cancel); the server keeps the part in a hidden folder of the space and a piece that does not start at the end of what it has is refused with 409 and the true position. The file takes its place only at finish, under the first free name, after the same checks as an ordinary upload. See ADR-0015.
2. **Exact duplicates only**, by SHA-256 of the file as sent; the index is per space and built in the background for old photos, and the page says when it is not finished. Perceptual matching is rejected: a false match would hide a different photo.
3. **EXIF removal is on by default and visible**: JPEG segments other than the image, the colour profile and the orientation are dropped; other formats are stored as they are and the page says so.
4. **Albums are folders** under `Альбомы`; no second database.
5. **Trash never empties itself**; an index outside the trash keeps the old name and place.
6. **Search runs the sources side by side**, each limited to 4 seconds and to a few results, with the asker's rights; a source that fails does not hide the others.
7. **The server page reads, never executes strings**: actions are a closed list (start/stop/restart of known programs); logs and the copied report pass one sanitiser (secrets, tokens, mail, paths, addresses, names, texts of messages) and are checked with «canary» values.
8. **The local model is protected on loopback** by an access key kept in the data folder and runs below normal priority; the answer is a closed choice of a tool and words of the question.
9. **Encrypted copy** uses AES-256-GCM in 1 MiB chunks authenticated with the header and the chunk number; the key is a file outside Git plus a printed recovery code.

## Risks

- Hardware on the PC is unstable (unexpected reboots, hardware errors); everything started is restartable by the supervisor, and the state is kept in files with atomic writes.
- Part files take disk space until finished or a day has passed.
- The duplicate index of old photos is not instant.