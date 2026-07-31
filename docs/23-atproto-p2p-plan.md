# 23 — Portable identity & user-owned signed repos: plan of record (for review)

**Status: plan of record, pre-implementation — written to be torn apart by a crypto reviewer.** This is
the rigorous successor to the `docs/22` briefing. It assumes `docs/16` (opportunistic mesh — the
identity/crypto/relay foundation this reuses) and `docs/11` (node-to-node sync). The goal of circulating
it is to harden the **threat model and the two or three hard cryptographic decisions** *before* any code.
Read `CLAUDE.md` for the built baseline.

---

## 1. Goal & non-goals

**Goal.** Give a LOAM user an **optional, portable, cryptographic identity** and a **user-owned, signed,
content-addressed record log** (their posts), so that:
- the same identity + history can move between nodes, and
- any node can verify *who authored a record* **without trusting the node that relayed it**.

Today identity is anonymous, ephemeral, and **node-local** (`user.<8hex>` minted from a session cookie in
`getSessionUserId`); data is **node-owned** (rows in one node's SQLite). AT Proto's insight is to make both
**user-owned**. We borrow that insight.

**Non-goals (v1).**
- **Not wire-compatible with the real AT Protocol network.** No DNS handle resolution, no HTTPS PDS
  discovery, no global relays/firehose, no `did:plc` directory. Those are fundamentally online and fight
  LOAM's first priority (off-grid, no internet, no accounts). Full interop is a separate, online-only,
  much larger question — explicitly deferred (see §9).
- **Not replacing anonymous mode.** The anonymous, ephemeral, node-local default is untouched; portable
  identity is strictly opt-in and flag-gated.
- **Not a consensus system.** We do not attempt global agreement on history order (see the equivocation
  limit in §4).

**One-line framing:** *AT-Proto-**inspired**, off-grid-first — portable self-certifying identity + signed
per-author logs synced over the existing transport, with local (QR/paste) key exchange instead of DNS.*

---

## 2. What already exists (reused, not rebuilt)

Grounded in the shipped mesh work (`docs/16`, Phases 0–2 + v2 **built & tested**):

| Primitive | Reused for | Where |
|---|---|---|
| Ed25519 sign/verify, X25519 sealed-sender, `@noble/*` pure-JS (works in the insecure-context PWA + embedded Node-18) | record signing; DM sealing stays as-is | `packages/crypto` (`@loam/crypto`) |
| **Self-certifying `mesh.` id = hash(Ed25519 pubkey)** | the seed for a portable account id | `mesh_identities` DAL |
| **Identity cards** (pubkeys + `kxSig` binding, re-verified `meshId===hash(sign)`), exchanged by QR/paste | local, DNS-free identity/key exchange | `GET /api/mesh/identity`, `POST /api/mesh/contacts` |
| Digest → diff → fetch **sync engine** + `syncPeerAuthorized` + `wipeGeneration` guard | the transport for signed repo diffs | `/api/sync/*`, `docs/11` |
| **Tombstones** (unconditional, horizon-GC'd) | non-resurrection of deleted records | `tombstones` table |
| Transport encryption (X25519 + XChaCha20, QR `#k=`) | confidential/authenticated peer links | `docs/08`, `sync-transport.ts` |

**~30–40% of the stack — and the hard cryptographic part — exists.** The gaps are (a) promoting the mesh
id to a *first-class account*, and (b) the *signed record log* (content addressing + per-author chaining +
verify-on-ingest).

---

## 3. The decisive constraint: off-grid, so no online resolution

AT Proto resolves `handle → DID → PDS` over DNS+HTTPS. LOAM cannot. **Decision (firm): borrow the data
model, drop the resolution model.**
- **Keep:** self-certifying identity, signed content-addressed records, verify-without-trusting-the-relay,
  sync over the existing transport.
- **Drop for the off-grid default:** DNS handles, PDS discovery, global relays, a canonical firehose.
  Discovery is **local** — QR / paste / mesh contact cards (already built).
- **Online mode only (optional, later):** real handles/relays + the `atproto` OAuth login (`docs/05`) make
  sense *only* for an internet-hosted website deployment — never the off-grid host.

---

## 4. Threat model (the part to attack)

**Trust base.** A node is already trusted by *its own local users* (it serves their client, holds their
plaintext, can wipe them). The new guarantees are therefore **against OTHER nodes and the relay path**, not
against a user's own host. State this explicitly so the scope is honest.

**Adversaries & goals the design must meet:**

| # | Adversary | Must guarantee |
|---|-----------|----------------|
| A1 | A **relay/carrier node** that forwards repo data | Cannot forge, alter, or attribute records to an author (**authorship integrity**). Public repo content is *readable* by design (it's public); DMs stay sealed-sender (mesh, unchanged). |
| A2 | A **malicious peer** supplying repo diffs | Cannot inject a record authored by someone else (**impersonation**), replay old/deleted records (**replay / resurrection**), or substitute keys (**key-substitution**). |
| A3 | A **compromised/dishonest author** (or theft of their key) | Cannot silently rewrite already-published history (**tamper-evidence**); a *fork* (two histories) is at least **detectable** (§4.1). |
| A4 | **Network eavesdropper / MITM** between nodes | Confidentiality + integrity of the link (transport encryption). **Known residual:** inter-node key discovery is TOFU unless the peer key is pinned (`docs/11`, `docs/15` #1/#6a) — call this out; it bounds A4 to passive unless pinned. |
| A5 | **Metadata adversary** | Public repos reveal an authorship graph *by design*. DMs remain unlinkable via the mesh sealed-sender `toTag` scheme (unchanged). No new metadata guarantee is claimed for public content. |

**Security properties, precisely:**
1. **Authorship integrity** — a record verifies iff `sig` is valid under `pubkey` AND `authorId == hash(pubkey)` (self-certifying: the id *is* the key commitment, so there is no key-to-id lookup to attack).
2. **Content integrity + addressing** — a record's `cid` is the hash of its canonical bytes; any mutation changes the cid.
3. **Non-resurrection** — a deleted record's cid is tombstoned; verify-on-ingest refuses tombstoned cids (existing guarantee, extended to signed records).
4. **Tamper-evidence & ordering** — each record commits to the author's previous record's cid (`prev`) + a monotonic `seq`, forming a **per-author hash chain**; truncation/reorder/insertion breaks the chain.
5. **Replay resistance** — `(authorId, seq, cid)` is idempotent; a re-sent record is a no-op, a *different* record at an existing `seq` is a fork (§4.1).

### 4.1 The hard limit: equivocation / forking

A dishonest author (or a node holding their key) can sign **two** valid records with the same `prev` — two
divergent histories shown to different peers. **Full non-equivocation is impossible off-grid without a
consensus or witness layer** (this is the same reason AT Proto ultimately trusts the PDS + external
verifiers). What we *can* do, and what this plan commits to:
- **Detection, not prevention:** any node that sees two validly-signed records with the same `(authorId,
  prev)` but different `cid` holds **cryptographic proof of equivocation** (both signed by the author). It
  can flag the author, refuse the fork, and gossip the proof.
- **Convergence policy:** **first-seen-wins per author head**, with the fork proof retained. A later
  conflicting branch is rejected (not merged), so honest nodes converge; the equivocation is surfaced to
  moderators rather than silently resolved.
- This limitation must be documented in `SECURITY.md` — it is the honest boundary of an off-grid design.

**→ Open question O1 for the reviewer:** is detection-plus-first-seen acceptable, or do we want an optional
lightweight witness (e.g. co-signing peers stamp heads they've seen) for higher-trust deployments?

---

## 5. Design

### 5.1 Portable identity (Phase 1)
- An **account keypair** (Ed25519). The account id is the existing self-certifying form: `mesh.`-style
  `id = multibase(hash(pubkey))`. Opt-in; coexists with anonymous `user.<hex>` (see §6).
- The **identity document** is the existing mesh identity card (signing + KX pubkeys, `kxSig` binding),
  exchanged locally (QR/paste), re-verified server-side. No DNS.
- **The identity-vs-signing-key fork — Open question O2 (biggest one):**
  - **Option A — id = hash(signing key).** Dead simple, maximally self-certifying, matches mesh today.
    **But the signing key cannot rotate** (rotating it changes the id → a new identity). Lost/compromised
    key = lost identity.
  - **Option B — id = hash(a stable *identity* key) that signs *delegations* to rotatable signing keys**
    (closer to AT Proto's DID-with-rotation-keys, minus the online PLC directory). Enables rotation,
    recovery, and per-device signing keys — at the cost of a delegation-verification layer and a way to
    distribute rotation events off-grid (a signed key-change record in the log + re-published identity
    card). This is where most of the cryptographic subtlety (and Sol's attention) lives: revocation
    freshness without a directory, recovery-key custody, downgrade/rollback of rotation events.

  Recommendation to debate: **B**, because "portable" without rotation/recovery is a weak promise — but B's
  off-grid revocation story (O2b: how does a peer learn a key was revoked, and can an attacker suppress
  that?) is the single hardest sub-problem and should be nailed with the reviewer before building.

### 5.2 Signed, content-addressed records (Phase 2)
Each post becomes a **signed record**:
```
record = { authorId, seq, prev, payload, /* payload = the existing Message shape */ }
cid     = multihash(canonical(record))          // content address
signed  = { ...record, sig = Ed25519(authorKey, cid) }
```
- **Canonicalization — Open question O3:** adopt **DAG-CBOR + multiformats CIDs** (AT-Proto-compatible, so a
  future MST/bridge is feasible and canonicalization is a solved, spec'd problem) vs a simpler canonical
  JSON (less code, LOAM-only). Leaning DAG-CBOR/multiformats: the interop option is cheap to keep open and
  the canonicalization pitfalls are already solved.
- **Repo format decision (O4):** **start with a per-author signed append-only log** (the hash chain in
  §4.4), **not** a full Merkle Search Tree. Rationale: the log gives authorship integrity, ordering,
  tamper-evidence, and fork-detection with far less machinery, and maps cleanly onto the existing
  message-diff sync. An MST (range proofs, efficient set reconciliation, AT-Proto-faithful) is a **later**
  upgrade once the log is proven. Keep CIDs/DAG-CBOR so that upgrade doesn't require a data migration.

### 5.3 Verify-on-ingest (mandatory, before persist or diff)
A record is accepted **only if**, in order: (1) `authorId == hash(pubkey)`; (2) `sig` verifies over `cid`
under `pubkey`; (3) `cid == multihash(canonical(record))`; (4) `prev` links to a known head for `authorId`
(or is genesis) and `seq` is exactly `prevSeq + 1`; (5) `cid` is not tombstoned; (6) no equivocation
(§4.1). Any failure ⇒ **reject without storing**, and never include an unverified record in a diff.
Read-time re-verification stays as defense-in-depth.

### 5.4 Repo sync (Phase 3)
Extend the digest/diff/fetch engine (`docs/11`) to gossip **signed per-author repo heads + record ranges**
instead of trusting node-attributed messages. The peer offers `{authorId → head cid, seq}`; the puller
requests the missing suffix; each record is verified per §5.3. **Public-only** — the signed diffs carry no
DMs, private-channel data, or shadow-banned content; the existing audience/moderation filtering (`docs/11`)
is unchanged. Reuses `syncPeerAuthorized`, the `wipeGeneration` bail, and tombstones.

### 5.5 Coexistence, moderation, durability
- **Coexistence (O5):** a node hosts both key-based accounts and anonymous `user.<hex>`. Every authz /
  audience-filter path must treat both — and there must be no privilege leak from presenting a portable id
  (a portable identity is *not* automatically an admin/mod on a node it visits).
- **Moderation:** once authorship is user-signed and portable, a node can refuse to **serve** a record but
  cannot **rewrite** it. Ban/shadow-ban become *local serving policy* + tombstones + the equivocation
  proofs — reconcile with the existing roles model (`docs/07`).
- **Kill-switch / ephemerality tension (O6):** durable signed history conflicts directly with the
  panic-wipe (`docs/02`) and ephemeral-retention postures. Decide per security-profile: repos are
  wipeable-and-local by default; "durable portable" is an explicit opt-in that a hardened profile can
  forbid.

---

## 6. Phasing (each independently shippable, flag-gated, anonymous default untouched)

- **Phase 0 — spike & format lock.** In `packages/crypto` (+ a new `packages/repo`?): the record type, the
  canonicalization/CID choice (O3), the per-author log + verify function, with tests. Wired into nothing.
  *(Mirrors mesh Phase 0.)* **This is the first PR.**
- **Phase 1 — portable identity (opt-in).** Promote the mesh id to a key-based account; resolve O2
  (identity-vs-signing key, rotation/recovery) first. Deepest authz surface (§5.5) — most careful.
- **Phase 2 — signed record log.** Records signed + content-addressed + verify-on-ingest; stored alongside
  the existing message rows. The big, security-critical phase.
- **Phase 3 — repo sync.** Signed per-author diffs over the existing engine (§5.4).
- **Phase 4 (optional, online-only).** Real handles/relays + `atproto` OAuth for website instances. Not the
  off-grid host.

Rough size: **an epic on the scale of the mesh work — 6–10+ security-first sessions.**

---

## 7. Open questions for the reviewer (ranked)

- **O2 — identity vs signing key & off-grid key rotation/recovery/revocation.** The crux. Option A (no
  rotation) vs B (delegation + rotation). If B: how does a peer learn of a revocation without a directory,
  and can an attacker suppress or roll it back? Recovery-key custody on the PWA (no `crypto.subtle`) + the
  Android host (SQLCipher + device secret)?
- **O1 — equivocation:** is detection + first-seen-wins + gossiped fork-proofs enough, or add an optional
  witness/co-sign layer for higher-trust deployments?
- **O3 — canonicalization/CID:** DAG-CBOR + multiformats (interop-ready) vs canonical JSON (simpler)?
- **O4 — repo format:** confirm "per-author signed log first, MST later," or start MST?
- **O6 — durability vs wipe/ephemerality:** the right default and per-profile policy.
- **O7 — replay/freshness across long partitions:** `seq`+`prev` handle order, but how stale a head may a
  node serve, and does that interact badly with tombstone horizon-GC (`docs/15` #7)?
- **O8 — interop worth:** how much AT-Proto-faithfulness (CIDs/DAG-CBOR/MST/CAR) is worth carrying for a
  future bridge vs a leaner LOAM-native format?

---

## 8. Concrete first deliverable (Phase 0 PR)

A new `packages/repo` (or an extension of `packages/crypto`) providing: the `SignedRecord` type; the
canonicalization + CID function (O3 decision baked in); `signRecord(key, record)` and
`verifyRecord(record)` implementing §5.3 checks (1)–(4); a per-author `RepoLog` with append + head +
fork-detection; and a thorough test suite (valid chain, bad sig, wrong author, broken `prev`, out-of-order
`seq`, duplicate/idempotent, equivocation-detected). **Wired into nothing** — no server/client/schema
changes, so it lands with zero product risk, exactly like the mesh Phase 0. Everything after depends on the
O2/O3 answers, so the reviewer's feedback gates Phase 1+.

---

## 9. Explicitly out of scope for this plan
Real AT Protocol network interop (federation with Bluesky et al.), DNS handle resolution, the `did:plc`
directory, global relays/firehose, and lexicon-style open extensible schemas. All are online-first and
belong to a possible Phase 4 website mode, not the off-grid host.
