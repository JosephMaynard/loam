# 16 — Opportunistic mesh / delay-tolerant delivery (the "carry my message" evolution)

> **Status: committed direction, not yet started. Phased, security-first.** This is the plan of
> record for evolving LOAM from "two nodes that share a LAN sync" into "phones that carry each other's
> messages across time and distance." It is a multi-session initiative. **Do not implement it in a
> hurry** — see the guardrails; rushing the crypto/transport is the documented way every comparable
> project has failed.

## The scenario

Person A wants to message person B, but they're never in range of each other. A meets C (same LOAM
group); later C meets B; A's message is delivered to B via C — who carried it without being able to
read it. This is **delay-tolerant networking (DTN)** with **store-carry-forward** / **epidemic
routing** — a well-mapped design space (IETF DTN, the epidemic-routing literature), not speculative.

## Why this is an *evolution* of LOAM, not a different app

LOAM's node-to-node sync engine (`docs/11`; `buildSyncDigest` / `syncWithPeer` / `importPeerMessages`
/ tombstones in `apps/server/src/app.ts`) is **already a store-carry-forward gossip substrate**. It
reconciles data between peers that share a network "for even a little while," and `docs/11` already
describes the manual version — *"sequential (courier) sync … also covers physically carrying a node
between sites."* This initiative **automates the courier and makes it multi-hop and private.**

The hard, gating dependency is **not** the sync algorithm and **not** the radio. It is:

> **stable cryptographic identity + end-to-end-encrypted, addressed mailboxes** (so an intermediary
> carries ciphertext it cannot read, ideally without even learning who is talking to whom).

Everything else is reachable from what LOAM already has.

## The four guiding stars (what comparable apps teach)

