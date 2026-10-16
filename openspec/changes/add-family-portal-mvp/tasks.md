# Tasks

## 1. Setup

- [x] 1.1 Install Node.js 24 LTS and Git per user, verify `node -v` = v24.22.0 and `git --version`
- [x] 1.2 Create `package.json` with pinned dependencies, `tsconfig.json`, `web/tsconfig.json`, `vite.config.ts`, `biome.json`, `.gitignore`; verify `npm ls --depth=0` succeeds
- [x] 1.3 Write the shared API contract `shared/api.ts`; verify it type-checks with `npm run typecheck`

## 2. Server core and access

- [x] 2.1 Config loader, JSON store with atomic writes, app factory with security headers, body limit, JSON 404, `/api/health`; verify with `server/test/app.test.ts`
- [x] 2.2 scrypt passwords, user store, persisted hashed sessions, login/logout/session/setup-state routes, role guards, rate limiting, origin check; verify with `server/test/auth.test.ts` (401/403/429/CSRF/restart scenarios)
- [x] 2.3 Audit log with rotation and tail read; verify entries never contain secrets in `server/test/audit.test.ts`
- [x] 2.4 User CLI (`npm run user -- add|list|passwd|remove`) with hidden password input; verify add/list/remove on a temp data dir

## 3. Service status

- [x] 3.1 Services config (defaults, zod validation, http/https only) and background checker with timeouts; verify online/degraded/offline/not_configured/disabled against a local test HTTP server in `server/test/services.test.ts`
- [x] 3.2 `GET /api/services` and admin-only rate-limited `POST /api/services/refresh`; verify 401/403/429 in tests

## 4. System status

- [x] 4.1 CPU sampler, memory, uptime, volumes with low-space flag; verify null-vs-0 handling in `server/test/system.test.ts`
- [x] 4.2 Allowlisted PowerShell probes for physical disks and printer, Tailscale CLI probe, with timeouts and caching; verify parsers against fixtures (including the `ST_M13FQBL` disk) and a hung-probe test
- [x] 4.3 Backup status (not configured until a status file exists) and alert generation; verify alerts in tests
- [x] 4.4 `GET /api/system` with admin-only fields hidden from family; verify in tests

## 5. Admin tools

- [x] 5.1 `/api/admin/audit`, `/api/admin/users`, `/api/admin/diagnostics` (admin only, no secrets); verify secret absence in tests

## 6. Frontend

- [x] 6.1 Design tokens, base styles, app shell with responsive navigation, router, API client with timeout; verify `npm run build`
- [x] 6.2 Login and first-run screens; verify manually and in e2e
- [x] 6.3 Home page, service pages (cinema, photos, files, downloads, print), honest state badges; verify in e2e
- [x] 6.4 System status page, connection/help page, admin page; verify in e2e
- [x] 6.5 PWA manifest, icons, service worker (shell only); verify manifest served and SW registers over localhost

## 7. Operations

- [x] 7.1 Windows scripts: start (background, PID file, health wait), stop, status, tailnet serve on/off, with `.cmd` wrappers; verify start → health 200 → stop releases port
- [x] 7.2 Configure Tailscale Serve HTTPS → 127.0.0.1:8070 without Funnel; verify `tailscale serve status` and an HTTPS request from this machine

## 8. Integration checks

- [x] 8.1 Playwright e2e in Chrome: login, navigation, role restrictions, viewports 375/390/430/768/1024/1440 without horizontal overflow, axe without serious/critical violations; verify `npm run test:e2e`
- [x] 8.2 Full `npm run check` passes; record results in `docs/roadmap.md` and the final report

## Workflow follow-up

- Archive the change with `openspec archive add-family-portal-mvp` after review.
