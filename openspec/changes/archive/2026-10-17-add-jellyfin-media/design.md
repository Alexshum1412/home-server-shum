# Design

See `docs/decisions/0005-jellyfin.md` for the options and measurements. Key points:

- **Install from the portable ZIP, not as a Windows service.**
  - Jellyfin's own documentation advises against service mode, and the installer would change the system.
  - The project supervisor already gives: start before sign-in (S4U task), restart after a crash or a hang, and a clean stop via `POST /System/Shutdown` with an API key.
- **Loopback plus Tailscale Serve on a separate port (8443) instead of a path.**
  - A BaseUrl is known to break several Jellyfin clients.
  - Tailscale Serve terminates TLS with the node certificate.
  - `KnownProxies=127.0.0.1` lets Jellyfin see real tailnet client addresses.
  - `LocalNetworkSubnets` = loopback + `100.64.0.0/10`, so tailnet devices are local; remote access outside these networks is off.
- **Libraries without trickplay and chapter images.** Both re-encode whole films; on an i5-6400 that is hours of full CPU per film.
- **Hardware transcoding (NVENC).** The GTX 960 can decode H.264, HEVC (incl. 10-bit), MPEG-2, VC-1 and VP9. Tone mapping is enabled but untested on real HDR content.
- **Known Jellyfin behaviour.** Media streams do not require authentication when the item id is known. It is mitigated by network exposure (loopback + tailnet only) and documented in `docs/security.md`.
- **Portal status.** It reads `run/supervisor.json` on every check cycle. A failed check for a program the supervisor stopped on purpose reads «Остановлен»; one in back-off reads «Сбой: сервис перезапускается автоматически». Admins additionally see the raw state and restart count.