| App | What it is | The lesson for LOAM |
|-----|-----------|---------------------|
| **Briar** | Privacy-first offline messenger; direct device sync (Bluetooth/WiFi/SD), Tor when online, plus an offline **Mailbox** relay app; Bramble sync protocol is explicitly delay-tolerant | **The private-delivery template.** Combine offline delivery with strong identity + E2EE + a mailbox. **Also the honest warning:** Briar went to maintenance mode citing *battery cost* and *unreliable Android background* as unsolved. Treat background courier as a serious systems project, not a toggle. |
| **Secure Scuttlebutt** | Not a messenger — a protocol for signed, append-only feeds; Ed25519 identity; gossip replication ("ask for what's newer"); `private-box` hides recipients and recipient count | **The replication mindset.** LOAM's digest/diff/fetch + tombstones is close to SSB's signed-object replication. Borrow signed identity + private-box-style sealed envelopes. Watch its downsides: immutability makes deletion/edit awkward (LOAM's tombstones already soften this). |
| **Bridgefy** | BLE mesh SDK; direct/mesh/broadcast modes; mesh forwards to not-currently-nearby recipients; exposes **hop limit, TTL, sharing time, max propagation count** | **Transport pragmatism + propagation bounds** — exactly the knobs a courier mode needs. **Also the cautionary tale:** shipped transport-first and spent years repairing serious crypto/privacy vulnerabilities found by researchers. Don't build transport before the security model. |
| **FireChat** | Early consumer mesh (Multipeer/own mesh); huge in 2014 protests/crowds; started as public, unencrypted chat | **Crowd utility ≠ security.** It became socially useful *before* it was cryptographically trustworthy, never became a durable privacy platform, and is gone. **Do not ship useful-before-secure.** |

**One-line strategy:** *aim for Briar's privacy discipline, borrow Scuttlebutt's replication mindset,
learn from Bridgefy's transport pragmatism, and avoid FireChat's "useful first, secure later" trap.*

## Architecture (design detail)

The elegance is that **~80% is reuse**: it adds one message kind, one config block, one small crypto
package, and extends four existing sync functions — carrying private, sealed, bounded, converging
mail over the exact digest/diff/fetch/tombstone machinery LOAM already ships, without disturbing the
public-data sync that works today. A node with `mesh` disabled behaves exactly as now.

### 1. Cryptographic identity

Today `makeSessionUserId()` mints `user.<8hex>` from a random UUID and the **`loam_session` cookie is
the real identity** — no key material, node-scoped, and destroyed by a wipe/new device. Unusable for
DTN addressing (can't encrypt "to B" or verify "from A", and cross-node id collisions — cosmetic
today — would become a security bug).

Introduce an **opt-in, self-sovereign keypair identity** (`mesh.v1`) layered on top of the existing
session identity (which keeps working unchanged for LAN-local use):

- **Signing: Ed25519** (long-term identity + message authentication). **Agreement: X25519** (sealed-
  mailbox ECDH). The NaCl/libsodium/Scuttlebutt/Signal canon — boring on purpose.
- **Self-certifying id:** `meshId = "mesh." + base32(SHA-256(ed25519_pub)[0..15])` (~26 chars). The
  `mesh.` prefix distinguishes it from a legacy `user.<8hex>` everywhere ids flow; verification is
  intrinsic (recompute the hash from the pubkey — SSB's property, no PKI). A `mesh.` id feeds the
  existing `display-name`/`avatar` packages unchanged, so it gets a stable name + SVG avatar for free.
- `UserSchema` gains an **optional** `identityKey: { alg:"ed25519", sign, kx }` block (base64url
  32-byte pubkeys) — additive, old records validate unchanged. `importPeerUsers` (which already strips
  authority on import) **must also verify** that an imported user's id derives from `identityKey.sign`,
  dropping any user whose id and key disagree — this is what makes a `mesh.` id un-spoofable.

**Library — one code path, no native deps, Node 18 *and* browser (`@noble/*`).** The constraint is
tight: the PWA runs in an **insecure context** (`http://<lan-ip>`), so **`crypto.subtle` is
unavailable** — the WebCrypto path is closed regardless of Node. The embedded Android server is
**Node 18, arm64-only** (a native crypto dep reopens the SQLCipher-prebuild wound). Use
**`@noble/curves` (ed25519, x25519) + `@noble/ciphers` (xchacha20poly1305) + `@noble/hashes`** — pure
JS, uses only `getRandomValues`, runs byte-identically in the insecure-context browser and in Node
18/24 (both ends must produce identical envelopes). This is the same choice docs/08 already made.
Put it in a **new `packages/crypto`** workspace package (remember the CLAUDE.md gotcha: the server
consumes the compiled `dist/`, so build it after edits; relative imports need `.js` extensions).

**Private key storage:** Android Keystore / EncryptedSharedPreferences on the phone (so a
`LOAM_DB_KEY` rotation doesn't necessarily destroy the identity — a policy choice, see the kill-switch
tension below); on desktop/Pi, the encrypted DB config table when `LOAM_DB_KEY` is set, else a `0600`
keyfile under `.loam/`.

**Membership** stays two orthogonal layers: **node membership** = the existing `sync.token` bearer
secret checked by `syncPeerAuthorized` (gates who exchanges bytes at all — reused unchanged);
**identity membership** = the individual `mesh.` keypair. **No group key in v1** — mail is addressed
to a single recipient pubkey. Group/broadcast fan-out is v2 (N sealed copies or sender-keys — the part
Bridgefy got wrong); resist adding it before the point-to-point crypto is audited.

### 2. End-to-end-encrypted sealed mailbox

Today's `dm` is plaintext with a cleartext `recipientUserId`, stored in a dedicated column, and
**deliberately excluded from sync** (`isSyncableMessage` returns false for `dm`). It's unsuitable to
carry through C for two reasons: **(1)** a cleartext sender/recipient leaks the social graph to every
carrier; **(2)** C must store-and-forward without decrypting. So add a **new discriminated-union arm
`sealed`** that is opaque to everyone but the recipient:

```ts
// packages/schema/src/index.ts — new arm in MessageSchema / MessageCreateRequestSchema
type: z.literal("sealed"),
toTag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),  // rotating per-recipient tag — NOT the recipient id
sealed: z.string().min(1).max(64_000),           // opaque AEAD blob: e_pk ‖ nonce ‖ ciphertext ‖ tag
ttlExpiresAt: TimestampSchema,                    // hard drop-dead time
hopLimit: z.number().int().min(0).max(16),        // decremented per relay
```

`authorId` on a `sealed` message is a **neutral sentinel** (`"mesh.sealed"`), not the sender — the
real sender is inside the ciphertext.

**Envelope (sealed-sender, modelled on SSB `private-box` / libsodium `crypto_box_seal` + inner
signature — structurally what Signal sealed-sender does):**

- *Outer (anonymous encryption to recipient):* sender makes an **ephemeral X25519 keypair**;
  `shared = X25519(e_sk, B.kx)`; `key = HKDF-SHA256(shared, salt=e_pk‖B.kx, info="loam.mesh.seal.v1")`;
  `sealed = e_pk ‖ XChaCha20-Poly1305(key, nonce_24, inner)`. Only B can compute `shared`; `e_pk` is
  fresh per message so ciphertexts to B are unlinkable by key material. 24-byte nonce → random nonces
  are safe with no per-pair counter (essential for store-and-forward).
- *Inner (the real message, sender-authenticated):* `{ from: "mesh.<b32>", fromKx, createdAt, body,
  attachments?, sig: Ed25519(sender, canonical(...)) }`. B verifies `from` derives from the signing
  key and `sig` is valid — the **sealed-sender guarantee**: the sender proves who they are *to the
  recipient only*, never to a carrier.
- **Padding** `inner` to fixed buckets (256B/1K/4K/16K/64K) before sealing so ciphertext length
  doesn't fingerprint message size.

**`toTag` — routing without a recipient id.** `toTag = base64url(HKDF(B.kx, info="loam.mesh.tag.v1" ‖
epoch)[0..15])`, `epoch = floor(createdAt/windowMs)` (e.g. daily). A node can compute tags **for its
own local identities** and check "is any sealed blob addressed to someone here?" — but cannot compute
tags for strangers, so it can't attribute a blob to a person. Recipients self-select by tag (a
**probabilistic mailbox**). Honest trade-off: `toTag` gives *unlinkability to a person*, not
*path privacy* — a global observer watching every node still sees the tag reappear across hops and can
trace one message's path (not its endpoints). Full PSI/onion-rewrap privacy is v2.

**Coexistence with today's public-only sync (must not regress):** `isSyncableMessage` gets a `sealed`
branch (syncable iff unexpired, `hopLimit>0`, not tombstoned — no channel/visibility check, author
shadow-ban skipped); `buildSyncDigest` gains a `sealed: [{id,toTag,ttlExpiresAt,hopLimit}]` array
(additive — old peers ignore it, so **mixed-version meshes keep working**); `/api/sync/messages`
round-trips a `sealed` message through the existing `SyncMessagesResponseSchema` once the union has the
arm (**no new endpoint**). The `dm` type is **untouched** — LAN-local plaintext DMs to a co-present
recipient flow through the host as today; `sealed` is the cross-node, host-can't-read path. Client
decides: recipient is a live LAN `user.<8hex>` → normal `dm`; recipient is an absent `mesh.` identity →
compose `sealed`.

### 3. Bounded epidemic relay (converge, don't flood)

Bound on four axes, converge via acks, reusing the tombstone machinery:

- **TTL (time):** `ttlExpiresAt` (sender-set, capped, e.g. default 72h / max 7d). Extend the existing
  30s reaper: a `sealed` message past its TTL is deleted **and tombstoned** (`store.addTombstone` +
  `tombstones.add`) so peers can't hand it back. Add a `ttl_expires_at` column so the reaper indexes
  instead of scanning JSON.
- **Hop count (path):** `importPeerMessages` stores an accepted sealed message with `hopLimit - 1`; at
  0 a node may still *deliver* to a local recipient but must not re-advertise it. Id is constant across
  hops (dedup on id as `importPeerMessages` already does).
- **Per-carrier storage cap (space):** a new `mesh: { relay, maxCarriedBytes, maxCarriedCount, ttlMax,
  hopMax }` config. On accept, enforce the cap with **eviction = soonest-to-expire, highest-hop first**.
  `relay:false` is a valid low-resource "leaf" (receives own mail by `toTag`, carries nothing else).
- **Delivery acks → convergence (the important part):** when B opens a blob it emits a **signed
  delivery ack** `{ msgId, ackedBy, at, sig=Ed25519(B,...) }` (only B could decrypt, so only B can
  honestly ack). Acks propagate as a tiny new syncable kind (digest `acks:[msgId]`); a carrier
  receiving a valid ack **deletes its copy, records `msgId` in the existing `tombstones` table, and
  re-advertises** — an acked blob becomes indistinguishable from a locally-deleted one. This is a
  deliberate change from docs/11's "deletes don't propagate": delivery-acks are the one delete signal
  we *do* gossip, because convergence requires it. Undelivered mail is bounded by TTL+hop+cap; both
  directions terminate.

> **⚠️ The subtlest tension (flag for security review): unforgeable acks vs recipient unlinkability.**
> An unforgeable ack wants the recipient's key exposed; unlinkable delivery wants it hidden. A node
> holding the ciphertext could forge/suppress a "delivered, stop carrying" ack — a censorship/DoS
> vector. v1 compromise: ack carries `ackedBy` + signature, carriers verify well-formedness and trust
> the id; **TTL is the backstop** guaranteeing eventual purge even if acks are gamed. This needs a
> dedicated decision, not a default.

### 4. How it layers on the current sync protocol

**Reused verbatim:** `runSyncLoop` (ticker), `fetchPeerJson`/`readPeerBody` (size-capped validated
fetch — sealed blobs ≤64KB, well under `maxPeerJsonBytes`), `syncPeerAuthorized` + `x-loam-sync-token`
(**no new auth surface**), the `/api/sync/digest` + `/api/sync/messages` routes (same 404-when-disabled
indistinguishability), the `tombstones` set+table, global message-id uniqueness (idempotent gossip).
**Minimally changed:** `buildSyncDigest` (+`sealed`/`acks` arrays), `syncWithPeer` (+sealed & ack
diff), `importPeerMessages` (+`sealed` branch: skip channel logic, validate TTL/hop, enforce cap,
decrement hop, tag-match→decrypt→deliver→ack; +ack handling), `isSyncableMessage`. **Net-new:**
`packages/crypto`, the `sealed`/ack schema, the `mesh` config, client identity + compose-sealed +
tag-matched inbox + ack emission, the reaper TTL branch.

### 5. Transport reality (Android-first)

LOAM already ships the hard part on Android: `LoamHostService` (foreground service keeping the
embedded server alive screen-off) + the native `LocalOnlyHotspot` module (arm64-only). DTN needs on
top: **BLE for discovery/wake** (low-power background beacon — "I'm a LOAM relay" — solves "A and C
are near but on different networks"), then **Wi-Fi Aware (NAN) or Wi-Fi Direct for bulk sync** (sealed
blobs are tens of KB; BLE throughput is too low), the modern replacement for docs/11's "sequential
courier" dance. **iOS is materially harder — out of scope for v1** (no persistent background
execution / arbitrary BLE-central scanning / Wi-Fi Aware; Multipeer Connectivity is foreground-only).

