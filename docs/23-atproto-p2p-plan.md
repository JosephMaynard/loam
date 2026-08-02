# 23 — Portable identity & user-owned signed repos: plan of record (revised after Sol round 1)

**Status: design revised, still pre-implementation.** External crypto review (Sol, round 1) gave a
**"green light on the initiative, red light on freezing the round-1 record format"** — four architectural
blockers, not implementation nits. This revision incorporates them. **The next step is NOT the Phase 0
code PR; it is locking the four decisions in §9, then a revised Phase 0.** Round-1 brief + full response:
`sol-review/REVIEW-BRIEF-future-plans.md`.

## What round 1 changed (summary)
- **The round-1 record format is withdrawn.** A single append-only chain *per author* cannot coexist with
  offline multi-device use + deletion + ephemerality. Replaced with **per-device operation logs + a small
  identity-control log** (§4–§5).
- **"First-seen-wins" is dropped** — it does not converge (partitions stay permanently divergent). Replaced
  with **fork-freeze-at-common-ancestor** (§6).
- **Two honesty corrections:** tombstones are **not** permanent (they are 30-day horizon-GC'd — `docs/15`
  #7), and non-resurrection holds only within that window; "equivocation is detectable" must be qualified as
  *"detectable **if** the conflicting histories ever meet"* (a malicious relay can suppress a branch forever).
- **The existing `mesh.` id is unsuitable** as the permanent public-account namespace (§2).
- Secondary items re-answered: the mesh ack is a **hash-lock receipt** not a MAC; **`@noble` 2.x is blocked
  by Node 18**; E2EE is Double-Ratchet-not-MLS-lite with a malicious-host caveat; inter-node auth is specced
  (§11).

---

## 1. Goal & non-goals
**Goal.** An **optional, portable, cryptographic identity** and a **signed, content-addressed record log**
(a user's *published* posts), verifiable by any node **without trusting the relay**. Opt-in; coexists with
the anonymous, ephemeral, node-local default.
**Non-goals (v1):** not wire-compatible with the real AT Protocol network (no DNS/PDS/relays/firehose — all
online); not a consensus system; not a replacement for anonymous mode.

## 2. Foundations — reused, and what must change
**Reused:** `@loam/crypto` (Ed25519 / X25519 sealed-sender / XChaCha20-Poly1305, pure-JS), the transport
handshake, and the digest→diff→fetch sync engine + tombstones.
**Must change (blocker 4):**
- The current `mesh.` id is `base32(sha256(signPubkey)[0..15])` — 16 bytes ⇒ ~**64-bit collision
  resistance**, and the key is **host-generated/host-custodied**. Fine for the mesh's trusted-host model;
  **not** acceptable as the permanent namespace for long-lived public accounts. The account id uses a
  **full 32-byte SHA-256** (§4), and portable identity needs an **encrypted export/recovery** UX — "host-
  custodied" ≠ "user-owned".
- **Separate keys for public-repo signing vs private mesh messaging.** Reusing one identity across both lets
  a recipient link sealed conversations to the public persona, and makes a single compromise span every
  protocol.

## 3. The off-grid decision (unchanged, firm)
Borrow the data model; **drop online resolution** (no DNS handles, no PDS discovery, no global
relays/firehose). Discovery stays **local** (QR/paste). This is *inspired-by*, not AT-compatible.

## 4. Identity model (O2 → **Option B, revised** — with an honest Option A fallback)
A stable account id derived from a **canonical genesis identity document**, not from a single irreplaceable
signing key:
```text
accountId = SHA-256(canonical({ version, recoveryPolicy, initialRecoveryKeys }))   // full 32 bytes
```
- The genesis doc **precommits multiple recovery/controller keys** (e.g. a 2-of-3 policy for users who opt
  into recovery); recovery keys stay offline / on separately-protected devices. Normal devices get scoped
  Ed25519 **signing delegations**.
- A separate **identity-control log** records: device-key delegation, revocation, recovery-policy change,
  controller rotation, an **identity epoch**, and — critically — **the last accepted head of any revoked
  device log** (so a stolen key cannot manufacture "older" records and claim they predate compromise).
- **Off-grid revocation freshness — the honest limit.** It can only give: rollback protection *relative to
  the newest epoch a peer has already seen*; fresher state via QR/paste + gossip; and **no** freshness
  guarantee for a first-time peer, or one whose adversary suppresses the revocation. Peers cache their
  highest accepted control epoch/head and **never accept older**. Identity cards carry the genesis doc + the
  latest control proof; every record names the exact device key + control epoch that authorised it.
  *There is no cryptographic way to guarantee an isolated newcomer has the latest revocation without an
  online authority, a witness quorum, or a trusted physical exchange — stated explicitly.*
- **Fallback (decision to lock):** if this hierarchy is too much UX/impl for v1, choose **Option A honestly**
  — "a portable pseudonym with encrypted backup; losing or compromising it creates a new identity." A
  *partial* Option B is more dangerous than a candid Option A.

## 5. Repo model — **per-device operation logs** (blockers 1 + 3)
Not one chain per author. Each authorised **device** keeps its own append-only **operation log**, aggregated
into the account repo. Concurrent posts from two authorised devices are **both valid** — multi-device works.
The operation-log entry (Sol's shape):
```text
entry = { version, accountId, deviceKeyId, identityEpoch,
          deviceSeq, devicePrev,
          operation,   // create | update | retract
          recordId,
          valueCid }   // separate content block; null for retract
```
- **Content is addressed separately (`valueCid`)** so chain metadata can survive while a content block is
  locally pruned. An update or **author retraction is a new signed operation**, never an in-place edit.
- **Three distinct deletion concepts, kept separate:** *author retraction* (a signed, portable operation);
  *local moderation hide* (node-local policy, never attributed to the author); *retention expiry / panic
  wipe* (local destruction, **not** a globally enforceable delete). **Once public data has reached another
  node, neither a tombstone nor the kill switch can erase that copy** — this must be prominent in the UI and
  `SECURITY.md`.

**Verify-on-ingest** (before persist or diff): valid delegation for `deviceKeyId` under the account's
control log at the claimed `identityEpoch`; signature over the domain-separated bytes (§7); recomputed CID
matches; `devicePrev`/`deviceSeq` link to a known device head; not tombstoned; no device-fork (§6). Reject
without storing; read-time re-verify as defense-in-depth.

## 6. Fork handling (O1 revised — blocker 2)
Equivocation now means **the same device key signed two successors to the same device head**. On detection:
- retain both signed successors as a **bounded fork proof**;
- **freeze that device log at the common ancestor**;
- stop presenting **both** post-fork branches;
- require a recovery/control event or an explicit moderator/user decision before proceeding.

This converges on *"this device is forked"* without pretending a network race picked the authentic history.
**No CID tie-breaker** (it lets a stolen-key attacker grind the winning branch and silently discards the
evidence). **No witnesses in v1** (optional M-of-N signed checkpoints could later help managed deployments,
but add a trusted roster, hurt partition availability, and don't solve first-contact freshness). Honesty:
forks are **detectable *if* the conflicting histories ever meet** — a malicious relay can suppress a branch.

## 7. Serialization — fixed CID suite + domain-separated signatures
- **DAG-CBOR** with a **fixed, non-negotiable suite:** CIDv1, `dag-cbor`, SHA-256, **full 32-byte** hashes,
  exact schema version, exact key/signature lengths, bounded object depth + encoded size. **Reject
  attacker-selected multihash algorithms.** Decoders accept some non-canonical input, so we **validate typed
  data and recompute the canonical bytes ourselves**.
- **Sign a domain-separated byte string:** `Ed25519("loam.repo.entry.v1\0" || cid.bytes)` — never a bare CID
  shared with other protocols.
- **Interop claim softened:** AT Protocol now uses signed **MST** commits + its normalised **DRISL** CBOR;
  choosing DAG-CBOR + CIDs does **not** make LOAM records AT-compatible or guarantee a migration-free MST
  conversion later. Expect a **new repo/commit format** if an MST is ever added (content blocks may be
  reusable).

## 8. Coexistence, moderation, durability — **publication is an explicit feature**
A signed public repo is an explicit **publication**, not merely another representation of ordinary chat —
so **not every public-channel message is auto-published.** Per profile:
- **open / standard:** anonymous local chat stays the default; portable identity + "publish portably" are
  explicit opt-ins.
- **hardened:** portable-repo gossip, durable backups, and persistent identity are **off by default**; panic
  wipe destroys local device keys; the UI still warns that already-replicated public material cannot be
  recalled.
- **archival / team:** portable publishing may be enabled broadly — but that is a **durability** profile,
  not a stronger-security one.

The kill switch removes host-custodied keys locally; it **cannot** wipe offline clients, exported recovery
bundles, or remote peers — a prominent boundary.

## 9. The four decisions to lock **before** Phase 0 (Sol's recommended next move)
1. **Per-device operation logs** vs an explicit single-writer (signed writer-lease) constraint. *(Recommend
   per-device.)*
2. **Identity/control/recovery model** — the revised Option B (§4) and its unavoidable freshness limit, **or**
   a candid Option A. *(The one genuine product/complexity call — owner input wanted.)*
3. **Operation records + separately-addressed content blocks** (§5). *(Recommend adopt.)*
4. **Portable publication as a distinct user action** from local chat (§8). *(Recommend yes.)*

## 10. Revised Phase 0 (after the decisions) + required test matrix
Wired into nothing (a `packages/repo` primitive): the **canonical codec** (fixed CID suite), **domain-
separated signatures**, **delegation verification**, **per-device append** logic, and the **fork-freezing**
policy. Tests must cover: concurrent valid devices; **revoked-device final-head anchoring**; stale control
state; fork-proof retention; strict vs non-canonical CBOR rejection; integer overflow; oversized inputs;
edit/retract operations; and **byte-identical known-answer vectors across Node 18, Node 24, browser, and
Android**.

## 11. Related crypto items — updated per Sol
- **Mesh delivery-ack → hash-lock receipt** (the proposed blinded MAC was unverifiable-by-a-carrier or
  forgeable). Sender picks random `ackSecret` (carried in the encrypted inner payload); the authenticated
  public envelope carries `ackCommit = SHA-256("loam.mesh.ack.v1" || msgId || ackSecret)`; the recipient
  publishes `{ msgId, ackSecret }`; a carrier verifies the preimage, deletes, and gossips the receipt. No
  recipient identity revealed; the sender can only prematurely delete *its own* message; replays are idempotent;
  no sender-set `at` (carriers stamp their own time); only store an ack when the node holds the message. TTL
  stays the backstop. *(Update `docs/16`'s ack section when built.)*
- **`@noble` 2.x — blocked by Node 18.** All three 2.x packages require Node **20.19+** and are ESM-only; the
  embedded Android host is Node 18, so the major is blocked regardless of transpilation. Stay on 1.x; do the
  small `@noble/curves` 1.9.4 → 1.9.7 independently; **record the Node-18 reason in dependency policy so
  automation stops reopening the bump**; migrate only after the embedded runtime moves (then: `.js` subpath
  imports, renamed keygen APIs, moved hash modules, strict `Uint8Array`, cross-runtime KATs, and an explicit
  RFC-8032 verification choice).
- **E2EE — not "MLS-lite."** DMs: signed device key packages + pairwise **Double Ratchet**. Small private
  channels: pairwise ciphertext fan-out over those sessions. Larger/dynamic groups: a **mature, audited MLS**
  only if one runs on LOAM's browser + Node-18 runtimes. **Deeper blocker:** a malicious host serves the PWA
  JavaScript and can serve code that steals client keys — E2EE protects against an honest-but-curious
  operator, **not a malicious host**, unless the user runs a separately-trusted signed client (the installed
  **APK**). The E2EE threat-model claim must be decided *before* protocol work.
- **Inter-node authentication** — prioritise before repo-sync Phase 3 (needn't block a serialization-only
  Phase 0). Not "per-peer signed authors" (too vague): a **stable self-certifying Ed25519 node identity** + a
  signed binding to its transport X25519 key + **mutual challenge/transcript auth** + an **operator-pinned**
  peer identity (QR / manual fingerprint) + **per-peer credentials** (not the shared ring-wide bearer token).
  TOFU over attacker-controlled HTTP does not defeat an active first-contact MITM (which can eclipse peers
  and suppress the very revocations/fork-proofs this design depends on).

## 12. The honest simultaneous-adversary result (Sol)
With a stolen author key **plus** a malicious peer/relay, an attacker can: forge all future records + build
alternative histories from any old head; suppress revocations/deletions/fork-proofs indefinitely; present a
stale-but-valid prefix to newcomers; (under the withdrawn first-seen-wins) keep partitions divergent or
misclassify honest multi-device activity as equivocation; resurrect data past the tombstone horizon; exploit
the shortened mesh id if reused; link public persona to private messaging if keys are reused. **Signatures
solve alteration and third-party attribution. They do not solve freshness, availability, compromise-time,
deletion, or agreement** — which is why the revisions above target exactly those gaps.

## 13. Open design flags to fold into the next review round
Raised by an automated review pass of this draft; all concern the **unbuilt** design (nothing here ships in
the current release). Carry them into the Sol round-2 review before any Phase-0 code:
- **Out-of-order / conflicting successors on ingest.** Verify-on-ingest must not silently drop a validly-signed
  entry just because its predecessor (or the current device head) isn't known yet: quarantine it pending its
  predecessor, and persist a validly-signed *conflicting* successor as **fork evidence** rather than discarding
  it. Otherwise a peer feeding entries out of order can hide a fork.
- **Equivocation resolution must converge.** "First-seen-wins per head" lets two replicas independently pick
  different branches while each believes it converged. Resolve only via a signed, canonical control event that
  names both fork branches, **or** keep the device log frozen at the common ancestor until recovery mints a new
  log — never per-replica local choice.
- **Identity-control-log fork handling.** Define the same fork rules for the control log itself: each control
  record names its predecessor; conflicting valid heads are a fork proof; the recovery authority resolves;
  deterministic accept/reject/supersede rules so peers converge on the same delegations/revocations.
- **update / retract need an explicit target record id** distinct from `devicePrev`, plus deterministic
  record-level merge rules for concurrent update-vs-retract.
- **CBOR policy is contradictory** (reject non-canonical vs accept-and-normalize) — pick one and align the
  Phase-0 test matrix.
- **Signature/CID definition** must name exactly which CID is signed and ensure the canonical CID **excludes**
  the signature (no signature↔CID cycle), so every implementation signs identical bytes.
