# Design

The reasons for each choice are in the ADRs; this file only lists them.

- Chat, calls and notifications: [ADR-0012](../../../docs/decisions/0012-family-chat-and-calls.md) — SSE plus POST for realtime, WebRTC mesh with signalling relayed by the portal, Web Push on `node:crypto`.
- Local model and the assistant's tools: [ADR-0011](../../../docs/decisions/0011-olivia-local-model.md).
- Public channel: [ADR-0013](../../../docs/decisions/0013-remote-access-public-https.md) — an allow-list of routes, not a deny-list.
- Torrents: [ADR-0014](../../../docs/decisions/0014-torrent-queue.md).

Honest limits recorded with the change: calls were verified between two browser windows on one PC only; the torrent client, the model, the tunnel and TURN are not installed or configured; push was not tried on a real phone.
