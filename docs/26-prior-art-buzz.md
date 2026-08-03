# 26 — Prior art: Buzz (Block's Nostr workspace for humans + agents)

**Status: investigation / briefing — not committed, not sequenced.** Recorded findings from a review of
[block/buzz](https://github.com/block/buzz) (cloned and read August 2026: `ARCHITECTURE.md`, `NOSTR.md`,
`VISION*.md`). Companion to the AT Proto investigation (`docs/22`, plan of record `docs/23`). Where an
idea below maps to an existing backlog row it cites `docs/25`; the genuinely new candidates are called
out as such.

## What Buzz is

Buzz is Block's (Square's) self-hosted, Apache-2.0 "workspace where humans and agents build together":
a Slack-shaped app — channels (public/private), threads, DMs, reactions, presence, typing indicators,
full-text search, media, voice huddles — plus git hosting, YAML workflow automation, and a large
agent surface. Stack: Rust relay (Axum), Postgres event store, Redis fan-out, S3/MinIO media (Blossom
protocol), Tauri desktop, Flutter mobile.

Two load-bearing design decisions:

1. **It is a Nostr relay.** Every action — message, reaction, membership change, workflow step — is a
   NIP-01 signed event: `id = sha256(canonical bytes)`, secp256k1 pubkey, Schnorr signature, integer
   `kind` as the only dispatch switch. Buzz speaks NIP-29 (relay-based groups) natively; stock Nostr
   clients (`nak`, Chachi, 0xchat) can connect. Humans and agents get identical identity: a keypair +
   NIP-05 handle.
2. **Agents are peers, not bots.** An agent is an ordinary user with its own keypair, connecting over
   the same WebSocket protocol as humans. `buzz-acp` bridges channel @mentions to any agent speaking
   ACP (Claude Code, Goose, Codex); `buzz-cli` is a JSON-in/JSON-out CLI built for LLM tool calls; an
   MCP server exposes the whole platform surface. "Personas" bundle a model + system prompt; "teams"
   name groups of personas.

## How it relates to LOAM

Structurally it is the *same shape* as a LOAM node in the one way that matters: **one trusted
self-hosted server serving a bounded trust group, where membership is the only gate**. The chat data
model is nearly 1:1 with LOAM's (channel visibility, threads, DMs, reactions, presence, search,
attachments, join-by-invite).

Everything else is opposite:

| Axis | Buzz | LOAM |
|---|---|---|
| Audience | Funded teams on the internet | Strangers on a LAN, off-grid |
| Topology | Single relay, **explicitly no gossip/replication** | Node-to-node sync (`docs/11`) + sealed mesh (`docs/16`) |
| Stack weight | Rust + Postgres + Redis + S3 | One Node process + SQLite on a phone |
| Identity | Permanent portable keypairs | Anonymous, ephemeral, node-local (portable identity opt-in only — `docs/23`) |
| Encryption stance | TLS + server-readable everything, *deliberately* ("eDiscovery works on everything"); E2E a maybe-later | Transport encryption by default, E2EE on the roadmap (`docs/25` S2), ephemerality as a feature |
| Audit | Hash-chain tamper-evident permanent log | Retention reaper, kill switch, tombstone GC |

Note "Buzz Mesh" is about pooling *GPUs*, not messages — LOAM's store-and-forward mesh has no
counterpart in Buzz at all.

## Ideas worth stealing

### 1. Nostr's event model corroborates the signed-sync direction (→ `docs/23`)

Nostr is the *lighter* cousin of the AT Proto answer to `docs/11`'s forgery and delete-propagation
gaps: individually signed, **self-contained** events with a hash-derived globally-unique id, idempotent
relay import — i.e. a LOAM sync message plus a signature, with no Merkle-repo machinery. Deletes are
signed `kind:5` events verified author-match against the target: exactly the shape a propagating,
verifiable tombstone needs.

Two honest caveats, so this stays corroboration rather than a rival design:

