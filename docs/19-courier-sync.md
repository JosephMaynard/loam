# 19 — Courier sync (the human as the transport)

> **Status: DESIGN (not built).** This doc proposes a **manual, human-carried** transport for LOAM's
> existing delivery layer — a "data mule" / sneakernet mode — as a **peer option alongside** (not a
> replacement for) the continuous LAN sync (docs/11) and the opportunistic BLE/Wi-Fi-Aware auto-sync
> (docs/16 Phase 3, PR #77). An operator can enable any combination. Written to be reviewed (by the
> maintainer + an external model) before implementation, per the "don't rush the transport" rule.

## Why

Always-on opportunistic radio (Phase 3) is the model Briar/Bridgefy/FireChat used — and it's where they
struggled: continuous BLE/Wi-Fi-Aware scanning + background wake locks drain batteries and fight the OS,
so the network is only as alive as people's tolerance for a battery-hungry background app. **Courier
sync sidesteps that entirely: nothing runs in the background. A human decides to be the postman.** You
walk your phone (a LOAM node) into range of node A, tap "sync", walk to node B, tap "sync" — and mail
you picked up at A is now at B. It's slower and higher-latency, but it's *robust*, legible, and costs
zero battery when idle. It also fits LOAM's stated priorities (resilience, intermittent connectivity)
better than always-on radio does.

Both modes are wanted. Auto-sync is great when devices are co-located and charging (two phones on
generators at one site, a room full of people). Courier is great when sites are **out of radio range of
each other** and only a person bridges them (two off-grid camps a valley apart; a "messaging ring" whose
members sync whenever any two of them happen to meet). Neither is strictly better; the operator picks.

## The key fact: the delivery layer is already transport-agnostic — and mostly built

LOAM separates **delivery** (what moves, and its guarantees) from **transport** (how the bytes get
between two nodes). Everything below the transport is done and tested today:

- **Public data** syncs via the pull protocol (docs/11): `GET /api/sync/digest` → `POST
  /api/sync/messages`, deduped by message id, with **tombstones** so a delete can't be re-imported.
- **Sealed mesh mail** (docs/16) already **rides that same sync**: `buildSyncDigest()` advertises a
  `sealed` bucket — `{ id, toTag, ttlExpiresAt, hopLimit }`, metadata only, **no content** — when
  `mesh.enabled`. A puller fetches the blobs it wants and runs each through `acceptSealedFromPeer`,
  which **delivers locally if it's for a local user, else stores it hop-decremented so it is re-offered
  in this node's own digest** — the carry-forward is genuinely **multi-hop** (A→B→C→…), verified in the
  code: each accepting node re-advertises the blob, so a chain of couriers ferries it arbitrarily far,
  bounded by `hopLimit`, `ttlExpiresAt`, the `maxCarried` cap, and id-dedup/tombstones. **Caveat
  (honest):** there are **no delivery-acks yet** ("no acks", per CLAUDE.md) — convergence is by TTL/hop
  expiry alone, so after a blob is delivered at its destination, intermediate mules keep carrying it
  (harmlessly — the recipient dedupes) until its TTL/hop runs out. Signed acks that prune delivered mail
  early (reusing the tombstone table) are a clean v2; until then, courier deployments tune `hopLimit ≥
  longest expected chain` and `TTL ≥ courier round-trip latency`.
