# 07 — Other features worth considering

Candidate features surfaced while researching the roadmap, prioritized by fit with LOAM's stated
priorities (simplicity, privacy, resilience) and its threat models. Not commitments — a menu for the
owner/Fable to pick from. "Threat-fit" flags the protest/privacy use case specifically.

| Feature | Why it matters | Effort | Threat-fit | Notes |
|---------|----------------|--------|-----------|-------|
| **Ephemeral / disappearing messages + retention policy** | Proactive privacy; complements the reactive kill switch | S–M | ★★★ | Per-channel/global TTL, a reaper deletes old rows. Trivial on SQLite. |
| **End-to-end encryption (DMs / private channels)** | Server currently sees **all plaintext**; the strongest protection for the protest model | L | ★★★ | Big strategic call — see below. Tension with LLM/RAG/search/broadcast filtering. |
| **Attachments (images/files)** | Real coordination needs photos/maps, not just text | M | ★★ | Reuse the avatar upload/crop pipeline + signature checks; strict size caps for low bandwidth. |
| **LoRa / multi-node store-and-forward sync** | The stated transport goal; extends range beyond one hotspot | L | ★★ | Its own initiative — see below. Append-only + unique ids make merge tractable. |
| **Moderation tools** | Needed for team/website mode (delete any message, remove/ban user, lock/pin) | M | — | Lives in the admin UI ([03](03-admin-ui.md)); pairs with auth roles ([05](05-authentication.md)). |
| **Message search** | Basic usability as history grows | S–M | — | Server-side LIKE to start; semantic search falls out of the RAG embeddings ([06](06-llm.md)). |
| **i18n + RTL (actually implement it)** | README **promises** multilingual + RTL support that **isn't in the code** (verified: no `dir`/`lang`/i18n anywhere) | M | ★ | Either build it (`dir="auto"`, `lang`, a translation layer) or soften the README. Do an a11y pass alongside. |
| **Presence / typing indicators** | Liveness in active conversations | S | — | Over WS; make it privacy-toggleable (some deployments won't want it). |
| **Web push / PWA notifications** | Re-engagement on the local network | M | — | Limited value fully offline; useful for same-network alerts (e.g. new announcement). |
| **Backup / export / import** | Team/website continuity | S–M | ✗ (anti-fit) | Great for team mode, **dangerous for protest mode** — must be config-gated and off by default. |
| **Identity/key verification (safety numbers, QR)** | Trust in authenticated/E2EE mode | M | ★★ | Fits LOAM's QR idiom; only meaningful once accounts or E2EE exist. |
| **Onboarding / first-run + theming** | Polish; avatar code already computes light/dark palettes | S | — | Low risk, nice-to-have. |
| **Rate limiting / anti-abuse** | Open instances invite spam/flooding | S–M | — | Per-session/IP limits on message POST + WS; also protects the LLM ([06](06-llm.md)). |

## Deeper notes on the big ones

### End-to-end encryption (strategic decision)
Today every message body is **plaintext in the DB and visible to the server** (verified: no crypto in the
codebase). The [01 at-rest encryption](01-sqlite-migration.md) + [02 kill switch](02-kill-switch.md) work
protects data *on the host*, but the server still *processes* plaintext. True E2EE (client-side
encryption, server relays ciphertext) is the strongest answer for the oppressive-regime model — but it
**conflicts with server-side features**: LLM/RAG, search, and the DM/reaction audience filtering in
`broadcast()` all need plaintext. Realistic path: keep the LAN + at-rest encryption as the baseline, and
offer **optional E2EE for DMs and private channels** as an advanced mode that knowingly disables
server-side LLM/search for those conversations. Key exchange can lean on LOAM's QR idiom. Treat this as
its own initiative and a top-level decision, not a quick add.

### Ephemeral messages (recommended early, cheap, high threat-fit)
> **Status: landed** (global TTL) — `retention.messageTtlMs` in the shared config, a 30s reaper
> (+ boot-time sweep) that deletes expired messages from memory + SQLite and broadcasts
> `messageDeleted` so connected clients purge their caches; in-flight LLM streaming messages are
> spared until they finish; editable live from the admin UI (minutes field, blank = keep). Not yet:
> per-channel TTLs, and offline clients only reconcile when they receive live delete events.

A per-channel/global `retentionMs` config + a periodic reaper (`DELETE FROM messages WHERE created_at <
now - ttl`) gives disappearing messages almost for free once on SQLite. It's the *proactive* complement
to the kill switch: minimize what exists to be seized in the first place. Broadcast a `messageDeleted`
so clients drop them from IndexedDB too (same plumbing the kill switch needs).

### LoRa / multi-node store-and-forward (its own initiative)
The README's headline goal. Nodes gossip messages over a low-bandwidth transport with dedup by the
existing unique message ids. LOAM's data model is friendly to this: messages are append-only and
reactions are toggles, so a last-writer/union merge largely works. Needs a sync protocol (offer/ack of
id ranges), a transport abstraction (the app is already "transport-agnostic" in spirit), and bandwidth
budgeting. Big, but it's the differentiator — worth a dedicated design doc when the core is stable.

## Suggested near-term picks
If choosing a couple to slot in alongside the main roadmap: **ephemeral messages** (cheap, high
threat-fit, reuses kill-switch plumbing) and **attachments** (reuses the avatar pipeline, unblocks real
coordination). Flag **E2EE** and **LoRa sync** as their own initiatives to schedule deliberately, and
**resolve the i18n/RTL README-vs-reality gap** either way.