- **Nostr buys its simplicity by giving up completeness/ordering.** Independent events carry no chain,
  so a relay can silently drop any subset undetectably — the same equivocation/suppression caveat Sol
  flagged for `docs/23` (which is *why* that plan uses per-device operation logs, not bare events).
  Nostr validates the "self-contained signed event + signed delete" building blocks; it does not
  replace the `docs/23` log design.
- **Wire compatibility is not worth it.** Nostr is secp256k1/Schnorr; LOAM's shipped crypto is Ed25519
  (`@loam/crypto`), and NIP-29 interop would buy access to third-party clients LOAM's PWA-first,
  off-grid model doesn't need.

### 2. Agent-as-ordinary-user (→ `docs/25` P4 + P6, `docs/06`)

LOAM's LLM is a special-cased DM bot with its own `StreamEvent` path. Buzz's alternative: the
assistant is a normal roster member that gets @mentioned in channels and posts through the same
message-create path as everyone else, with its own identity and gated permissions. For the planned
channel-assistant/triage roles this is the cleaner architecture — mention-triggered participation
falls out of the existing `createMessage()` + broadcast machinery instead of growing more bot special
cases. This directly informs backlog items **P4** (channel participation / @mention) and **P6**
(multiple bots/personas — Buzz's "persona = named model + system prompt bundle, operator-defined" is
the right shape for the config).

### 3. The moderation report loop (**new** — no backlog row yet)

Buzz's report workflow (`VISION_MODERATION.md`) is designed for exactly LOAM's context — a
self-governing trust group — and is the most transplantable piece of the whole review:

- **Private member reports**: category + optional note; never stored in the event log, never fanned
  out — so reporter identity can't leak through a future query bug. Matches LOAM's privacy instincts.
- **Reports are signals, never triggers**: no auto-removal; an admin queue grouped by target, acted on
  in one motion (dismiss / delete / timeout / ban / escalate).
- **Honest tombstones**: a removed message leaves "removed by a moderator" + sanitized reason, not a
  silent hole.
- **Timeouts with a visible countdown**: composer disabled, user told what/why/how long.
- **Closing the loop**: best-effort notices to the reported author and the reporter (never blocking
  enforcement).

LOAM has ban/shadow-ban (`/api/moderation/users`) and join approval, but **no member-report path at
all**. The report queue and the timeout primitive would slot into the existing moderation panel.
One deliberate divergence to keep: Buzz rejects shadow bans on principle ("no silent write-drops");
LOAM's shadow-ban serves a hostile-environment threat model Buzz doesn't have — keep it, alongside
the honest tools.

### 4. "Your community is your compute" (→ `docs/06`, touches `docs/25` P5)

Buzz Mesh: members opt in to share idle GPUs; the relay gates discovery by the membership it already
has; agents just see a local OpenAI-compatible endpoint. LOAM's cheap version is nearly free —
`llm.ollama` already points at an arbitrary URL, so "a member with a beefy laptop volunteers their
Ollama to the node" is a consent-UI + docs problem, not an engineering one. Worth recording in
`docs/06` as a deployment pattern (the consent screen honesty matters: prompts go to that member's
machine). Skip the model-splitting-across-machines part.

## What not to copy

- **Hash-chain audit log + server-readable-everything**: enterprise/eDiscovery features that are
  anti-goals for LOAM's ephemeral, privacy-first posture.
- **Postgres/Redis/S3**: wrong weight class for a phone-hosted node.
- **Git hosting, canvases, YAML workflows, huddles**: problems LOAM doesn't have.
- **Permanent portable keypairs as the default identity**: same anonymity trade-off `docs/22` flags;
  LOAM's answer is opt-in portability (`docs/23`), ephemeral by default.

## Nugget for later

Buzz's multi-tenant isolation is *formally specified* — TLA+ for tenant isolation, Tamarin for
authorization, with every guarantee mutation-tested (`docs/multi-tenant-relay.md` in their repo). An
interesting benchmark if LOAM's private-channel enforcement ever wants stronger assurance than the
current test matrix.
