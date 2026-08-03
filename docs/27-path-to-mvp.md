# 27 — Path to MVP

**Status: plan of record for the pre-tester push.** One sequenced plan that takes LOAM from "feature-rich
but unproven" to "ready to hand to real testers." Supersedes the ad-hoc "next PR" planning. Every item in
the consolidated backlog (`docs/25`) is dispositioned here (§5), so nothing is silently lost. Sizes use the
`docs/25` key (S ≈ hours–1d · M ≈ days · L ≈ 1–2wk · epic ≈ multi-session).

## 1. What the MVP is (and the key insight)

**MVP = "A host runs LOAM on a phone/laptop/Pi; strangers nearby scan a QR and get a private, anonymous,
ephemeral group chat that works reliably offline, is secure by default, and the host can moderate — no
internet, no accounts."** That is LOAM's strongest and most-differentiated proposition; the MVP nails it
and nothing else.

**The key insight that drives the sequencing:** LOAM is already *feature-rich* (channels/threads/DMs/
reactions/presence/search/attachments/markdown, roles + ban/shadow-ban + join-approval, kill switch,
ephemeral retention, transport encryption secure-by-default, at-rest encryption, node-to-node sync, mesh
phases 0–2, on-device LLM, Android host with hotspot/kiosk, release signing). **The real MVP gate is not
missing features — it is that the on-device story is largely UNVERIFIED, and that a self-governing group
has no member-report path.** So the path is: (1) complete + govern + polish the software we can build
blind, (2) *prove it on real hardware*, then ship.

## 2. What the MVP is NOT — deliberately post-MVP

These are real, wanted, and sequenced *after* the MVP ships. They are the "grow LOAM from a great local
chat app into a platform" phase — none of them block the anonymous/ephemeral core:

- **AT-Proto-inspired portable identity + signed repos (`docs/23`, M4)** — the flagship post-MVP epic.
  Opt-in, and the *opposite* of the anonymous/ephemeral default, so it is never on the MVP critical path.
  Sol round-2 review runs *in parallel* with MVP build (§4) so Phase 0 can start the moment the MVP lands.
  Identity **Option A (portable pseudonym + encrypted backup)** is the owner's lean; confirm with Sol.
- **E2EE for DMs/private channels (`docs/08` Layer 2, S2)** — the `hardened` protest-model upgrade. Note
  the honest caveat (`docs/23`): E2EE protects against an honest-but-curious host, not a *malicious* host
  serving the PWA JS — only the signed APK does. Worth a Sol/product call before committing.
- **RAG over local content (P1)**, **offline map renderer (P8)**, **mesh Phase 3+ radios (M1–M3)**,
  optional authentication (S3), backup/export (P16). Each its own epic/PR, each with an open decision or a
  hardware/infra dependency.

## 3. The path — two big PRs to MVP

### PR 1 — Core completion & governance
The "a real community can run, govern itself, and it feels finished" PR. Software-only, no gates. Large by
design (owner wants few big PRs), split into commit-groups. Built in this order:

