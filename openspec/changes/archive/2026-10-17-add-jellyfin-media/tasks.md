# Tasks

## 1. Install and expose

- [x] 1.1 Download the official Jellyfin 12.2 ZIP, verify SHA-256 against repo.jellyfin.org, unpack to `C:\FamilyServer\apps\jellyfin`; verified (hash `ab247745…d83f`)
- [x] 1.2 `network.xml`: loopback-only, no auto-discovery/UPnP, tailnet as local subnet, loopback as proxy; verified (`Get-NetTCPConnection`: only 127.0.0.1:8096, no UDP 7359)
- [x] 1.3 Media folders `C:\FamilyData\Media\*` with an ACL of PC, SYSTEM and Administrators only
- [x] 1.4 `scripts\serve-tailnet.cmd -Jellyfin` → `https://server-home.tail89d77e.ts.net:8443` (tailnet only); verified: 200 `Healthy` over HTTPS, LAN and tailnet IP on 8096 refused

## 2. Run and set up

- [x] 2.1 Supervisor runs Jellyfin (`apps.ts`) with a clean API shutdown; verified: graceful restart (exit 0, healthy after 20 s) and crash recovery (restart after 1 s, healthy after 8 s)
- [x] 2.2 `jellyfin-setup` CLI: wizard, generated admin password shown once, API key file, five libraries without trickplay/chapter images; verified by `server/test/jellyfin-setup.test.ts` and a real run
- [x] 2.3 NVENC hardware acceleration; verified: a forced 720p transcode used `-hwaccel cuda`, `scale_cuda`, `h264_nvenc` at 7.6× real time

## 3. Playback and portal

- [x] 3.1 Legal test video (generated 1080p H.264/AAC); Chrome playback DirectPlay 30 s, 0 dropped frames, Jellyfin 0.39 % CPU, 204 MB; a stream over tailnet HTTPS was byte-identical (SHA-256)
- [x] 3.2 Portal «Кинотеатр» links to Jellyfin and shows its real state; `process` field and supervisor-aware «Остановлен»/«Сбой» messages; verified by `services.test.ts` and live stop/start on the PC
- [x] 3.3 Docs: ADR-0005, `docs/runbooks/jellyfin.md`, EXECUTION_STATUS, security, README
