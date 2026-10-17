# Proposal

## Why

Stage P6: the system status must show real measurements including the portal and Jellyfin with clear levels (works / warning / error / unknown), and an admin assistant («Оливия») must work from fixed rules first, with only allowlisted, confirmed and logged actions; everything must keep working without AI.

## What Changes

- `/api/system` gains `programs` (supervisor state, trusted only while the supervisor is alive) and `overall` (four levels); alerts for crashed, stopped and unstable programs and for a missing supervisor.
- «Оливия»: rule-based findings and four allowlisted actions (restart/start Jellyfin, backup now, re-check services) with applicability checks, confirmation, rate limit and audit; `OLIVIA_ENABLED=0` switches it off.
- A backup lock prevents overlapping runs.

## Capabilities

### Modified Capabilities
- `system-status`: programs and the overall level.
- `admin-tools`: the «Оливия» assistant.

## Impact

`server/src/system/{programs,alerts,collector}.ts`, `server/src/olivia/*`, `server/src/backup/lock.ts`, `server/src/cli/backup.ts`, config `OLIVIA_ENABLED`, Admin and System pages; ADR-0008.
