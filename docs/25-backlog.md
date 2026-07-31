# 25 — Consolidated backlog (single source of outstanding work)

**Status: living index.** One deduplicated, code-verified list of everything **not yet built**, replacing
the scattered per-doc "future work" sections. Every item was cross-checked against the current code (July
2026); already-shipped work is excluded, and stale/contradictory doc claims are collected in §8 for
correction. Read `CLAUDE.md` for the built baseline. Per-topic design detail still lives in its own doc
(cited in each row).

Size key: **S** ≈ hours–1 day · **M** ≈ days · **L** ≈ 1–2 weeks · **epic** ≈ multi-session/branch.

## Bottom line — where the real, non-stale value is
- **(a) The device-verification last mile** — I1 / S1 / I2, all gated on a physical phone; several are
  *release gates*, not polish.
- **(b) Strategic epics awaiting a product decision** — E2EE (S2), optional authentication (S3), and the
  AT-Proto portable-identity epic (M4 → `docs/23`).
- **(c) The mesh hardware epics** — M1–M3 (need 2–3 radios).
- **(d) Cheap, purely-server LLM wins** — P2/P3 (context bounding + cancellation), S-sized.
- **(e) The offline map renderer** (P8) — the largest single unbuilt product feature, design already written.

---

## 1. Security (ranked for hostile-environment use)

| # | Item | Doc | Size | Needs |
|---|------|-----|------|-------|
| S1 | **On-device SQLCipher runtime verification** — the encrypted arm64 prebuild loads, but `PRAGMA key`/rekey/wipe was never run on physical Node-18 hardware (the MC wrapper even declares `engines: node 20/22`). A **release gate**. | 01,04,21 | S | Hardware |
| S2 | **E2EE for DMs / private channels** (docs/08 Layer 2) — server sees all plaintext; no client-side crypto. Strongest protest-model protection; disables server LLM/search for those convos; bundles into `hardened`. | 07,08,09 | epic | Product decision |
| S3 | **Optional authentication / `identity.mode`** (Better Auth now, atproto later) — enables website/team hosting without touching the anonymous default. | 05 | epic | Product decision |
| S4 | **Mesh delivery-acks (blinded per-message MAC)** — convergence rests on TTL/hop/cap only; the identity-exposing ack form is rejected, the blinded-MAC replacement is blocked pending a security decision. | 16,19 | M | Security decision |
| S5 | **Inter-node sync MITM hardening** — unpinned peer keys are TOFU-learned over plain HTTP; `SyncPeer.transportKey` pinning exists in config but the **admin-UI pinned-key field is unbuilt**; longer-term per-peer signed authors. | 08,11,15#1/#6a | S (UI) / L | — |
| S6 | **Sync peer auth: per-member / rotating creds** — only a single shared `sync.token`; revoking one courier re-keys every node. | 16,19 | M | Product decision |
| S7 | **Transport-encryption join-QR follow-ups** — thread the `#k=` host-key through the remaining join-QR surfaces (`InviteControl`, Android host-panel, `NodeLinkControl`) + live re-handshake on a runtime mode flip. | 08,15#5 | S–M | — |
| S8 | **Mesh key lifecycle vs kill switch** — decide per profile whether a panic wipe destroys the `mesh.` keyseed (likely `hardened` → yes). | 16 | S | Product decision |

## 2. Product features

**LLM (docs/06)** — *note: the O(n²) streaming fix and on-device inference are already built (see §8).*

| # | Item | Size | | # | Item | Size |
|---|------|------|--|---|------|------|
| P1 | **RAG over local content** (semantic search; the standout off-grid feature) | L | | P5 | Provider abstraction: OpenAI-compatible + cloud providers | M |
| P2 | **LLM context bounding** — ~~maps the *entire* DM history every turn~~ **PARTLY DONE**: a 40-msg recent-history cap landed (`MAX_LLM_CONTEXT_MESSAGES`, tested). A token budget + summarisation is the remaining fuller version | S | | P6 | Multiple bots/personas; tool use / function calling | M/L |
| P3 | **LLM cancellation + concurrency/rate limits** — no stop button, no cap | S–M | | P7 | LLM backend health surfaced in the UI | S |
| P4 | Channel participation / `@mention` for the bot (DM-only today) | M | | | | |

**Other**

