# 16 — Opportunistic mesh / delay-tolerant delivery (the "carry my message" evolution)

> **Status: Phases 0–2 BUILT & TESTED; Phase 3 SCAFFOLDED (native-unverified).** The sealed-mailbox
> A→C→B delivery works today over the existing sync transport (configured peers / courier). The
> Phase-3 opportunistic transport (BLE discovery + Wi-Fi Aware bulk transfer) is now scaffolded end to
> end — native Expo module, TS transport abstraction, launcher courier, and two loopback bridge
> endpoints — but the Kotlin has **not** been compiled or run against radios (CI has none). See
> **docs/17** for the exact real-device test procedure and every stub/risk. The rest of this doc is the
> full design; the box below records what actually shipped and where it differs.

## Implementation status (v2 — contact-based secure addressing, shipped)

Building on v1 (below), the mesh now addresses sealed mail by the recipient's **self-certifying
`mesh.` id** and routes it with a **secret-token tag** — closing the two v1 privacy/security gaps
(metadata-linkability and active key-substitution) at once:

- **Mesh identity cards + contact exchange** (`MeshIdentityCardSchema`; `GET /api/mesh/identity`,
  `POST/GET /api/mesh/contacts`; DB `mesh_contacts`). A card carries the public keys **plus the secret
  `mailboxToken`**, so it is exchanged deliberately (shown as a QR / copied string, added by the
  recipient) and **never rides sync**. Discovery no longer depends on a recipient having posted
  publicly. Contacts are **per-local-user and private** — one user's address book isn't exposed on the
  shared roster. Likewise, when sealed mail is delivered the remote sender's display record
  (`mesh.<hash>`) is **recipient-scoped**: `visibleUsers` hides it from everyone but the recipients it
  mailed, and its `userUpserted` is targeted to the recipient — so a third party never learns from the
  roster that some local user just received mesh mail (a timing/metadata leak the first cut had).