> **Delivered in [#109](https://github.com/JosephMaynard/loam/pull/109):** groups A (report loop), B (C1),
> the pin/per-channel-TTL/@mentions subset of C, E (S5), and F (i18n en-fallback + D2). **Deferred to
> follow-ups** (each with rationale in §5): group D (OpenRouter cloud-LLM — pending the Sol consent review),
> typing indicators / join-request / non-image file attachments (rest of C), S7 (rest of E), and the full
> 15-locale translation batch. So the list below is the *plan*; the PR shipped the safe, self-contained
> subset.

**A. Governance (new — Buzz prior-art `docs/26` idea 3):** moderation **report loop** — private member
reports (category + note, never broadcast, reporter id never leaves the mod queue) → admin/mod queue
grouped by target → act in one motion (dismiss / delete / **timeout** / ban / escalate). Adds a **timeout**
primitive (auto-expiring, enforced in `createMessage()`, composer countdown) and **honest tombstones**
("removed by a moderator" + sanitized reason, not a silent hole). Keep shadow-ban alongside (LOAM's
hostile-env threat model — the one deliberate divergence from Buzz). Slots onto the existing
`ModerationPanel` / roles / `/api/moderation` surface.

**B. Correctness:** **C1 done properly** — the channel-metadata re-sync reverted from #107, now with
**per-channel provenance** (only re-sync channels actually imported from that peer — never local/default
ones, which is what broke it) **+ peer-timestamp clamping**. Restores rename/archive propagation without
the default-channel-clobber bug review caught.

**C. Completeness / polish:** general **`@mentions`** (mention any user → highlight + notification + unread
emphasis) · per-channel retention TTL (P12) · lock/pin channels (P13) · typing indicators (P14) ·
private-channel **join-request flow** (P10) · non-image **file attachments** (P11).

**D. LLM gets good (owner opted in):** an **OpenAI-compatible provider** behind the existing `streamChat`
abstraction — so a node *with internet* can use **OpenRouter** (or OpenAI/Groq/LM Studio/vLLM) and put a
frontier model in the chat, while on-device Gemma stays the offline option (config `llm.provider`:
`ollama` | `openai` | `on-device`; `baseUrl` + `model` + a bearer `apiKey` handled like `sync.token` —
server-side only, redacted, encrypted-at-rest when DB encryption is on). Plus **in-channel `@mention` bot**
(the assistant replies in-channel via `createMessage()` + the audience-scoped `broadcastStreamEvent`, not
just DMs). **Non-negotiable honesty:** a loud "**cloud model — messages to it leave your network**" badge
on any cloud-backed assistant (prompts, and the channel context a mention pulls, go host → provider). All
gated: off by default, no cloud without a key. (Community-compute — pointing at a member's local machine —
is a `docs/06` deployment note that falls out of the same provider config.)

**E. Security polish (no product decision):** thread the join-QR `#k=` host key through the remaining
surfaces — `InviteControl`, Android host-panel, `NodeLinkControl` — + live re-handshake on a runtime mode
flip (S7); the unbuilt **admin-UI pinned-peer-key** field for sync MITM hardening (S5).

**F. Test / tech debt:** WS-reducer + reconnect/backoff tests (T1); client wipe-e2e + schema-refinement
tests (T2); opportunistic `app.tsx` component extraction (D1); resolve the dead `notifyIfHidden` (D2 —
web-push P15 can't work for a plain-HTTP LAN joiner with no secure context, so remove the dead path rather
than ship a notification that never fires; revisit push only for the Android host).

### PR 2 — Device hardening & release gate
The true MVP gate. **Needs the owner's phone(s)** — a verification gauntlet (`docs/21`) plus fixes for
whatever breaks; I build the fixes, the owner runs the checks.

- On-device **SQLCipher** `PRAGMA key` / rekey / wipe on physical arm64 Node-18 hardware (S1 — a release
  gate; the MC wrapper even declares `engines: node 20/22`).
- **Signed-release** build installed + `apksigner`-verified on a device (I3); `react-native-webview`
  13 → 14 with v14 event-type annotations + device verify (I2).
- **Two-phone** hotspot + node-to-node sync happy path; on-device LLM load/switch/delete (T3); mesh
  Phase-3 transfer *if* radios are available (else defer to the mesh epic).
- Scale spot-check: several devices joined to one hotspot at once.

**→ MVP = PR 1 + PR 2 green. Ship to testers.**

## 4. Sol review track (parallel, non-blocking)

Runs alongside the build; does not gate the MVP:

- **AT-Proto round 2** — review the revised `docs/23` (per-device operation logs, genesis-doc identity +
  off-grid recovery/freshness limit, fork-freeze) **plus** the design flags in `docs/23 §13`: fork
  resolution for both logs, `update`/`retract` target ids, out-of-order-entry quarantine, canonicalization/
  signature-CID contract. Confirm **identity Option A**, and scope the revised **Phase 0 spike**.
- **LLM cloud-provider consent design** — sanity-check the key-handling + the "context leaves the network"
  honesty surface for the OpenRouter/OpenAI-compatible backend (PR 1 group D).
- **Optional:** is a *lighter* signed-sync slice worth doing pre-epic — signed sync messages + signed
  tombstones for **delete/moderation propagation (C2)** — or does it drag in the full equivocation problem?

## 5. Full backlog disposition (every `docs/25` item accounted for)

| Item | Disposition |
|---|---|
| C1 channel-metadata re-sync | **PR 1-B** (done properly: provenance + clamp) |
| Moderation report loop (`docs/26`) | **PR 1-A** (new) |
| P4 → general @mentions | **PR 1-C** |
| P10 join-request · P11 file attach · P12 per-channel TTL · P13 lock/pin · P14 typing | **PR 1-C** |
| P5 provider abstraction (OpenAI-compatible / OpenRouter) + in-channel @mention bot | **PR 1-D** |
| S5 pinned-peer-key UI · S7 join-QR `#k=` follow-ups | **PR 1-E** |
| T1 · T2 · D1 · D2 (+ P15 dead-path removal) | **PR 1-F** |
| S1 SQLCipher runtime · I2 webview 14 · I3 signed-release install · T3 on-device LLM | **PR 2** (device) |
| S2 E2EE · S3 auth · M4 AT-Proto · P1 RAG · P8 offline map · P16 backup | **Post-MVP** (epic / product decision) |
| S4 mesh acks · S6 rotating sync creds · S8 mesh key lifecycle · P18 mesh contact-req · P19 sealed fan-out | **Post-MVP** (mesh track) |
| M1 mesh Phase 3 · M2 Phase 4 battery · M3 LoRa | **Post-MVP** (hardware epics; M1 opportunistic in PR 2 if radios) |
| C2 delete propagation | **Post-MVP** (signed-sync / AT-Proto track; "by-design v1" until then) |
| P2/P3 (LLM context/cancel) | **PR 1-D if cheap alongside the provider work, else Post-MVP** |
| P6 personas · P7 LLM health-in-UI | **Post-MVP** (only if the LLM becomes a bigger focus; P7 minor) |
| P9 courier · P17 key-verify | **Post-MVP** (P17 depends on S2/S3) |
| I1 device checklist | folded into **PR 2** |
| I4 32-bit armeabi (low value) · I5 @noble 2.x (Node-18 blocked) · D3 i18n native review (needs speakers) | **Deferred** |

## 6. Why this shape

Everything buildable-without-hardware is in one big PR 1 (owner wants few big PRs, not a swarm of small
ones), commit-grouped so it stays reviewable: governance + correctness first (the two things a real
self-governing group can't launch without), then completeness/LLM/security polish so it feels finished.
Device hardening (PR 2) is the last gate on its own because you don't want to run the hardware gauntlet,
change software, then re-run it — freeze the software, then prove it. AT-Proto and the other epics wait
until the core is proven, because rushing crypto/transport is how comparable apps failed
(`CLAUDE.md`, Bridgefy/FireChat) — and because LOAM's MVP wins on the anonymous/ephemeral core, not on
portable identity. The cloud-LLM option (PR 1-D) is the one deliberate nod outward: it only engages on an
internet-connected node, stays off by default, and announces loudly when messages leave the network.