| # | Item | Doc | Size | Needs |
|---|------|-----|------|-------|
| P8 | **Offline map renderer (MapLibre GL + PMTiles)** — pin-drop location *messages* landed; the visual map + offline tiles are the outstanding half of docs/10. | 10 | L | Product decision (tiles) |
| P9 | **Courier ("data mule") sync** — ad-hoc mutual sync, courier→node push, ring-setup wizard, opt NFC. Phases 1–3 desktop-testable. | 19 | M | Phase 4 device |
| P10 | Private-channel **join-request flow** (invite-only today) | 07,15#23 | M | — |
| P11 | Non-image **file attachments** (images only today) | 07 | M | — |
| P12 | Per-channel retention TTL (only global today) | 07,12 | S | — |
| P13 | Lock / pin channels | 07 | S | — |
| P14 | Typing indicators (presence dots exist) | 07 | S | — |
| P15 | **Web-push / PWA notifications** — and wire the dead `notifyIfHidden` (`Notification.requestPermission` is never called → notifications never fire) | 07,15#22 | S–M | — |
| P16 | Backup / export / import (team continuity; config-gated, off by default) | 07 | S–M | Product decision |
| P17 | Identity/key verification (safety numbers/QR) — only meaningful post-E2EE/accounts | 07 | M | Dep S2/S3 |
| P18 | In-band mesh contact-request flow (cards are out-of-band today) | 16 | M | — |
| P19 | Group/broadcast sealed fan-out + sealed attachments in the envelope | 16 | L | — |

## 3. Opportunistic mesh / transport (hardware epics)

*(Phases 0–2 + v2 secure addressing are built & tested.)*

| # | Item | Doc | Size | Needs |
|---|------|-----|------|-------|
| M1 | **Phase 3 native transport finish** — Kotlin BLE + Wi-Fi Aware scaffolded but never compiled/run against radios: Wi-Fi-Aware data-path handshake + port-exchange, the unimplemented BLE chunked fallback (`sendBlobFallback` throws), real-device fixes. | 16,17 | epic | Hardware (2–3 phones) |
| M2 | **Phase 4 background duty-cycling + battery** — PendingIntent discovery, burst-scan/back-off, Doze-aware. "Where Briar stalled." | 16 | epic | Hardware |
| M3 | **Phase 5 LoRa fixed relays** (Pi + LoRa hat; framing/bandwidth for the existing sync protocol) | 16,11 | epic | Hardware |
| M4 | **AT-Proto-inspired portable identity + signed user repos** — the largest remaining epic; ~30–40% seeded by mesh crypto, the repo layer is net-new. **Plan of record: `docs/23`.** | 22,23 | epic | Product decision |

## 4. Correctness / robustness

| # | Item | Doc | Size |
|---|------|-----|------|
| C1 | **Channel metadata doesn't re-sync after first import** — a rename/archive on A never reaches B | 11 | M |
| C2 | **Sync deletes/moderation don't propagate** (tombstones only stop local re-import) — by-design v1, real limit for a moderated mesh | 11,12 | M |
| C3 | **Attachment sync is single-shot best-effort** — a missed image 404s permanently on the puller | 11 | S |

*(Resolved & excluded: QR-ECC ceiling, foreground wake-lock timeout, SW network-first, setupCode-PATCH, unbounded maps.)*

## 5. Test debt

| # | Item | Doc | Size |
|---|------|-----|------|
| T1 | **WS-event reducer + reconnect/backoff untested** — still inline in `app.tsx` (the pure helpers are extracted/tested) | 15#17 | M |
| T2 | Client wipe-event e2e; avatar-contrast multi-seed sweep; QR multi-block golden matrix; schema-refinement unit tests | 15#19 | M |
| T3 | On-device `__loamOnDeviceChat` / llama.rn path — device-only (docs/21 manual checklist, not CI) | 15#15,21 | Hardware |

*(Resolved & excluded: LLM streaming tests, markdown-img XSS, i18n canonical error-code list, reaper fake-timers.)*

## 6. Tech debt

| # | Item | Doc | Size |
|---|------|-----|------|
| D1 | `app.tsx` still ~3,519 lines (down from ~5,400; much extracted) — remaining extraction is lower-ROI now | 15#21 | M |
| D2 | Dead `notifyIfHidden` (`app.tsx:342`/`:596`) can never fire — wire it (→P15) or remove | 15#22 | S |
| D3 | Native-speaker review of the 14 machine-translated i18n catalogs (structure tested, quality not) | 13 | ongoing |

## 7. Infra / device-verification

| # | Item | Doc | Size | Needs |
|---|------|-----|------|-------|
| I1 | **On-device runtime verification checklist** (docs/21 last mile): LLM load/switch/delete/timeout/GPU-honesty; SQLCipher persistent/passphrase/ephemeral/rekey; wipe-under-process-kill; locked-DB recovery; two-phone hotspot; mesh Phase-3 transfer | 21,04,17 | M | Hardware |
| I2 | `react-native-webview` 13 → 14 (pinned `13.16.1`) — needs v14 event-type annotations + device verify | 15#13 | S | Hardware |
| I3 | Device-tested **signed** release + securely backed-up production keystore *(signing infra now built + verified — remaining: a released, installed, verified signed build)* | 15#25,04 | S | Process |
| I4 | 32-bit `armeabi-v7a` Android support (arm64-only today) | 04 | S–M | Hardware |

