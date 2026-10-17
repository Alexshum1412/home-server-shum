# Design

See `docs/decisions/0010-planner-and-fallbacks.md` and the matrix `docs/feature-fallback-matrix.md`.

- The calendar is a JSON file in the portal's data folder (already in every backup). Dates are plain strings without time zones; repeats are expanded when read.
- Notes are ordinary files, so the second way to reach them is the file system itself.
- Every fallback runs through the same code and the same prohibitions as the main way (storage rules for import, the media folder read-only for the player).
- Anything that needs a Windows security change is opt-in and done by the owner (`lan-mode.cmd`).