**Battery/background is a first-class risk — it's what pushed Briar into maintenance mode.** Relay
must be **duty-cycled** (low-duty BLE advertise/scan; bring Wi-Fi up only on a confirmed nearby peer,
sync, tear down), **opt-in and metered** (`mesh.relay` + storage caps — carrying strangers' mail spends
the user's battery/disk, so make it an explicit revocable choice surfaced in the host UI), and expect
per-OEM battery-optimization allowlisting to be needed (document it honestly).

### 6. Hardest / riskiest parts (call them out)

1. **Ack unforgeability vs recipient unlinkability** (§3) — deepest tension; needs a security-review
   decision, TTL is the safety net.
2. **Metadata / traffic analysis** — `toTag` hides *who*, not *path*; defends against carriers, not a
   global passive observer. Onion re-wrap would fix it at large complexity cost (v2+).
3. **Key lifecycle & the kill switch** — does a panic wipe destroy the `mesh.` keyseed? Decide per
   security profile (docs/09); likely **hardened → identity is DB-bound and dies with the wipe.**
4. **Battery/background on real OEMs** — the Briar graveyard; duty-cycling + opt-in metering mandatory.
5. **The `@noble/*`-only constraint** — holds the line for one envelope implementation across
   insecure-context browser + Node 18 arm64; high risk if someone "optimizes" the server to
   `node:crypto` and the formats drift.
6. **Storage-cap eviction fairness / relay abuse** — a junk-blob flood can evict legitimate mail;
   `sync.token` node-admission is the primary defence, per-source rate accounting a needed follow-up.
   **Open relay (`sync.token` unset) should probably refuse to carry sealed mail** — DTN relay is a
   higher-trust operation than public gossip.

### 7. Touch-point summary

| Concern | Reused | Changed | Net-new |
|---|---|---|---|
| Identity | `makeSessionUserId`, `display-name`/`avatar` | `importPeerUsers` (verify id↔key), `UserSchema` (+`identityKey`) | `packages/crypto`, keyseed storage |
| Sealed mail | `MessageSchema` union, `createMessage`, `newMessageId` | new `sealed` arm; `db.ts` columns/index | seal/open, `toTag`, padding, compose+inbox UI |
| Relay bounds | reaper, `tombstones` set+table, `store.addTombstone` | reaper TTL branch, `importPeerMessages` hop/cap/ack | `mesh` config, eviction, signed acks |
| Sync layering | `runSyncLoop`, `fetchPeerJson`, `syncPeerAuthorized`, `/api/sync/*` | `buildSyncDigest`, `syncWithPeer`, `importPeerMessages`, `isSyncableMessage`, `SyncDigestSchema` | ack kind, sealed digest arrays |
| Transport | `LoamHostService`, `LocalOnlyHotspot`, `with-loam-host.js` | duty-cycled hosting policy | BLE discovery, Wi-Fi Aware bulk link (Android-first) |

## Phased roadmap (the fall-proof plan)

Each phase is independently valuable, has an explicit acceptance gate, and — crucially — most of the
security-critical work is **verifiable on desktop/CI without any phone hardware**. Do the phases in
order. **A later phase must never ship before its predecessor's gate is green.**

### Phase 0 — Cryptographic identity foundation *(no hardware; isolated; no behaviour change)*
- **Goal:** a stable keypair identity primitive, in its own package, wired into *nothing* yet.
- **Do:** create `packages/identity` (or extend `@loam/schema`) with keypair generation, id-derived-
  from-public-key, sign/verify, and sealed-box encrypt/decrypt, using the primitives chosen in the
  Architecture section. **No native deps** (must run on the embedded Node 18 Android runtime and
  desktop). Full round-trip + known-answer unit tests.
- **Gate:** package builds and tests pass on the workspace; used by no runtime path yet; a written
  crypto note reviewed (ideally a second set of eyes) before anything depends on it.

### Phase 1 — E2EE sealed mailbox in the sync layer *(no hardware; desktop/LAN verifiable)*
- **Goal:** a message addressed to a recipient's public key that syncs as opaque ciphertext; the
  existing public-only sync keeps working untouched.
- **Do:** add the sealed-mailbox message kind to `@loam/schema` and the sync digest; encrypt on send,
  store ciphertext, decrypt only for the recipient. Public channel/DM behaviour unchanged. Sealed-
  sender metadata protection per the Architecture section.
- **Gate:** two desktop nodes deliver an A→(node)→B sealed message that a third node relays without
  being able to read it; public-only sync and all existing tests still green; new privacy tests
  (intermediary sees only ciphertext, cannot learn sender/recipient).

### Phase 2 — Bounded epidemic relay *(no hardware; verifiable)*
- **Goal:** messages converge to delivery instead of flooding forever.
- **Do:** TTL, hop-count, per-carrier storage caps; **ack-based purge reusing the tombstone table** so
  a delivered message is dropped mesh-wide. Multi-node simulation in tests.
- **Gate:** simulated N-node relay delivers and then garbage-collects; storage stays bounded; no
  resurrection of delivered/expired mail; DoS/spam bounds tested.

### Phase 3 — Opportunistic transport, Android-first *(hardware; native)*
- **Goal:** phones discover each other and sync automatically when near, foreground.
- **Do:** BLE beacon for "is this a LOAM peer + which group?" discovery/wake, then a Wi-Fi Aware /
  Direct / hotspot handoff for the bulk sync (runs the Phase 1–2 protocol). Build on the existing
  `LoamHostService` foreground service + LocalOnlyHotspot native module. **Android only** to start.
- **Gate:** two physical Android phones, app foregrounded, auto-discover and sync a sealed message
  with no user action beyond being in range. **Requires real-device testing — no emulator substitute.**

### Phase 4 — Background duty-cycling + battery *(hardware; the hard part)*
- **Goal:** it works while the phone is used normally, without wrecking the battery.
- **Do:** BLE `PendingIntent`-based background discovery (Android's recommended path; avoid blunt
  periodic scans), burst-scan/back-off duty cycling, Doze-aware scheduling on top of the foreground
  service. **This is where Briar stalled — budget for it, measure battery, be willing to ship a
  "foreground/while-charging only" mode if background proves too costly.**
- **Gate:** a measured battery budget over a normal day; reliable-enough background delivery on a
  target device set; honest documentation of the limits.

### Phase 5 — LoRa fixed relays *(hardware; separate initiative)*
- **Goal:** long-range backbone between opportunistic clusters (Pi + LoRa hat), carrying the *same*
  protocol (text-only, aggressive bandwidth budgeting) — as `docs/11` already anticipates.

### iOS — explicitly out of scope for v1
Apple's background limits (coalesced BLE discovery, ~10s wake budget, no arbitrary background P2P)
make an always-on courier mesh far harder on iPhone. LOAM is Android-only today anyway. Revisit iOS
only after Android Phases 3–4 prove the model; expect a foreground-only experience there.

## Non-negotiable guardrails

1. **Security before transport.** No opportunistic-transport code (Phase 3+) ships before the sealed-
   mailbox + relay security model (Phases 0–2) is built and reviewed. This is the FireChat/Bridgefy
   lesson, stated as a rule.
2. **Don't rush the crypto.** Phase 0's primitives get a deliberate design + a review pass before
   anything depends on them. A wrong primitive is load-bearing tech debt.
3. **Public-only sync must keep working** at every phase — this feature is *additive*, gated, and
   off by default.
4. **Metadata is part of the threat model.** An intermediary carrying mail must not learn who is
   talking to whom (sealed sender), not just be unable to read the body.
5. **Android-first, hardware-verified.** Phases 3–4 are real-device work; don't claim them done off
   an emulator.
6. **Battery is a first-class acceptance criterion,** not an afterthought (Briar's warning).

## Risk register

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Background reliability / battery (Briar's blocker) | High | Phase 4 is explicitly the hard part; fallback to foreground/while-charging mode; measure, don't assume |
| iOS background constraints | High (if iOS wanted) | Out of scope for v1; Android-first |
| Rushed/incorrect crypto (Bridgefy's history) | High | Phase 0 review gate; standard vetted primitives; no bespoke schemes |
| Metadata leakage (who↔who) | Medium-High | Sealed-sender envelope; test that intermediaries learn nothing but ciphertext |
| Open-mesh spam / storage DoS | Medium | Group membership (shared keys), per-carrier caps, TTL/hop bounds, ack-purge |
| Delivery latency / non-delivery expectations | Medium | UX must frame it as "will deliver when a path exists," not instant; delivery acks |
| Legal/framing as networks/scale grow | Medium | See `MISSION.md` / `ACCEPTABLE_USE.md`; a purely local courier is materially different from a hosted relay — revisit if central relays/directories are ever added |

## Where to pick up next session

Start at **Phase 0**. Read this file and the Architecture section, then the existing sync engine in
`apps/server/src/app.ts` and `packages/schema/src/index.ts`. The first concrete deliverable is the
`packages/identity` primitive with tests — nothing wired into the running app yet.