## 8. Stale / contradictory doc claims (to correct)

Flagged by the consolidation sweep, verified against code:
1. **docs/06** "Current state" still describes the O(n²) per-token rebroadcast, calls `StreamEvent` "tested but never used," and `runInference` a "graceful stub." **All built:** `broadcastStreamEvent` emits `start/delta/end/error` (`app.ts:3983-4003`); `on-device-llm.ts` fully wires `llama.rn`. Only device *runtime* verification remains.
2. **docs/13 §6** "RTL layout audit (still needed)." **Done:** `global.css` uses logical properties throughout, zero remaining physical directional props.
3. **docs/16 §5 deviation 5** "expired-sealed tombstones aren't horizon-GC'd." Likely stale after the `pruneTombstonesHorizon` landing — confirm sealed tombstones are covered, then strike.
4. **docs/12 §6** "There's no peer authentication yet" for sync — **contradicts** the shipped `sync.token` bearer auth.
5. **docs/12 §1** "on-device DB encryption isn't available on Android yet" — **contradicts** docs/01/04 (ships, pending device verification).
6. **docs/15 #22** the `SERVER_URL_KEY` "read but never written" claim is now false (written in `transport.ts`); only the `notifyIfHidden` half stands.

## 9. Codebase-sweep findings — 2026-07-31 (open items)

Adversarial read-only sweep of server + client + Android. Verdict: **no critical/high on the host side;
ship-quality.** The three safe, verifiable findings were fixed on `feat/test-debt-and-polish` (keep-awake
shared-tag race, desktop Enter-to-send, shadow-ban attachment defense-in-depth). The rest are recorded here.

**Server — need a policy decision (a budget/cap number), so deferred to the owner:**
- **SW1 (LOW–MED)** Transport-tunnel requests bypass the tighter per-route rate limits (they hit the global
  300/min via the internal `allowList`), so avatar/attachment/mesh/search caps don't apply under the tunnel.
  Not attacker-forgeable (internal headers stripped first). Fix = a per-IP semantic limiter on the expensive
  inner handlers, or a tighter budget on `/api/transport/tunnel` — pick the numbers. `app.ts:6119`.
- **SW2 (LOW)** Stored `MessageBodySchema` is uncapped (intentional for long LLM replies), so a hostile
  *sync peer* (needs sync + token) can push ~8MB bodies. Fix = a generous finite cap on the sync-import path.
  `schema/index.ts:623`, `app.ts:5715`.

**Android host — device-specific, needs on-ROM testing (don't change the working join flow blind):**
- **HW1 (MED)** `lanAddresses()` excludes any `bridge*`/`dummy*`/`veth*` interface, but some ROMs bridge
  tethering onto `bridge0` → the join QR silently falls back to the `192.168.49.1` guess and nobody can join.
  Fix = prefer the known `192.168.49.0/24` hotspot subnet, or stop excluding `bridge`. `main.js:137`. **Test
  across ROMs before changing** — it touches the core join path.

**Mesh Phase 3 (native, documented-unverified — for the 2-phone device-test session):**
- **PH1 (HIGH, deterministic)** BLE legacy advertisement overflows the 31-byte cap (128-bit service UUID +
  service data) → every advertise fails `ADVERTISE_FAILED_DATA_TOO_LARGE`, node never discoverable. Fix =
  service-data only (drop `addServiceUuid`) or extended advertising. `MeshBleController.kt:118`.
- **PH2** Mesh hint stored UTF-8 but reported hex → group-hint gating never matches (`MeshAdvertCodec.kt`).
- **PH3** `getCapabilities`/`getMissingPermissions` construct + cache radio controllers despite a
  "side-effect-free" contract (`LoamMeshTransportModule.kt:66`).
- **PH4** Wi-Fi Aware state receiver tears down a healthy session on any state change, not just unavailable
  (`MeshWifiAwareController.kt:285`).
- **PH5** `sendBlob` may pair a `PeerHandle` with the wrong discovery session (publish vs subscribe) →
  data path never resolves (`MeshWifiAwareController.kt:505`).
- **PH6** Launcher ignores `loam-mesh-started {ok}` → marks mesh live even if native `start()` failed
  (`mesh-courier.ts:68`); **PH7** optimistic `sent.add` before ack can strand a blob if no ack arrives
  (`main.js:462`). Plus assorted nits (executor dead-code, `RECEIVER_EXPORTED` flag, invalid
  `fullBackupContent` value).

**Misc low/nit (client + host):** `notifyIfHidden` is dead (no `requestPermission` call — tie to P15 or
remove, `app.tsx:342`); `stopHostService` exported but never called (no "stop hosting" affordance); `.tmp-*`
model-store files can leak on a crash mid-save; an `'aborted'` download shows no UI feedback; Settings join-QR
lacks a `role="img"`/label. None are defects; all cheap if picked up.
