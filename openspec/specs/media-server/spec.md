# media-server Specification

## Purpose
Домашний кинотеатр на Jellyfin: фильмы и сериалы для семьи дома и за границей через частную сеть tailnet, с автозапуском, восстановлением после сбоя и честным статусом в портале.

## Requirements

### Requirement: Private-only media server
The media server SHALL listen only on the loopback address and SHALL be reachable by family devices only through Tailscale Serve inside the tailnet. Client auto-discovery, UPnP and Funnel SHALL stay off, and no firewall rule SHALL be added for it.

#### Scenario: Tailnet device
- **WHEN** a tailnet device opens `https://server-home.tail89d77e.ts.net:8443/health`
- **THEN** Jellyfin answers over HTTPS with a valid certificate

#### Scenario: Home network or tailnet IP directly
- **WHEN** a device connects to port 8096 on the LAN address or the tailnet IP of the PC
- **THEN** no connection is established

### Requirement: Supervised start and recovery
The media server SHALL be started by the supervisor together with the portal, SHALL be stopped through its own API before any hard kill, and SHALL be restarted automatically after a crash.

#### Scenario: Restart command
- **WHEN** the owner restarts Jellyfin through the supervisor
- **THEN** Jellyfin exits with code 0 after the API shutdown and is healthy again

#### Scenario: Crash
- **WHEN** the Jellyfin process is killed
- **THEN** the supervisor starts it again and its health check passes

### Requirement: Repeatable first-time setup
A setup command SHALL complete the Jellyfin wizard with a generated administrator password shown once and never stored, save an API key outside Git, and create the family libraries without CPU-heavy image extraction. Running it again SHALL change nothing.

#### Scenario: Second run
- **WHEN** the setup command runs on an already configured server
- **THEN** it reports that everything is set up and prints no password

### Requirement: Verified playback
Direct playback of a supported file SHALL work in a browser without transcoding, and transcoding for low bandwidth SHALL use the GPU when available. Heavy 4K HDR transcoding SHALL NOT be promised without a test on real content.

#### Scenario: Direct play
- **WHEN** the 1080p H.264/AAC test video is played in Chrome through Jellyfin Web
- **THEN** the session reports `DirectPlay`, playback advances in real time and Jellyfin uses under 5 % of the CPU
