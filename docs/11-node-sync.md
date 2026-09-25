# 11 — Node-to-node sync

> **Status: MVP landed.** Pull-based gossip of public data between LOAM nodes over HTTP — sealed inside
> the transport session whenever the peer supports it (docs/08), plaintext only as a guarded fallback.
> Config: `sync.enabled` (default off), `sync.peers[]`, `sync.intervalMs`. Admin UI: the
> "Node-to-node sync" panel (peers, status, Sync now).

## What syncs — and what never does

A node with `sync.enabled` answers two endpoints (404 otherwise, indistinguishable from absent):

- `GET /api/sync/digest` — its public non-archived channels plus `{id, editedAt}` for every
  syncable message.
- `POST /api/sync/messages {ids}` — full records (≤500 ids per request by schema; the puller asks for
  far fewer, see *Batching*) plus the authors' profiles.

**Syncable** means: posts/replies in *public, non-archived* channels, and reactions on them.
**Never exported:** DMs, private channels (or their member lists), in-flight LLM streams, and
messages by shadow-banned authors. Attachment images are copied best-effort from the peer that
has them (same magic-byte/size validation as uploads).

Each node *pulls* from its configured peers on an interval (or via "Sync now"). Imports are
schema-validated and defensive: messages only land in channels that are public *locally* (a
malicious peer can't inject into a private channel id), **only the author of a message this node
actually accepted is imported** (never every user a peer's payload lists — a peer could otherwise push
tens of thousands of records per batch), imported user profiles are stripped of `isAdmin`/roles/moderation
state (a peer's admin is a stranger here), **reserved ids are refused** both as user records and as message
authors (any `mesh.*` id — a mesh sender's display record — and this node's configured bot id), and edits
apply only when
strictly newer **and only to the same message** — an incoming record that reuses an existing id must match
its type, author, `createdAt` and routing (channel / parent / target), checked before any attachment is
fetched, so a peer that learns a private message's id can't re-type it into the public flow. A message
naming an attachment id that another local message (or a pending upload) already owns is refused, and ids
in the mesh replay-key namespace (`sealed.`) are never imported. **Only messages this node imported are
peer-editable** (`synced_messages` provenance table, mirroring the channel C1 gate): a peer can never
rewrite a message a local user wrote. A peer can still rewrite messages that *came from peers* — sync is
unsigned; signed sync (docs/29 Track B) is the real fix. Messages imported before the provenance table
existed are unmarked, so later peer edits to them are ignored (fail closed). An import is also refused if
it names an attachment id whose file is already on disk (under any extension) and that the edited record
doesn't reference. **Local moderation is sticky:** a message a moderator removed no longer takes peer edits
(the removal is an in-place edit the origin's next edit would otherwise win against), and un-editable
records aren't even requested from the digest. A peer's mesh key is only ever adopted onto a user record a
sync import created (`synced_users`), never one of this node's own users. An imported message body over **256KB** is skipped (`maxSyncImportBodyBytes`): the stored
body schema is deliberately uncapped so long *local* LLM replies round-trip, but a hostile peer must not be
able to amplify ~8MB bodies onto a syncing node (docs/25 SW2). Message ids are globally unique, so gossip is
idempotent and loop-safe; content propagates transitively (A←B←C) without coordination.

**Batching.** Public ids go out in batches of **200** and sealed mesh ids (docs/16, ≤ 90 KB each) in
batches of **40**, within per-round budgets of **4 000** public / **80** sealed ids (the rest waits for the
next round; sealed offers are taken soonest-expiry first). Responses are capped at 8 MiB of plaintext JSON
(the sealed-response cap allows for the 4/3 base64 envelope overhead). A batch whose *content* is unusable
— over the cap, not JSON, failing the schema — is split in half and retried down to the single offending
id, which is then remembered as refused; a network-level failure (peer unreachable, 4xx/5xx) ends the
round's fetching without discarding what earlier batches imported.

**Refused offers.** After each batch the puller remembers, per peer, every offer it fetched and didn't end
up holding (a reply to a deleted post, a post into an archived channel, an over-cap body, a sealed blob
that is neither ours nor carriable…), keyed by id + version, so it isn't re-downloaded every round. The
memory is RAM-only, bounded (**20 000** entries per peer, oldest evicted), and expires (**1 h**; a sealed
blob this node can't carry by policy — relay off, no hop left — is remembered until its own TTL, and the
key embeds the relay setting so switching relaying on voids those verdicts at once). A reply/reaction whose
parent/target is still on offer this round is deferred, not remembered. Refused replies are cached, not
tombstoned: a tombstone is node-wide and durable, and the id is peer-chosen. The kill switch clears it; a
restart re-fetches each refused offer once. A change to the local policy that decided a refusal also clears
it (`forgetRefusedOffers()`, which keeps the transport sessions and downgrade history): every admin config
save (`PATCH /api/admin/config`), and a channel edit that changes `archived`, `allowPosting` or
`allowReplies`. The next round then fetches those offers again instead of waiting out the hour.

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
- **Peer authentication (shared token)** — built. Set `sync.token` (admin → Network → "Shared mesh
  token", or config) and this node **requires** every peer to present it before it serves the
  digest/messages, and presents it when pulling from its own peers. A
  missing or wrong token 404s identically to sync being disabled, so a prober can't distinguish a
  token-guarded node from one without the feature. Give every node in the mesh the **same** token.
  It's a bearer secret the node must transmit, so it's stored in the clear (unlike the scrypt-hashed
  admin passphrase / panic token). Protecting it at rest depends on **where you set it**:
  `LOAM_DB_KEY` encrypts only the **DB-persisted** config (a token set via the admin UI / `PATCH
  /api/admin/config`); a token placed in **`config.json`** stays plaintext even on an encrypted node
  (that file is never encrypted — see CLAUDE.md), so guard it with filesystem permissions or a
  secret manager. On the wire the token is **never sent in plaintext**: over an encrypted session it
  rides inside the sealed `{ s, b, tok }` envelope (and an encrypted request authenticates *only* that
  way — a `x-loam-sync-token` header on a sealed session is ignored); a plaintext fallback pull goes
  **without** it (so a token-guarded peer 404s it), unless this node itself runs transport `off`
  (Developer Mode), the one case where it is sent as the `x-loam-sync-token` header. A `required` node
  refuses plaintext pulls altogether, and a peer that negotiated encryption this boot is never silently
  downgraded (docs/08 has the full rules and the first-contact residual). Unset = open (any node that can
  reach the endpoints may sync public data — the original behaviour).
- User ids are random enough (`user.<16hex>`, 64 random bits) that cross-node collisions are unlikely; a collision
  would merge two strangers' display identities on one node (cosmetic, not an auth issue — sessions
  never sync).

## Known v1 limitations

- Deletes/moderation don't propagate (tombstones only stop re-import locally). This includes
  **permanent channel deletes** (the channel id is tombstoned too): within the tombstone horizon
  (30-day GC, docs/15 #7) a peer can never hand the channel back; a peer offline *longer* than the
  horizon can — the same accepted DTN limitation as message tombstones, now worth knowing because
  the UI presents channel deletion as permanent.
- **Channel metadata re-syncs only for channels this node imported** (C1): channel ids are human slugs,
  so two nodes' independently-created same-named channels (notably the default `general`/`announcements`)
  collide on id. A channel is recorded as synced-origin when first imported, and only those take a
  peer's newer name/description/posting/archive metadata (newer-wins on a peer stamp clamped to now); a
  locally-created channel is never rewritten by sync. See docs/25 (C1).
- No backpressure beyond the batching and per-round budgets above; fine at LAN scale, revisit for LoRa.

## Resolved

- **Attachment copies retry (C3).** A copy that fails at import records a work item
  (`addMissingAttachment`); `retryMissingAttachments` re-fetches it from the peer on the reaper timer with
  backoff, a starvation-fair per-pass cap, and a max-age drop — best-effort recovery from *transient*
  failures (peer briefly unreachable, mid-write, required-mode 401), rather than the old single-shot copy
  that left a missed image absent forever. A file that stays gone past the max-age is dropped from the work
  queue and can still 404 — there's no source left to fetch it from.
