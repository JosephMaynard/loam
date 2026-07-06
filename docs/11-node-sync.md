# 11 — Node-to-node sync

> **Status: MVP landed.** Pull-based gossip of public data between LOAM nodes over plain HTTP.
> Config: `sync.enabled` (default off), `sync.peers[]`, `sync.intervalMs`. Admin UI: the
> "Node-to-node sync" panel (peers, status, Sync now).

## What syncs — and what never does

A node with `sync.enabled` answers two endpoints (404 otherwise, indistinguishable from absent):

- `GET /api/sync/digest` — its public non-archived channels plus `{id, editedAt}` for every
  syncable message.
- `POST /api/sync/messages {ids}` — full records (≤500/batch) plus the authors' profiles.

**Syncable** means: posts/replies in *public, non-archived* channels, and reactions on them.
**Never exported:** DMs, private channels (or their member lists), in-flight LLM streams, and
messages by shadow-banned authors. Attachment images are copied best-effort from the peer that
has them (same magic-byte/size validation as uploads).

Each node *pulls* from its configured peers on an interval (or via "Sync now"). Imports are
schema-validated and defensive: messages only land in channels that are public *locally* (a
malicious peer can't inject into a private channel id), imported user profiles are stripped of
`isAdmin`/roles/moderation state (a peer's admin is a stranger here), and edits apply only when
strictly newer. Message ids are globally unique, so gossip is idempotent and loop-safe; content
propagates transitively (A←B←C) without coordination.

**Tombstones**: every local deletion (author/admin delete, reaction toggle-off, retention reaper)
records the id in a `tombstones` table, so a peer that still holds the message can never hand it
back. Deletes do **not** propagate to peers in v1 — each node's operator moderates their own node
(a kill-switch wipe also only wipes *this* node; peers keep what they already pulled — that is the
point of a mesh, and worth knowing before you enable sync).

## Onboarding

A peer's **join URL is its sync address** — the same thing its join QR encodes. Admin → Node-to-node
sync → add the URL (`http://192.168.0.10:3000`), save, Sync now. Two nodes that each list the other
converge in both directions.

## Transports — what actually works where

The protocol is plain HTTP and doesn't care how the two nodes can reach each other. The realistic
options, best-first:

| Setup | Works? | Notes |
|---|---|---|
| **Two nodes on one LAN** (laptop + Pi, two Pis, phone joined to a router) | ✅ today | The straightforward case; just exchange join URLs. |
| **Phone hosts hotspot *and* joins another phone's hotspot** (STA+AP concurrency) | ⚠️ device-dependent | Many modern Android phones (11+, flagship chipsets) can run the LocalOnlyHotspot while also connecting as a WiFi client. Not guaranteed on budget/older hardware, and the two radios may share a channel (throughput drops). Worth testing on the actual devices. |
| **Sequential ("courier") sync** — host B pauses its hotspot, joins A's WiFi, syncs, resumes | ✅ universally | Works on *every* phone. B's own clients drop for a minute; the pull loop catches everything up. This is the store-and-forward model the data design was built for, and it also covers physically carrying a node between sites. |
| **Cellular, no server** | ❌ | Two phones on mobile data cannot reach each other directly (carrier NAT, no inbound connections). Making that work requires an internet rendezvous/relay server — against LOAM's off-grid design. Not planned. |
| **LoRa (Pi + LoRa hat)** | 🔮 future | Long-range, very low bandwidth. It is a *transport* for this same digest/diff/fetch protocol, not a separate feature — needs a framing layer and aggressive bandwidth budgeting (text only, no attachments). The differentiator for fixed-site meshes; its own initiative. |

So: node-to-node is **not** a Pi-with-LoRa-only feature. It works today wherever two nodes share any
IP network for even a little while, and the phone story is "sequential sync always works; keep the
hotspot running too if the phone's chipset allows it".

## Security posture (v1 limits)

- Sync endpoints expose the node's **public** content to anyone who can reach it while enabled —
  the same content any open session on the LAN could read. Enabling sync is an explicit operator
  action; it defaults off and `hardened`-minded operators should leave it off or pair it with the
  approval join policy for humans (sync is unaffected by join policy — it is node-level trust).
- No peer authentication yet: a shared-token handshake (and, with docs/08, transport encryption)
  is the designated follow-up before recommending sync in hostile environments.
- User ids are random enough (`user.<8hex>`) that cross-node collisions are unlikely; a collision
  would merge two strangers' display identities on one node (cosmetic, not an auth issue — sessions
  never sync).

## Known v1 limitations

- Deletes/moderation don't propagate (tombstones only stop re-import locally).
- Channel metadata doesn't re-sync after first import (rename on A won't rename on B).
- Attachment copies are single-shot best-effort; a missed image 404s on the pulling node.
- No backpressure beyond batching (500 ids/request); fine at LAN scale, revisit for LoRa.
