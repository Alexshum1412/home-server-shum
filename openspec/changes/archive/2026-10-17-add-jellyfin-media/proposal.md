# Proposal

## Why

Stage P2 of the owner's brief asks for a real, working media server rather than a «Кинотеатр» placeholder. The family should be able to watch films at home and abroad through the private tailnet. The portal must show whether the media server runs, is stopped or is unreachable. Start, recovery and remote access must be documented and verified.

## What Changes

- **Jellyfin 12.2.** Installed from the official Windows ZIP (SHA-256 verified) under `C:\FamilyServer\apps\jellyfin`, data under `C:\FamilyServer\data\jellyfin`.
  - Runs under the supervisor.
  - Listens on loopback only; no auto-discovery or UPnP.
  - Reached by the family through Tailscale Serve `https://<node>.ts.net:8443`, tailnet only.
  - NVENC hardware transcoding on the GTX 960.
- **`scripts\jellyfin-setup.cmd`** (idempotent):
  - startup wizard with a generated admin password shown once;
  - API key for the clean shutdown;
  - Russian libraries for `C:\FamilyData\Media\*` without CPU-heavy image extraction.
- **`scripts\serve-tailnet.cmd -Jellyfin`** publishes port 8443 in the tailnet; it never touches other Serve handlers or Funnel.
- **Supervisor state in the portal.** `services.json` entries may name a supervisor program (`process`). When the health check fails, the portal shows «Остановлен» or «Сбой: перезапускается» from the supervisor state instead of a bare «не отвечает».

## Capabilities

### New Capabilities

- `media-server`: the local Jellyfin, its network exposure, start and recovery, setup and playback.

### Modified Capabilities

- `service-status`: honest states also use the supervisor's knowledge of stopped, crashed and starting programs.

## Impact

- **New code:** `server/src/cli/jellyfin-setup.ts`.
- **Changed code:** `server/src/supervisor/apps.ts` (Jellyfin spec), `server/src/services/{config,checker}.ts`.
- **Scripts:** `scripts/jellyfin-setup.cmd`, `scripts/serve-tailnet.ps1`.
- **System:** one more Tailscale Serve handler (8443). Firewall, ACL and Funnel are unchanged.
- **Data:** `C:\FamilyData\Media` (restricted NTFS ACL), `C:\FamilyServer\data\jellyfin`, `jellyfin-api.json` (secret, not in Git).
