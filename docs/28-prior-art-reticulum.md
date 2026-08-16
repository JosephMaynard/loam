# 28 — Prior art: Reticulum (RNS) — the candidate transport under LOAM's LoRa future

**Status: investigation / briefing — not committed, not sequenced.** Recorded findings from an August
2026 review of the [Reticulum Network Stack](https://reticulum.network) (manual + v1.4.2 release),
[LXMF](https://github.com/markqvist/LXMF), the FOSDEM 2026 community-state talk, and a read of
[Crosstalk](https://github.com/buildwithparallel/crosstalk) (a field-focused MeshChat fork). Companion
to the AT Proto (`docs/22`/`docs/23`) and Buzz (`docs/26`) prior-art docs. **Headline: Reticulum is not
a competitor — it is a credible, already-built answer to the unbuilt LoRa transport epic (`docs/25`
M3), and it pressure-tests the priority of the phone-radio epics (M1/M2).**

## What Reticulum is

A cryptography-first networking stack — a replacement for the IP layer, not a chat app — by Mark
Qvist; Python reference implementation, ~10 years old, v1.4.2 (July 2026). Design properties, all
directly relevant to LOAM:

- **Self-certifying addressing.** A destination is a 16-byte truncated SHA-256 of a public key — no
  DHCP/DNS/coordination. (The same construction as LOAM's `mesh.` ids, arrived at independently —
  and the same 16-byte truncation `docs/23` §2 flags as too small for *permanent public* identity.)
- **Announce-based path discovery.** Destinations announce; transport nodes store only best-next-hop +
  hop count and rebroadcast with randomized delay and bandwidth prioritization. No node knows full
  paths; nothing is configured.
- **Extreme medium-agnosticism.** TCP, WiFi, serial, packet radio, and LoRa via the **RNode** firmware
  (runs on ~$20 Heltec-class ESP32 boards; custom MAC over raw LoRa, *not* LoRaWAN). Functions down to
  **5 bps** with a **500-byte MTU**. Link setup = 3 packets / 297 bytes; link keepalive = 0.45 bps.
- **Encrypted by default, forward secrecy on links.** X25519 ECDH + Ed25519 + AES-256-CBC/HMAC-SHA256,
  HKDF — the same primitive family as `@loam/crypto`. Packets carry **no source addresses**; link
  initiators are anonymous.
- **LXMF** (messaging layer on top): signed messages with **111 bytes total overhead** (msgpack
  payload), message-id = SHA-256(destination‖source‖payload), and three delivery modes — direct link,
  opportunistic single-packet, and **propagation nodes**: auto-peering store-and-forward mailboxes
  forming "an encrypted, distributed message store." Messages are small enough to encode as a QR code
  (paper transport is a documented pattern).

**Crosstalk** (the repo that prompted this review) is a polished fork of Reticulum MeshChat: a Python
daemon embedding RNS/LXMF with a localhost web UI + Electron shell. Architecturally a cousin of LOAM
(locally-hosted web app for off-grid messaging) but **single-user** — one identity per instance; a
client, not a multi-user host. Its notable additions: an infrastructure-visibility view (hop counts,
radio parameters, per-interface state) and a native **Iridium satellite interface** (RockBLOCK 9704)
with bounded retries for paid links — a live demonstration of what transport pluggability buys.

## Ecosystem state (August 2026) — honest read

- Active: v1.4.2 shipped July 2026; healthy app ecosystem (Sideband, NomadNet, MeshChat/Crosstalk,
  Columba) and commodity hardware (RNode on Heltec/LilyGO).
- **In transition:** the FOSDEM 2026 community talk is frank about the founder stepping back (2025),
  multiple independent implementations at varying maturity (**reticulum-rs** in Rust, **microReticulum**
  in embedded C++, a Go/WASM port), an AGPL fork (**RetiNet**), config-compatibility friction between
  implementations, documentation gaps, and community fragmentation.
- Read for LOAM: the *protocol* is proven (a decade of field use); the *ecosystem* is
  mid-reorganization. That argues for **"optional transport behind LOAM's existing sync interface"**
  — never a load-bearing rewrite on top of it.

## How it relates to LOAM

Complementary halves of the same mission:

| | LOAM | Reticulum |
|---|---|---|
| Shape | A *place*: one trusted host, many nearby strangers | A *network*: every participant runs the stack |
| Onboarding | Scan a QR in a browser, zero install | Install an app, configure interfaces, often buy a radio |
| Identity | Anonymous, ephemeral, node-local | Per-participant keypairs |
| Range | One WiFi cell (BLE/Wi-Fi Aware scaffolded, LoRa unbuilt) | Multi-hop, kilometres over LoRa, bridgeable over anything |
| Group model | Channels/threads/moderation on one host | Point-to-point + group destinations; no server |

Reticulum's weakness is exactly LOAM's strength (zero-setup onboarding for the "50 strangers in a
field" case), and vice versa (range and multi-hop resilience). So the interesting move is not LOAM
*on* Reticulum or LOAM *vs* Reticulum — it is **LOAM nodes talking to each other over Reticulum**.

## The headline idea: don't build LoRa framing — ride Reticulum (→ `docs/25` M3)

`docs/11` scopes the LoRa future as "a framing layer and aggressive bandwidth budgeting" for the
existing digest→diff→fetch sync protocol; `docs/25` M3 sizes it as an epic. Reticulum **is** that
layer, already built: framing, addressing, encryption-on-air, retransmission, and — the part LOAM
could not cheaply invent — **multi-hop routing through relays** (a drone-lofted $20 board is just a
transport node in the air; internet TCP nodes can bridge two distant LoRa islands). The shape:

- **Only the host runs RNS** (an `rnsd` sidecar on a Pi/laptop host; embedded implementations exist
  for constrained hosts). Members still join the hotspot by QR exactly as today — the zero-setup
  promise for *users* is untouched, and the host is already the person who sets things up.
- **Sync is transport-agnostic by design** — digest→diff→fetch over a Reticulum Link instead of HTTP
  is a byte-pipe swap at the transport seam, not a protocol redesign. Two LOAM nodes kilometres apart
  (or bridged through existing Reticulum infrastructure) converge with no new sync work.
- **Sealed mesh mail (`docs/16`) maps ~1:1 onto LXMF propagation nodes** — bounded store-and-forward
  of sealed blobs, auto-peering, sync-on-contact. At minimum a validating precedent for the shipped
  design; potentially an interop target.

**Caveats, stated plainly:** the reference stack is Python — natural as a sidecar on a Pi/laptop
host, awkward inside the Node.js Android host (Termux is how Crosstalk does Android; fine for
enthusiasts, not the phone-host default). The alternative implementations vary in maturity (see
ecosystem state). And Reticulum's on-air crypto is *its own* layer — LOAM's sealed envelopes would
ride it opaquely (defense in depth), but the sync bearer token / transport-key pinning questions
(`docs/25` S5/S6) still apply at LOAM's layer.

**Suggested next step (cheap, bounded):** a hardware spike — one Pi + two RNodes — running LOAM
node-to-node sync over an RNS link via a small transport adapter, measuring convergence time and
bandwidth against `docs/11`'s batching. The spike's result decides M3's fate (adopt / adapt ideas
only / reject) on evidence instead of an unbuilt epic estimate.

## Smaller ideas worth stealing regardless of the spike

1. **Announce semantics for peer discovery** (→ `sync.peers` friction, mesh Phase 3 `docs/17`):
   rate-limited, hop-counted, randomized-delay announces would let LOAM nodes *find each other* on a
   shared medium instead of operators hand-typing peer URLs — and are the right pattern for the
   Phase-3 BLE discovery beacon.
2. **Bandwidth discipline as the benchmark** (→ M3, `docs/19`): 111-byte message overhead, msgpack
   payloads, 297-byte link setup, 0.45 bps keepalive. LOAM's JSON sync envelopes are nowhere near
   this; any LoRa-bound path needs compact binary framing, and these numbers set the bar.
3. **Paper transport**: LXMF messages encode as QR codes/URIs — a message can travel on paper. Very
   LOAM-flavoured and nearly free given `packages/qr` (a sealed mesh envelope is already a compact
   blob; "print this message as a QR / scan one in" is a small feature with outsized field value).
4. **Crosstalk's infrastructure-visibility UI**: hop counts, radio parameters, per-interface state in
   the operator panel — the admin experience LOAM's Mesh panel will want once real radios exist.

## What not to do

- **Rebuild LOAM's user-facing layer on Reticulum.** Per-user RNS identities require native software
  on every participant's device — exactly the onboarding cliff LOAM exists to avoid. LOAM's
  multi-user host, anonymous ephemeral identities, and browser-only join are the differentiators.
- **Confuse it with Meshtastic.** The video's Heltec hardware also runs Meshtastic, but that is
  flood-mesh with shared channel PSKs; Reticulum is routed with per-link E2E and forward secrecy —
  the better-designed fit for LOAM's threat model and the one worth the spike.
- **Depend on ecosystem stability.** Founder transition + implementation fragmentation means: pin
  versions, keep the adapter thin, keep HTTP sync primary.