- **Self-certifying addressing defeats *key* substitution.** `POST /api/mesh/messages` now takes
  `toMeshId` and seals only to a **contact** the sender explicitly added. `addMeshContact` re-verifies
  `meshId === base32(sha256(sign))` **and** `verifyKxBinding(sign, kx, kxSig)`, so a card whose signing
  or agreement key doesn't match its id is rejected before it can be sealed to — the
  active-MITM key-substitution hole (v1 deviation 2b) is closed. **Scope of the guarantee:** this
  authenticates the *keys* against the id, not the whole card. The `mailboxToken` is unauthenticated
  (it's independent secret material — see the deviation list), so an attacker who can tamper the
  serialized card in transit while leaving `sign`/`kx`/`kxSig` intact can swap only the token; the
  result is delivery failure (the body stays sealed to the real `kx`), not disclosure. Card exchange
  is trusted-out-of-band by design (QR/paste).
- **Metadata-unlinkable routing tags.** `toTag` is now derived from the recipient's **secret**
  `mailboxToken` (`localTagsForWindow` and the sender both call `mailboxTag(token, epoch)`), not the
  public `kx`. A passive carrier holding the sealed blob **cannot correlate it to a recipient** — the
  v1 linkability leak (deviation 1) is gone. Confidentiality was already preserved; this adds privacy.
- **Still gated & non-breaking**: all of the above is behind `mesh.enabled` (default off; the client
  shows the contacts/card UI only when `networkConfig.enableMesh`). Public sync stays byte-identical
  when off. Regression tests cover card exchange + delivery, forged-card rejection (id/key mismatch and
  bad kx binding), send-to-non-contact 404, shadow-ban silent-drop, the 3-node A→C→B carry, and that
  the tag is token-derived (not kx-derived).

The published `User.identityKey` (public keys, synced) remains for mesh-capability display, but is no
longer a sealing target — you cannot seal to it without the secret token, which only a card conveys.

**Remaining v2+ follow-ups**: an in-band contact-*request* flow (today the card is exchanged fully
out-of-band); **mutual / rotating** sync peer authentication (the shared-bearer `sync.token` +
`x-loam-sync-token` check via `syncPeerAuthorized` is already built — per-peer keys and rotation are
the remaining hardening); group/broadcast sealed fan-out; and the hardware transport (Phase 3, below).

## Implementation status (v1 — shipped)

- **Phase 0 — `packages/crypto` (`@loam/crypto`)**: Ed25519 identity, X25519 sealed-sender envelope
  (ephemeral-key ECDH → HKDF → XChaCha20-Poly1305, inner Ed25519 signature, AAD-bound relay
  metadata), self-certifying `mesh.` id, `kx`↔`sign` binding, routing tags. Pure JS (`@noble/*`,
  pinned Node-18-safe). 13 tests.
- **Phase 1 — sealed mailbox (server)**: `sealed` `Message` arm, `User.identityKey`, `mesh` config,
  `SyncDigest.sealed`. **Entirely server-side** — because LOAM's host is already trusted for its own
  local users, per-user mesh keypairs live server-side (DB `mesh_identities`, public keys published
  on the user record + synced) and the E2E guarantee is against **carrier nodes**, not a user's home
  host. `POST /api/mesh/messages` seals to a known recipient's key; delivery decrypts into an ordinary
  DM.
- **Phase 2 — bounded relay (server)**: carriers import sealed blobs opaquely and deliver-if-ours,
  else relay onward (hop-decremented, per-carrier cap), else drop; the reaper expires + tombstones by
  TTL. **TTL + hop + cap converge — acks are intentionally NOT implemented** (that sub-design is
  threat-model-*blocked*, §3/§6). Proven by a 3-node A→C→B test: the carrier relays mail whose
  ciphertext never contains the plaintext; the recipient decrypts it.
- **Gated & non-breaking**: everything is behind `mesh.enabled` (default off, currently set via
  `config.json` / `PATCH /api/admin/config` — an admin-UI toggle is a follow-up). With it off, public
  sync is byte-identical to before; all pre-existing tests still pass.

**Where v1 differs from the design below (deliberate, documented):**

1. ~~**Routing tag privacy** — v1 derived `toTag` from the public `kx` (no metadata-unlinkability).~~
   **Resolved in v2**: `toTag` is derived from the recipient's secret `mailboxToken`, distributed via
   the mesh identity card, so a passive carrier can't correlate a blob to a recipient.
2. ~~**Recipient discovery** — a sender needed the recipient's published `identityKey`, which only
   propagated once they'd posted publicly.~~ **Resolved in v2**: out-of-band mesh identity cards
   (`GET /api/mesh/identity` → QR/paste → `POST /api/mesh/contacts`) are the discovery+exchange channel.
2b. ~~**Active key-substitution (residual)** — v1 ids were session-random, not key-derived, so an active
   MITM introducing a user before their real key synced could bind a forged key.~~ **Resolved in v2**
   for the *keys*: sealing addresses the **self-certifying `mesh.` id** and seals only to a **contact**
   whose card was re-verified server-side (`meshId === base32(sha256(sign))` + `kxSig` binding) at add
   time, so a card with a substituted signing/agreement key is rejected. The `mailboxToken` in the card
   is *not* authenticated (independent secret material), so a tampered token yields delivery failure,
   not disclosure — full card integrity would need a signature over the whole card. (Transport-level
   `sync.token` peer admission is already built; mutual/rotating peer auth is the remaining hardening.)
3. **AAD** binds `toTag`+`ttlExpiresAt` (both immutable); the original hop budget is bounded by the
   schema max rather than the signature (v2 refinement).
4. **Phase 3 (opportunistic transport — BLE discovery + Wi-Fi Aware)** is now **scaffolded, not
   verified** (was "not built"). What landed: a new `apps/app/modules/loam-mesh-transport` Expo module
   (Kotlin BLE advertise/scan + a fixed LOAM GATT service, Wi-Fi Aware publish/subscribe + a data-path
   socket, a BLE-only chunked *fallback* left as a marked TODO), a TS `MeshTransport` abstraction +
   RN↔launcher courier bridge (`apps/app/src/mesh/`), and two **loopback-only** server endpoints
   (`GET /api/mesh/outbound` + `POST /api/mesh/inbound`) that let the in-process launcher shuttle sealed
   blobs between the radio and the existing relay — a radio-fed mirror of the `/api/sync/*` sealed path,
   reusing `acceptSealedFromPeer` verbatim so no new crypto/relay trust is introduced. The bridge
   endpoints are covered by desktop tests (A→B, A→C→B carrier-can't-read, idempotent re-delivery,
   404-when-off). The **Kotlin is native-unverified** (no radios in CI/emulator — the same principled
   call as the on-device-LLM inference stub); a real-device build is expected to need adjustments to the
   Wi-Fi Aware data-path handshake + port exchange, and to finish the BLE fallback. Full procedure +
   risk list: **docs/17**. As before, the sealed layer already relays over **any** transport it's given,
   so Phase 3 is *automation of discovery*, not a prerequisite for the feature to work.
5. **Tombstone GC** — expired-sealed tombstones aren't yet horizon-GC'd (matches docs/11's existing
   unbounded-tombstone behaviour); the bounded-GC in §3 is a follow-up.
6. **Attachments** on sealed messages are rejected (text-only v1, as §2 specifies).
7. **Schema bounds** — the shipped `SealedMessageSchema` uses generous round caps (`toTag` ≤ 64 chars,
   `sealed` ≤ 90 000 chars) rather than the tight computed bounds in §2 below (22 / 87 480). Same
   headroom for the full-size envelope, just simpler numbers.

---

> **Design of record (below).** Phased, security-first. **Do not rush the unbuilt parts** — rushing
> the crypto/transport is the documented way every comparable project has failed.

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
- `UserSchema` gains an **optional** `identityKey: { alg:"ed25519", sign, kx, kxSig }` block (base64url
  32-byte pubkeys; `kxSig` a 64-byte signature) — additive, old records validate unchanged. Because the
  `mesh.` id derives from **`sign` only**, a raw `kx` is unauthenticated and a carrier could swap it to
  hijack the sealed channel, so `kx` must be **bound to `sign`**: the identity owner publishes
  `kxSig = Ed25519(sign_sk, "loam.mesh.kxbind.v1" ‖ kx)`. `importPeerUsers` (which already strips
  authority on import) **must verify, for any record carrying `identityKey`:** (a) the user's id derives
  from `identityKey.sign` (the un-spoofable-id check), and (b) `kxSig` is a valid signature by `sign`
  over `kx` — **dropping any user whose id/key disagree or whose `kx` is missing, malformed, or
  unbound.** Records **without** an `identityKey` block are legacy and pass through untouched (LAN-only,
  no sealed mail). (A deterministic derivation of `kx` from the Ed25519 seed is an acceptable
  alternative to `kxSig` if both ends compute it identically, but the explicit signed binding is
  preferred — it survives independent key rotation.)

**Library — one code path, no native deps, Node 18 *and* browser (`@noble/*`).** The constraint is
tight: the PWA runs in an **insecure context** (`http://<lan-ip>`), so **`crypto.subtle` is
unavailable** — the WebCrypto path is closed regardless of Node. The embedded Android server is
**Node 18, arm64-only** (a native crypto dep reopens the SQLCipher-prebuild wound). Use
**`@noble/curves` (ed25519, x25519) + `@noble/ciphers` (xchacha20poly1305) + `@noble/hashes`** — pure
JS, uses only `getRandomValues`, runs byte-identically in the insecure-context browser and in Node
18/24 (both ends must produce identical envelopes). This is the same choice docs/08 already made.

**Pin to Node-18-compatible releases.** The embedded Android runtime is **Node 18** (arm64), so pin
the `@noble/*` majors verified to run there — the `@noble/curves` 1.x / `@noble/ciphers` 1.x /
`@noble/hashes` 1.x line (ES2020, depending only on `globalThis.crypto.getRandomValues`, which Node 18
provides) — with exact `package.json` versions rather than floating `^` ranges that could roll onto a
later major that raises its engines floor or emits syntax the Node 18 build can't parse. Treat "builds
and runs on Node 18 arm64" as a CI constraint so a dependency bump can't silently break the embedded
server; the pure-JS + insecure-context-browser + Node baseline is non-negotiable.

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
sealed: z.string().min(1).max(87_480),           // base64url(e_pk‖nonce‖ct‖tag); ≤65 608 raw bytes — see §2 size math
ttlExpiresAt: TimestampSchema,                    // hard drop-dead time
hopLimit: z.number().int().min(0).max(16),        // decremented per relay
```

`authorId` on a `sealed` message is a **neutral sentinel** (`"mesh.sealed"`), not the sender — the
real sender is inside the ciphertext. Because the sentinel makes the author invisible to the
sync-time shadow-ban check, **shadow-ban must be enforced at creation instead:** `createMessage`
resolves the sealing identity's local `mesh.` id to its session/moderation record and **refuses to
create a `sealed` message for a shadow-banned (or banned) sender**, exactly as it drops a shadow-banned
public post — with a test asserting a shadow-banned identity's sealed mail is never minted or
advertised. (A node can't enforce this on *relayed* strangers' mail — it can't read the sender — but
the originating node always can, which is where the ban lives.)

**Envelope (sealed-sender, modelled on SSB `private-box` / libsodium `crypto_box_seal` + inner
signature — structurally what Signal sealed-sender does):**

- *Outer (anonymous encryption to recipient):* sender makes an **ephemeral X25519 keypair**;
  `shared = X25519(e_sk, B.kx)`; `key = HKDF-SHA256(shared, salt=e_pk‖B.kx, info="loam.mesh.seal.v1")`;
  `sealed = e_pk ‖ XChaCha20-Poly1305(key, nonce_24, inner)`. Only B can compute `shared`; `e_pk` is
  fresh per message so ciphertexts to B are unlinkable by key material. 24-byte nonce → random nonces
  are safe with no per-pair counter (essential for store-and-forward).
- *Inner (the real message, sender-authenticated):* `{ from: "mesh.<b32>", fromKx, createdAt, body,
  sig: Ed25519(sender, canonical(...)) }` (the exact signed field set is fixed in the authentication
  bullet below). B verifies `from` derives from the signing key and `sig` is valid — the
  **sealed-sender guarantee**: the sender proves who they are *to the recipient only*, never to a
  carrier.
- **Attachments are rejected on `sealed` messages in v1 (text-only).** A normal `attachments` entry is
  an `att_` id pointing at a **server-local** file the originating host serves over `/api/attachments`;
  a remote recipient reached only via carriers can't resolve it, and shipping the id in cleartext would
  leak a fetchable handle. So `createMessage` **rejects a `sealed` message carrying `attachments`** and
  the compose UI hides them for sealed mail (this is why the inner payload omits `attachments`).
  **Follow-up (v2):** carry attachments *inside* the sealed envelope — an encrypted manifest plus the
  ciphertext bytes sized into the same padding buckets — so they inherit the sealed-sender/opacity
  guarantees instead of relying on a host-local fetch.
- **Padding** `inner` to fixed buckets (256B/1K/4K/16K/64K) before sealing so ciphertext length
  doesn't fingerprint message size. This sets the **`sealed` size cap**: the largest bucket is 64 KiB =
  65 536 B of padded plaintext; XChaCha20-Poly1305 adds no length expansion beyond its 16 B tag, and the
  envelope prepends the 32 B ephemeral `e_pk` and 24 B nonce → **raw blob ≤ 65 536 + 32 + 24 + 16 =
  65 608 bytes**. base64url-encoded that is `ceil(65 608 / 3) × 4 = 87 480` characters, so the schema
  uses `.max(87_480)` — **not** `64_000`, which would truncate a full-size message — while `.min(1)`
  keeps the non-empty guard.
- **Authenticate the immutable relay metadata.** `toTag`, `ttlExpiresAt`, and the **original** hop
  budget `hopLimit0` travel in cleartext (carriers route on them) but must be **bound to the envelope**
  so a carrier can't extend the TTL, retarget the tag, or reset hops undetected. Include them in the
  inner signed payload — `sig = Ed25519(sender, canonical({from, fromKx, createdAt, body, toTag,
  ttlExpiresAt, hopLimit0}))` — **and** pass the same triple as the XChaCha20-Poly1305 **AAD**, so both
  the signature and the outer AEAD fail on any edit. The recipient recomputes and rejects on mismatch; a
  tampered blob neither opens nor verifies. The only field that legitimately mutates in flight is the
  **remaining** hop count (not signed — it can't be), constrained instead by the merge rules in §3.

**`toTag` — routing without a recipient id.** The tag must be computable **only by the recipient and
the senders it authorizes** — never from public key material. Deriving it from `B.kx` (which is
published in `UserSchema.identityKey`, so every peer already holds it) would let anyone with B's pubkey,
or a global observer, recompute B's tags and correlate *all* mail to B — the unlinkability claim would
be false. Instead key the tag on a **secret mailbox token** `B.mtk` (32 random bytes) that B generates
with its keypair and **discloses only to contacts it authorizes to write to it**, handed over
out-of-band at contact exchange — carried in the join/contact QR payload right next to the `mesh.`
pubkey, and re-shareable/rotatable the same way. `toTag = base64url(HKDF(B.mtk, info="loam.mesh.tag.v1"
‖ epoch)[0..15])`, `epoch = floor(createdAt/windowMs)` (e.g. daily). A node computes tags **for its own
local identities** (it holds their `mtk`) and checks "is any sealed blob addressed to someone here?"; an
authorized sender computes B's tag only because B gave it `B.mtk`; a carrier holding neither the token
nor a local copy **cannot recompute the tag from the published pubkey**, so it can neither attribute a
blob to a person nor forge a tag. Recipients self-select by tag (a **probabilistic mailbox**). **Epoch
coverage on lookup:** because the tag is stamped with the message's `createdAt` epoch, a recipient must
*not* match only the current epoch — it computes its tag set for **every epoch in the live TTL window**,
from `floor((now − ttlMax)/windowMs)` to `floor((now + skew)/windowMs)` (a small clock-skew margin), so
mail composed in epoch N is still recognised when checked in epoch N+1 or any later epoch before it
expires. Honest trade-off: the secret-token `toTag` gives *unlinkability to a person for anyone who
lacks `mtk`*, not *path privacy* — an authorized carrier that itself holds `B.mtk`, or a global observer
correlating one tag value as it reappears across hops, can still trace a single message's path (never
its endpoints), and rotating `mtk` means re-distributing it to contacts. Full PSI/onion-rewrap privacy
is v2.

**Coexistence with today's public-only sync (must not regress):** `isSyncableMessage` gets a `sealed`
branch (syncable iff **`mesh.enabled`**, unexpired, `hopLimit>0`, not tombstoned — no channel/visibility
check; the author sentinel means **sender shadow-ban is enforced at *creation*, not here**, see §3);
`buildSyncDigest` gains a `sealed: [{id,toTag,ttlExpiresAt,hopLimit}]` array **only when `mesh.enabled`**
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
- **Bounded tombstone retention (don't grow forever):** sealed TTL/ack tombstones would otherwise
  accumulate one row per message ever carried — unbounded — so give them their own **GC horizon**. Store
  a small `expires_at` on each sealed/ack tombstone = the message's `ttlExpiresAt` **plus a
  re-advertisement grace window** `graceMs` (comfortably longer than the mesh's convergence/gossip
  period, e.g. a few ×`ttlMax`); the reaper deletes such a tombstone only once `now > expires_at`. This
  is safe because after `ttlExpiresAt` the message is *independently* rejectable on its own expiry: an
  inbound copy past its (signed) `ttlExpiresAt` is dropped by the TTL check whether or not a tombstone
  still exists, so the tombstone only needs to outlive the message's live window plus grace — long
  enough to stop re-import churn — not forever. (Public-data sync tombstones keep docs/11's existing
  policy; only the sealed/ack tombstones get this horizon.)
- **Hop count (path):** `importPeerMessages` stores an accepted sealed message with `hopLimit - 1`; at
  0 a node may still *deliver* to a local recipient but must not re-advertise it. Id is constant across
  hops (dedup on id as `importPeerMessages` already does). **Merge rules for duplicate copies (a blob
  arrives from two carriers):** dedup by id as today, and treat relay state as **monotonic** — accept a
  later copy only if its mutable state is *validly more-progressed*, never regressed or inflated.
  Concretely: re-derive every bound from the **signed** `ttlExpiresAt`/`toTag`/`hopLimit0` (never the
  cleartext routing fields, so a forged larger `hopLimit0` fails the signature); **reject** any copy
  whose `ttlExpiresAt` exceeds the signed value or whose `toTag` differs from the signed value (that
  blob is tampered); and **never raise** the stored remaining hop count —
  `remaining ← min(existing_remaining, incoming_remaining)`, so a copy claiming *more* remaining hops is
  a hop-budget reset attempt and is clamped, not trusted. Duplicates thus converge to the *least*
  remaining budget, and no carrier can extend a message's life, retarget it, or grant it more hops.
- **Per-carrier storage cap (space):** a new `mesh: { enabled, relay, maxCarriedBytes, maxCarriedCount,
  ttlMax, hopMax }` config. On accept, enforce the cap with **eviction = soonest-to-expire, highest-hop
  first**. `relay:false` is a valid low-resource "leaf" (receives own mail by `toTag`, carries nothing
  else).
- **`mesh.enabled` — the master opt-in (default `false`).** The entire sealed-mail surface is gated on
  this one flag; **public-data sync is completely unchanged when it is `false`** — the digest carries no
  `sealed`/`acks` arrays and every sealed path is inert. Enforcement points, each short-circuiting when
  `mesh.enabled` is false: **`createMessage`** refuses to create a `sealed` message (like any disabled
  feature flag); **`isSyncableMessage`** returns false for the `sealed`/ack branch so nothing sealed is
  advertised or served; **`buildSyncDigest`** omits the `sealed`/`acks` arrays entirely;
  **`importPeerMessages`** ignores inbound `sealed`/ack entries (no accept, no store, no cap logic); the
  **reaper's** sealed-TTL/tombstone branch does nothing; and the client **compose-sealed / tag-matched
  inbox UI** is hidden. `mesh.relay` is a *second, narrower* gate governing only the carrying of *other
  people's* mail: with `mesh.enabled:true, relay:false` a node still creates and receives its own sealed
  mail but carries nothing for others; with `mesh.enabled:false` none of it exists.
- **Delivery acks → convergence (the important part).** When B opens a blob it can emit a **delivery
  ack** so carriers stop carrying a delivered message. **This sub-design is BLOCKED pending a
  threat-model decision (§6.1) and must not ship in Phase 2 in its identity-exposing form:** the naïve
  ack `{ msgId, ackedBy, at, sig=Ed25519(B,…) }` names the recipient (`ackedBy` = B's `mesh.` id) with a
  signature verifiable against B's public key, which re-links a delivered message to B and undoes the
  `toTag` unlinkability the sealed envelope buys. Before Phase 2 the ack must instead prove "the holder
  of the sealing secret for `msgId` acked" **without naming B** — e.g. a per-message ack key derived
  inside the envelope (`ackKey = HKDF(shared, info="loam.mesh.ack.v1")`, known only to sender and
  recipient), so the ack is `{ msgId, at, mac=HMAC(ackKey, msgId‖at) }`, blinded of any recipient
  identity and validatable only by a carrier that also holds `ackKey` — or ack is dropped entirely and
  TTL+hop+cap remain the sole convergence mechanism. **Ack record, once the blinded form is chosen:** a
  **standalone syncable kind** (not message metadata — the delivered message is being deleted),
  advertised as its own `acks:[{msgId}]` digest array; **on the wire** `{ msgId, at, mac }` (no author,
  no signature over B's key); **stored** in a dedicated `mesh_acks` table keyed by `msgId` alongside the
  `tombstones` table. A carrier receiving a **well-formed, validatable** ack **deletes its copy of
  `msgId`, writes `msgId` to the existing `tombstones` table, records the ack in `mesh_acks`, and
  re-advertises both** — an acked blob becomes indistinguishable from a locally-deleted one.
  **Mixed-version:** old peers lacking the `acks` digest array simply ignore it and keep carrying until
  TTL (safe; convergence just slower). This is a deliberate change from docs/11's "deletes don't
  propagate": delivery-acks are the one delete signal we *do* gossip, because convergence requires it.
  Undelivered mail is bounded by TTL+hop+cap regardless, so **both directions terminate even if ack
  ships disabled.**

> **⚠️ The subtlest tension (BLOCKED — security-review decision required before Phase 2): unforgeable
> acks vs recipient unlinkability.** An ack verifiable against B's public key exposes B's identity and
> re-links delivered mail to B; an unlinkable ack cannot name B. The identity-exposing
> `ackedBy`+signature form is **rejected**, not adopted as a "v1 compromise," because it silently undoes
> the envelope's unlinkability. The candidate replacement is the per-message blinded MAC above (`ackKey`
> shared only by sender+recipient, no recipient id on the wire); a carrier holding the ciphertext could
> still forge/suppress an ack it can validate — a censorship/DoS vector — so **TTL remains the backstop**
> guaranteeing eventual purge even if acks are gamed or disabled. Ship acks only after this decision
> lands; until then convergence rests on TTL+hop+cap.

### 4. How it layers on the current sync protocol

**Reused verbatim:** `runSyncLoop` (ticker), `fetchPeerJson`/`readPeerBody` (size-capped validated
fetch — a sealed blob is ≤65 608 raw bytes → ≤87 480 base64url chars (§2), well under `maxPeerJsonBytes`), `syncPeerAuthorized` + `x-loam-sync-token`
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

1. **Ack unforgeability vs recipient unlinkability** (§3) — deepest tension; **blocked pending a
   security-review decision.** The identity-exposing `ackedBy` form is rejected; the blinded per-message
   MAC is the candidate; TTL is the safety net and acks ship only after the decision lands.
2. **Metadata / traffic analysis** — the secret-token `toTag` hides *who* from anyone without `B.mtk`
   (carriers included), but not *path*: an authorized carrier that holds `mtk`, or a global passive
   observer correlating a repeated tag across hops, still traces a message's route (never its
   endpoints). Token distribution/rotation is the added cost. Onion re-wrap would fix path privacy at
   large complexity cost (v2+).
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
| Identity | `makeSessionUserId`, `display-name`/`avatar` | `importPeerUsers` (verify id↔`sign`, `kx`↔`sign`), `UserSchema` (+`identityKey`+`kxSig`) | `packages/crypto`, keyseed storage |
| Sealed mail | `MessageSchema` union, `createMessage`, `newMessageId` | new `sealed` arm; `db.ts` columns/index | seal/open, `toTag`, padding, compose+inbox UI |
| Relay bounds | reaper, `tombstones` set+table, `store.addTombstone` | reaper TTL branch, tombstone GC horizon, `importPeerMessages` hop/cap/ack | `mesh` config, eviction, blinded acks (§3 — blocked) |
| Sync layering | `runSyncLoop`, `fetchPeerJson`, `syncPeerAuthorized`, `/api/sync/*` | `buildSyncDigest`, `syncWithPeer`, `importPeerMessages`, `isSyncableMessage`, `SyncDigestSchema` | ack kind, sealed digest arrays |
| Transport | `LoamHostService`, `LocalOnlyHotspot`, `with-loam-host.js` | duty-cycled hosting policy | BLE discovery, Wi-Fi Aware bulk link (Android-first) |

## Phased roadmap (the fall-proof plan)

Each phase is independently valuable, has an explicit acceptance gate, and — crucially — most of the
security-critical work is **verifiable on desktop/CI without any phone hardware**. Do the phases in
order. **A later phase must never ship before its predecessor's gate is green.**

### Phase 0 — Cryptographic identity foundation *(no hardware; isolated; no behaviour change)*
- **Goal:** a stable keypair identity primitive, in its own package, wired into *nothing* yet.
- **Do:** create **`packages/crypto`** (the single canonical home for this — *not* `packages/identity`,
  *not* folded into `@loam/schema`) with keypair generation, id-derived-from-public-key, sign/verify,
  and sealed-box encrypt/decrypt, using the primitives chosen in the Architecture section. **No native
  deps** (must run on the embedded Node 18 Android runtime and desktop). Observe the CLAUDE.md build
  boundary: the server consumes the compiled **`dist/`**, so rebuild after edits, and relative imports
  inside `packages/crypto/src` use explicit **`.js`** extensions. Full round-trip + known-answer unit
  tests.
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

### Phase 3 — Opportunistic transport, Android-first *(hardware; native)* — **SCAFFOLDED**
- **Goal:** phones discover each other and sync automatically when near, foreground.
- **Do:** BLE beacon for "is this a LOAM peer + which group?" discovery/wake, then a Wi-Fi Aware /
  Direct / hotspot handoff for the bulk sync (runs the Phase 1–2 protocol). Build on the existing
  `LoamHostService` foreground service + LocalOnlyHotspot native module. **Android only** to start.
- **Landed (scaffold):** `apps/app/modules/loam-mesh-transport` (BLE advertise/scan + GATT service,
  Wi-Fi Aware publish/subscribe + data-path socket, BLE-only chunked fallback TODO), the TS
  `MeshTransport` + `mesh-courier` bridge (`apps/app/src/mesh/`), the launcher courier brain
  (`nodejs-project-template/main.js`), and the loopback `GET /api/mesh/outbound` / `POST /api/mesh/inbound`
  endpoints. Manifest perms (BLUETOOTH_ADVERTISE/SCAN/CONNECT + optional BLE/Wi-Fi-Aware features) via
  `with-loam-host.js`. Bridge endpoints are desktop-tested; the native transport is **unverified** (no
  radios in CI). See **docs/17**.
- **Gate (NOT YET MET — needs hardware):** two physical Android phones, app foregrounded, auto-discover
  and sync a sealed message with no user action beyond being in range. **Requires real-device testing —
  no emulator substitute.** docs/17 is the procedure that closes this gate.

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
**`packages/crypto`** primitive with tests — nothing wired into the running app yet.
