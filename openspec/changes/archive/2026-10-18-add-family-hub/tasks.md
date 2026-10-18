# Tasks

## 1. Chat, calls, notifications

- [x] 1.1 Chat store, service and routes with membership checks; verified by `server/test/chat.test.ts` and e2e `chat.spec.ts`
- [x] 1.2 Realtime hub (SSE) and web client reload after reconnect; verified by chat e2e
- [x] 1.3 Call manager and signalling, UI; verified by `server/test/calls.test.ts` and e2e `calls.spec.ts` (real WebRTC between two windows of one PC)
- [x] 1.4 Notification centre and Web Push; verified by `server/test/webpush.test.ts` (RFC 8291 vector)
- [ ] 1.5 Call between two real devices in different networks, TURN, push on a real phone — **owner action** ([runbook](../../../docs/runbooks/chat-and-calls.md))

## 2. Torrents

- [x] 2.1 Bencode/magnet parsing, aria2 client, torrent manager; verified by `server/test/torrents.test.ts`
- [x] 2.2 Downloads page with the torrent queue; verified by e2e `torrents.spec.ts` on a stand-in client
- [x] 2.3 Installer with pinned size and SHA-256 (`scripts/install-component.ps1`)
- [ ] 2.4 Install aria2 and download a real legal torrent — **owner consent needed**

## 3. «Оливия»

- [x] 3.1 Router, tools, templates, model chooser, routes, page; verified by `server/test/olivia-assistant.test.ts` and e2e `olivia-assistant.spec.ts`
- [x] 3.2 Supervisor program `llama` (only when installed and switched on); verified by `server/test/supervisor-apps.test.ts`
- [ ] 3.3 Install llama.cpp and the model, measure memory and speed — **owner consent needed**

## 4. Public channel

- [x] 4.1 Channel policy, allow-list, administrator rule, separate limiter; verified by `server/test/public-channel.test.ts`
- [ ] 4.2 Create the tunnel and Cloudflare Access — **owner account and domain needed**

## 5. Monitoring

- [x] 5.1 Hardware probes, history, alerts, notifications to administrators; verified by `server/test/hardware.test.ts` and a live read on this PC
- [x] 5.2 Status page section; verified by `web/src/pages/System.test.ts` and e2e layout checks at six widths

## 6. Documentation

- [x] 6.1 `docs/FAMILY_USER_GUIDE.md` with real screenshots (`npm run guide:screenshots`), checked by `server/test/guide-docs.test.ts`
- [x] 6.2 ADR-0011…0014, runbooks, fallback matrix, owner actions, security and threat model
