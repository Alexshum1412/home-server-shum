# Proposal

## Why

The owner's final decisions (18.10.2026): one family portal with chat and calls, a full torrent queue, «Оливия» as the only AI and only on this PC, a second protected HTTPS address for ordinary features, and a real monitoring page. Each of them has privacy and safety rules that must stay true when the code changes.

## What Changes

- Family chat (private and group) with files and pictures, read marks, notifications (portal list + Web Push) and voice/video calls up to four people over WebRTC; conversations are invisible to non-members, including the administrator.
- A torrent queue in «Загрузки» on top of aria2 over loopback RPC; the portal parses the `.torrent`/magnet itself, skips programs, restricts folders, checks trackers against SSRF, refreshes Jellyfin.
- «Оливия» for everybody with a closed list of tools; an optional local model only chooses a tool and never sees the family's data.
- A channel policy: a second public HTTPS address (tunnel) reaches only an explicit list of ordinary routes; the administrator cannot sign in through it.
- Hardware monitoring (cores, clock, video card, network, drive counters, a day of history) and alert notifications to administrators.
- A cinema catalogue (posters, genres, search, continue watching) served through the portal.

## Capabilities

### New Capabilities
- `family-chat`
- `family-assistant`

### Modified Capabilities
- `downloads`
- `portal-access`
- `system-status`
- `media-server`

## Impact

`server/src/{chat,calls,notify,realtime,jellyfin,olivia/assistant,downloads,system,lib/channel.ts}`, `shared/api.ts`, web pages Chat, Notifications, Cinema, Olivia, Downloads, System; ADR-0011…0014; runbooks `chat-and-calls`, `torrents`, `local-ai`, `public-https`; `scripts/install-component.ps1`, `scripts/components.json`.

## Out of scope

Native phone applications, a TURN server, the tunnel itself, installing the torrent client and the model (they need the owner's consent and accounts).
