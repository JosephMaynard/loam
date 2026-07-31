# 22 — AT-Proto-inspired portable identity & user-owned repos (investigation)

**Status: investigation / briefing pack — not committed, not sequenced.** This captures the current
state (grounded in real files), the goal, the one decision that shapes everything, a phased plan, and
the open questions — the same shape as the other roadmap briefings (see `05`, `08`, `16`). Read
`CLAUDE.md` and `16-opportunistic-mesh.md` first; this builds directly on the mesh identity work.

## The idea

Borrow the [AT Protocol](https://atproto.com)'s good ideas — **portable cryptographic identity** and
**user-owned, signed, content-addressed data repositories** that sync between servers — so a LOAM user
is no longer trapped as an anonymous, node-local, session-cookie account. A person could carry one
identity (and their posts) across nodes, and any node could cryptographically verify authorship without
trusting the node that relayed it.

The pitch is *decentralization of the account*, not of the transport (LOAM already gossips between
nodes — `docs/11`). Today, identity and data are **node-owned**; the AT Proto insight is to make them
**user-owned**.

## Current state (what already exists — grounded in real files)

LOAM is unusually well-positioned because the opportunistic-mesh work (`docs/16`, Phases 0–2 + v2
**built & tested**) already shipped most of the cryptographic foundation. Mapped onto AT Proto's pillars:

| AT Proto pillar | LOAM today | Where |
|---|---|---|
| **DID** — portable self-certifying id | ✅ `mesh.` id = **hash of an Ed25519 pubkey** — a self-certifying key fingerprint (`did:key`-like in spirit; it *hashes* the key rather than multibase-encoding it, so not literally `did:key`) | `packages/crypto` (`@loam/crypto`), `mesh_identities` DAL |
| **Identity document / key exchange** | ✅ **mesh identity cards** (pubkeys + secret mailbox token), exchanged by QR/paste, re-verified server-side (`meshId===hash(sign)` + `kxSig` binding) | `GET /api/mesh/identity`, `POST /api/mesh/contacts`, `mesh_contacts` DAL |
| **Crypto primitives** | ✅ Ed25519 signing, X25519 sealed-sender (XChaCha20-Poly1305), `@noble/*` pure-JS (works in the insecure-context PWA + embedded Node-18) | `packages/crypto` |
| **Relay / firehose / federation** | 🟡 pull-based **node-to-node sync**: digest → diff → fetch, tombstones, optional shared `sync.token` — but it gossips **node-owned public data**, trusting the peer node | `GET /api/sync/digest`, `POST /api/sync/messages`, `docs/11` |
| **Lexicons** — open, namespaced schemas | 🟡 `@loam/schema` (Zod) — a real client↔server contract, but **fixed and closed**, not extensible | `packages/schema` |
| **PDS / signed user repo** | ❌ **nothing** — messages are stored per-node in SQLite, keyed by a node-local `user.<8hex>` minted from the session cookie | `getSessionUserId`, `LoamStore` |
| **Portable account** | ❌ identity is anonymous, ephemeral, and **node-scoped** — it does not survive moving to another node | `getSessionUserId` |

**Read: ~30–40% of the conceptual stack exists, and it's the hard cryptographic part.** The gaps are the
*repo* (signed, content-addressed, user-owned data) and *promoting the mesh DID to a real account*.

## The one decision that shapes everything: online vs off-grid

AT Proto is **fundamentally online**. Handle→DID→PDS resolution needs DNS + HTTPS + reachable servers.
That directly contradicts LOAM's #1 priority (off-grid, no internet, no accounts, no cloud) — `docs/05`
already flags exactly this tension for the *auth* idea.

So a faithful port is the wrong goal. The recommendation is **borrow the concepts, drop the online
resolution**:

- **Keep**: portable self-certifying identity, signed content-addressed user repos, verify-authorship-
  without-trusting-the-relay, repo sync over the existing transport.
- **Drop (for the off-grid default)**: DNS handle resolution, HTTPS PDS discovery, global relays, a
  canonical firehose. Discovery stays **local** — QR / paste / mesh contact cards, which LOAM already does.
- **Defer to online mode only**: real AT Proto federation (relays, handle resolution, and the
  `atproto` OAuth login in `docs/05`) makes sense *only* for the optional internet-hosted website
  deployment, never the off-grid host.

Net: this is **"AT-Proto-inspired," not "AT Proto compatible."** Full wire/DID-method compatibility with
the real network is a separate, much larger, online-only question — explicitly out of scope for v1.

## Difficulty & why it can't ride a feature branch

This is the **largest remaining initiative on the roadmap** — comparable to the entire mesh/DTN epic
(multi-session, phased, security-first — the doc-16 guardrail that *rushing crypto/transport is how
Bridgefy/FireChat failed* applies here too). It touches the deepest layer (identity → every authz/audience
path), storage (a new per-user signed repo + content addressing), and sync (verify per-*user*, not
per-*node*). It needs its own epic branch and its own plan-of-record doc; it must never fold into an
unrelated branch.

## Phased plan (rough — for sequencing, not commitment)

Each phase is independently shippable and gated behind a flag; the anonymous node-local default is never
disturbed.

- **Phase 0 — spike & format decision.** Pick the repo format (signed append-only log first, MST later —
  see open questions), CID/hashing scheme, and how a signed record maps onto the existing `Message`
  union. Wire nothing. *(Mirrors mesh Phase 0 = `packages/crypto` with tests, wired into nothing.)*
- **Phase 1 — portable identity (opt-in).** Promote the mesh DID (`packages/crypto`) into an optional
  **key-based account**: a user can generate/import a keypair and be recognised across nodes by their
  `mesh.`-style id, alongside (never replacing) the anonymous default. Deepest authz surface; most careful.
  Calling an account *portable* has hard prerequisites that must be designed up front, not bolted on:
  **key rotation**, **lost-key recovery**, and **repo delegation** — i.e. how the identity and its signed
  repo (Phase 2) stay accessible when the key changes or is unavailable. Treat these as Phase 1 gating work.
- **Phase 2 — signed user repo.** Each post becomes a **signed record** in a per-user, content-addressed
  repo (start: a signed append-only commit log; not a full Merkle Search Tree). **Verify on ingest, before
  a record is persisted or included in any diff** — check the signature, recompute + record the CID,
  confirm the record's repo identity, and validate parent/commit ancestry; reject invalid records without
  storing them. Keep the read-time verification too, as defense in depth. This is the big, security-critical
  phase.
- **Phase 3 — repo sync.** Extend the `docs/11` sync engine to gossip **signed user-repo diffs** and
  verify authorship cryptographically (drop the trust-the-peer-node assumption for repo data). ~High reuse
  of the existing digest/diff/fetch machinery, as the mesh relay reused it. Sync stays **public-data-only**:
  the signed diffs carry no DMs, private-channel data, or shadow-banned content, preserving the existing
  audience + moderation filtering that `docs/11` already enforces — user-signed repos change *who vouches*
  for a record, not *what leaves the node*.
- **Phase 4 (optional, online only) — real federation.** Handle resolution + relays + `atproto` OAuth
  (`docs/05`) for internet-hosted website instances. Not for the off-grid host.

Rough size: **6–10+ focused sessions**, security-first, like the mesh epic.

## Open questions (to resolve in the plan-of-record, before code)

1. **Repo format now:** signed append-only log (simple, converges with the existing sync diff) vs a real
   MST/CID DAG (AT-Proto-faithful, portable, much more work). Recommendation: **log first, MST later.**
2. **Coexistence with anonymous mode.** How do a key-based account and an ephemeral `user.<hex>` share a
   node — dual identity types, migration path, and what the audience/authz filters do with each. This is
   where most of the risk lives (see the mesh authz surface).
3. **Key custody on the PWA + Android host.** Where the private key lives (the insecure-context PWA has no
   `crypto.subtle`; the Android host has SQLCipher + a device secret — `docs/01`). Reuse the mesh key
   handling.
4. **Kill switch & ephemerality vs durable signed history.** A user-owned durable repo is in direct tension
   with LOAM's ephemeral/panic-wipe posture (`docs/02`). Decide whether repos are wipeable, per-node-only,
   or opt-in durable.
5. **Moderation of signed content.** Shadow-ban / ban currently work because content is node-owned. Once
   authorship is user-signed and portable, a node can refuse to *serve* but can't rewrite — reconcile with
   the existing moderation model (`docs/07`, roles/greeter/shadow-ban).
6. **How much AT Proto compatibility is worth it** vs a LOAM-native design that merely rhymes with it.
   Full compatibility is online-only and large; "inspired-by" keeps us off-grid and reuses the mesh stack.

## Bottom line

Feasible and genuinely well-seeded by the mesh work, but it is the **biggest remaining epic**, gated on
the online-vs-off-grid decision above, and it belongs on its own track. This doc is the cheap, reversible
first step; the next step (only if the owner wants to pursue it) is a plan-of-record like `docs/16`.