- **The bytes on the wire** can already be **encrypted end-to-end between nodes** (PR #84): the puller
  does the transport handshake with the peer and seals its sync requests; the sealed mail is sealed to
  its *recipient* regardless, so a courrier ferries blobs it **cannot read**.

So the "carry a bag of messages the mule can't read, and converge without duplicates or loops" problem
— the genuinely hard part — **is already solved.** Courier mode does not add crypto or a new relay. It
adds a **transport**: a manual, ad-hoc sync between a node and whatever node a human brings it near.

## Transports (all feed the same delivery layer)

| Transport | How a contact happens | Background cost | Built? | Best for |
|---|---|---|---|---|
| **Continuous LAN sync** (docs/11) | configured peers on a shared network, on a timer | low (only while networked) | ✅ | co-located sites, a fixed backbone |
| **Opportunistic auto-sync** (Phase 3, #77) | BLE discovery + Wi-Fi Aware, automatic when in range | **high** (scanning/wake locks) | ⚠️ native-unverified | dense co-presence, hands-off |
| **Manual courier** (this doc) | a human connects to a node and taps "sync" | **none** when idle | ❌ design | out-of-range sites, rings, low-power |

These are **independent toggles**, not a mode switch. A node can run a continuous LAN backbone *and*
accept courier syncs *and* (on Android) opportunistically auto-sync — whatever the deployment needs.

## What courier mode reuses vs. what's new

**Reused, unchanged:** the whole delivery layer above — public sync, the sealed digest bucket, the
carry-forward relay, the TTL/hop/cap ceilings, id-based dedup, delete-state tombstones (so a deleted
message can't be re-imported), and (optionally) #84's per-hop transport encryption. Note convergence
today is **dedup + TTL/hop expiry**, not delivery acks — signed acks that prune *delivered* mail early
(reusing the tombstone table) are the v2 above, not something courier mode inherits.

**New, and small:**
1. **Ad-hoc, one-shot sync.** Today sync runs on a timer against *pre-configured* `sync.peers`. A
   courier meets a node it may not have in its list. Needed: "sync **now** with **this** address"
   (scanned/tapped), a single pull+push round, not added to the permanent peer set unless the user
   wants. Mechanically this is one call into the existing `syncWithPeer` against an ad-hoc target.
2. **Explicit push (courier → node).** The current pull protocol is puller-driven: A pulls from B. A
   courier delivering *to* a node needs the node to pull from the courier, **or** a push endpoint. The
   cleanest reuse: the courier hosts the same `/api/sync/*` surface (it's a full node), and the
   receiving node pulls from the courier — so "drop off" = "let B pull from me". A one-shot **mutual**
   sync (each pulls from the other) does pickup + dropoff in one tap.
3. **Transport-mode config.** `sync.transports: { lan, opportunistic, courier }` toggles (names TBD),
   surfaced in the admin UI, defaulting to today's behaviour (LAN on, others off).
4. **NFC key exchange (optional "extra").** The join/trust bootstrap (a node's `#k=` transport key +
   `sync.token`, or a mesh identity card) exchanged by **tap** instead of QR — a second out-of-band
   channel, Android-native (an Expo NFC module, same pattern as `loam-hotspot`). QR stays the default.
5. **UX** to make (1)–(4) legible: a "Sync with a node nearby" flow with clear pickup/dropoff feedback.

## The courier flow (concrete)

1. **Enrol** (once per node the courier serves): the courier learns the node's address + trust material
   (`sync.token`, optionally a pinned transport key — #84) via QR or NFC tap. For a **ring**, everyone
   shares one token/key set, so any member's device can courier for any node.
2. **At node A:** connect to A's network (its hotspot), open "Sync now", pick A. One mutual sync:
   - pull A's public updates + A's offered `sealed` bag (minus what the courier already holds, by id-dedup);
   - the courier **keeps** sealed mail not for its own users, hop-decremented, to carry;
   - let A pull the courier's bag → A delivers what's for A's users, keeps the rest.
3. **Walk to node B** (out of A's range). Idle: nothing runs.
4. **At node B:** same mutual sync. A's mail the courier carried now lands at B; B's mail loads onto the
   courier for the trip back. Recipients who are never physically near each other still converge over
   several courier hops. TTL/hop caps stop infinite carry; id-dedup stops re-import at the recipient
   (signed acks that would prune delivered mail earlier are the v2 — see Bounds & convergence).

A courier is just a normal LOAM node whose *only* transport is "a human presses sync". It can also be a
node with **no local users of its own** — a pure mule (a spare phone) that only ferries.

## Trust, keys, and rings

- **Access** is the existing `sync.token` bearer (docs/11) — a courier must present it to sync with a
  guarded node. A **ring** = a shared token (or, better, #84 **pinned per-peer transport keys** for
  active-MITM resistance) distributed among members out-of-band (QR/NFC at a founding meet-up).
- **Confidentiality of carried mail** does not depend on courier trust at all: sealed mail is sealed to
  its recipient (docs/16), so a courier — even a hostile or coerced one — ferries ciphertext it can't
  read, addressed by a `toTag` it can't resolve to a person without the recipient's secret token.
- **NFC** is a nicer bootstrap for the above (tap two phones to exchange the ring's token + keys, or a
  mesh identity card) — strictly an out-of-band convenience, not a new trust root.

## Privacy & threat analysis (for review)

- **A courier sees:** the *existence, size, `toTag`, TTL and hop* of each sealed blob it carries, and
  all **public** channel data (public by definition). It does **not** see sealed content or the real
  recipient. `toTag` is derived from the recipient's *secret* mailbox token, so a tokenless courier
  can't link a blob to a person — but it *can* observe that "some blob is moving" and, across many
  syncs, do traffic analysis on tags/sizes/timing. No cover traffic.
- **A malicious node** a courier syncs with sees the same, plus it could **inject** mail (bounded by
  TTL/hop/cap and `acceptSealedFromPeer`'s defensive checks) or **drop** mail (a courier/node can always
  refuse to carry — availability, not confidentiality). Public-message impersonation is already guarded
  (`importPeerMessages` refuses content attributed to a local authoritative user).
- **A coerced/seized courier phone** exposes: its own local data (mitigated by at-rest encryption + kill
  switch + ephemeral retention), and the *ciphertext* bag it carries (not readable). This is the same
  posture as any relay node — the mule is a carrier, not a confidant.
- **Downgrade / MITM between courier and node:** covered by #84 — a `required` node refuses plaintext;
  a pinned key gives active-MITM resistance; TOFU-over-`/api/config` gives passive protection only.
- **Residual, honest:** traffic-analysis metadata (tags/sizes/timing) on carried mail; a hostile courier
  can delay/drop (DoS, not disclosure); no anonymity of *who couriers for whom*.

## Bounds & convergence (mostly existing)

Storage on a long-uncontacted mule is bounded by the mesh cap + per-blob TTL; a blob past `ttlExpiresAt`
is reaped regardless of `mesh.enabled`. Loops/duplicates are stopped by id-dedup + hop-decrement + TTL
expiry (delete-state tombstones additionally stop a *deleted* message being re-imported; delivery-ack
pruning of *delivered* mail is the v2, not built). Courier mode inherits all of this; the only new knob
worth considering is a
**per-courier carry budget** (how much a mule will hold) and whether a courier prioritises by TTL when
over budget.

## Making it easy (the real challenge)

The engineering is modest; the **legibility** is the hard part — this only works if non-technical people
understand it. Design principles:
- **One obvious action:** "Sync with a node nearby" → connect → tap → a clear "picked up N / delivered M"
  result. No jargon ("digest", "relay", "hop").
- **Rings are a first-class setup wizard:** "Start a messaging ring" (mints a shared token/keys, shows a
  QR/NFC to add members) and "Join a ring" (scan/tap). Members then just "sync when you meet".
- **Explain the model in one sentence in-app:** "Messages travel when people carry them between nodes —
  sync whenever you're near one."
- **Honest expectations:** show last-synced-with-X times so people grasp the latency ("Bree hasn't
  synced with the north camp in 3 days").

## Phasing

1. **Ad-hoc one-shot mutual sync + UX** (the core; reuses the whole engine). Desktop/LAN-testable.
2. **Transport-mode config + admin UI** (toggles; default = today).
3. **Ring setup/join wizard** (shared token/keys via QR).
4. **NFC key exchange** (Android Expo module) — optional polish.
5. Field-test latency/convergence with real multi-node, multi-courier runs.

Phases 1–3 are desktop/LAN-testable with no new crypto and no radios. Phase 4 needs a device.

## Open questions (for the maintainer + external review)

- **Push vs mutual-pull for dropoff:** is "let the node pull from the courier" enough, or do we want an
  explicit courier→node push endpoint (and its abuse surface)?
- **Ad-hoc trust:** should a courier be able to sync with a node it has *no* pre-shared token for
  (open ring), and if so what's the abuse bound?
- **Carry budget & prioritisation** when a mule is over its storage cap.
- **Ring key management:** shared bearer token (simple, revocation-hard) vs. per-member keys (better,
  more UX). NFC helps either way.
- ~~**Does the sealed-bucket sync carry-forward across arbitrary hops?**~~ **RESOLVED (verified in
  code):** yes — `acceptSealedFromPeer` stores a not-for-me blob at `hopLimit − 1` and it is re-offered
  in that node's digest, so it ferries A→…→Z, bounded by hop/TTL/cap/dedup. **But no delivery-acks
  exist yet**, so delivered mail is only pruned by TTL/hop expiry (redundant-but-harmless carrying until
  then). Signed acks = the recommended v2. So the *open* question is really: **do we ship courier v1
  without acks (tune hop/TTL generously) and add acks as a fast-follow, or build acks first?**
