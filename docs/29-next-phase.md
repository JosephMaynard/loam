# 29 — Next phase: prove, then extend

**Status: plan of record for the post-MVP phase.** Successor to `docs/27` (Path to MVP), written as
that plan's two PRs close out. Every open item in the consolidated backlog (`docs/25`) is
dispositioned in §5 so nothing is silently lost. Sizes use the `docs/25` key (S ≈ hours–1d ·
M ≈ days · L ≈ 1–2wk · epic ≈ multi-session).

## 1. Where LOAM is (verified against the tree and git history, August 2026)

`docs/27`'s **PR 1 is delivered** — #109 (report loop/governance, C1 provenance re-sync, pin +
per-channel TTL + @mentions, S5 pinned-key UI, i18n en-fallback) and #110 (typing indicators,
non-image file attachments, private-channel join requests) — **except group D** (the
OpenAI-compatible cloud-LLM provider + in-channel @mention bot), which awaits the Sol consent-design
review, plus the S7 join-QR follow-ups and the 15-locale translation batch (deferred in #109).

**PR 2 (the device gate) is mid-flight**: v0.4.0 is cut and in the field as an RC, and real-device
feedback already caught and fixed the hotspot join-address blocker (#114) — but per #114's own
verification note, the on-device re-test of those fixes, the STA+AP two-phone re-test, and the rest
of the `docs/21` gauntlet (S1 SQLCipher runtime, I3 signed-install verify, T3 on-device LLM, I2
webview 14) remain open.

So: **LOAM is one verification pass away from "MVP shipped."** This plan is about what that pass
unblocks.

## 2. How the pieces fit together — three convergences

The backlog's epics are not independent. They cluster around three centres of gravity — and the three
prior-art reviews (`docs/22`/`23` AT Proto, `docs/26` Buzz/Nostr, `docs/28` Reticulum) each point at
one of them:

**Convergence 1 — signed content is one foundation shared by four tracked items.** M4 (portable
identity + signed repos), C2 (delete/moderation propagation), the long-term half of S5 (per-peer
signed authors), and the Nostr corroboration in `docs/26` are all the same capability: *messages and
tombstones carrying author signatures verifiable without trusting the relaying node*. `docs/27` §4
already queues the right question for Sol ("is a lighter signed-sync slice worth doing pre-epic?").
This plan assumes the answer is yes: **signed sync messages + signed tombstones** is a bounded
M-sized slice that delivers C2 on its own merits *and* is the natural Phase 0 of M4 — the
canonicalization/signature contract gets field-tested on public data before the identity epic bets
on it.

**Convergence 2 — Reticulum reframes the transport epics and challenges their ordering.** M3 (LoRa)
was an epic because LOAM would build framing/routing/bandwidth-budgeting itself; `docs/28` collapses
it to a thin adapter + a ~£150 hardware spike (Pi + two RNodes). More strategically: M1/M2 (phone
BLE/Wi-Fi Aware native + battery duty-cycling) are the highest-risk items on the board — "where
Briar stalled," with seven known unverified native defects (PH1–PH7) and multi-phone dependencies.
If the spike shows *range* comes cheaply from a host-side radio bridge, and *store-and-forward* is
already covered by courier sync (P9, works on every phone) plus the shipped sealed-mail relay, then
M1/M2 stop being the critical path to the mesh vision and can be **deliberately demoted rather than
silently stalled**. The spike buys evidence for that call.

**Convergence 3 — the LLM track has one decided-but-unbuilt piece, then a fork.** Group D is
designed, owner-approved, and gated only on Sol's consent check; it is the most tester-visible
improvement available. Beyond it, P1 (RAG/semantic search — the standout off-grid feature) is the
next big LLM bet; P6 personas follow the Buzz pattern (`docs/26` idea 2) if the LLM becomes a focus.

## 3. The plan — four tracks

### Track 0 — Close the device gate *(now; blocks MVP declaration)*
Finish `docs/27` PR 2: on-device re-test of the #114 fixes + the STA+AP two-phone re-test, then the
remaining `docs/21` gauntlet — S1 (SQLCipher `PRAGMA key`/rekey/wipe on physical arm64 Node-18), I3
(signed release installed + `apksigner`-verified), T3 (on-device LLM load/switch/delete), I2
(webview 13→14 + device verify), the HW1 `bridge0` ROM check, and a several-device scale spot-check.
The owner runs the phones; fixes get built for whatever breaks. **Exit: MVP declared, testers
onboarded.**

### Track A — Tester-driven polish + LLM group D *(software; parallel with Track 0)*
- **Group D as designed in `docs/27`** once Sol's consent review clears: `llm.provider`
  (`ollama` | `openai` | `on-device`), OpenRouter/OpenAI-compatible backend, in-channel @mention bot
  via `createMessage()` + audience-scoped streaming, the loud "cloud model — messages leave your
  network" badge, key handled like `sync.token`. Fold in P2 (token budget) and P3 (cancellation +
  concurrency caps) while in that code; P7 (backend health in UI) if trivial.
- **S7** join-QR `#k=` follow-ups (the deferred rest of PR 1-E).
- **Reactive polish**: the RC is in the field for the first time — tester feedback outranks the
  backlog for this track. Sweep the deferred PR 1-F remainder (T1/T2/D1 — verify what #109 actually
  closed, finish the rest) and the misc sweep nits (`.tmp-*` model files, aborted-download feedback,
  QR `role="img"`, `stopHostService` affordance) opportunistically.
- **SW1** (tunnel-bypass semantic rate limits) once the owner picks the budget numbers (§4).

### Track B — Signed-sync slice → M4 *(the strategic software epic; starts as review, not code)*
1. **Sol round 2** on `docs/23` (per-device operation logs, genesis-doc identity, fork-freeze,
   the §13 design flags) + the lighter-slice question — already queued in `docs/27` §4.
2. If green: build **signed sync messages + signed tombstones** behind a flag → **C2** (delete/
   moderation propagation) lands as the user-visible payoff; S5's "per-peer signed authors" follows
   from the same machinery.
3. Then, with the MVP proven and the signature contract field-tested, open the **full M4 epic**
   (identity Option A pending owner confirmation, §4). P17 (key verification UX) and the mesh
   follow-ups that depend on identity decisions (S8) slot in here.

### Track C — Reticulum spike *(the strategic hardware experiment; independent of everything)*
Per `docs/28`: Pi + two RNodes, an `rnsd` sidecar, a thin transport adapter running digest→diff→fetch
over an RNS Link; measure convergence and bandwidth against `docs/11` batching. **The result decides
M3** (adopt / steal-ideas-only / reject) **and informs whether M1/M2 stay epics or get demoted** in
favour of courier (P9) + radio bridge. Independent of the spike's outcome, three `docs/28` steals
stand on their own: announce-based peer discovery (removes `sync.peers` hand-typing), compact binary
sync framing (the 111-byte LXMF benchmark), and paper/QR message transport (cheap given
`packages/qr`).

### Parked — with reasons
- **S2 E2EE**: needs the product call `docs/27` flags — its honest value depends on the signed-APK
  distribution story (a malicious host serves the PWA JS). Revisit after M4 Phase 0, which builds
  related client-key muscle.
- **S3 optional auth, P8 offline maps, P16 backup/export**: product decisions with no dependency
  pressure; P8 is the largest single product feature and deserves its own phase when chosen.
- **M1/M2 + the PH1–PH7 native defects**: pending Track C evidence. Exception: **PH1** (BLE advertise
  31-byte overflow) is deterministic and fixable blind — do it whenever adjacent, so the scaffold
  isn't known-broken.
- **P9 courier phases 1–3**: desktop-testable and M-sized — the first candidate to pull forward if a
  tester community actually runs multi-node.
- **P19 sealed fan-out, P18 contact requests, S4 mesh acks** (design decided, ready to build), **S6
  rotating sync creds**: the mesh product track — sequence after Track C settles the transport story.
- **I4 32-bit ABI** (low value), **I5 @noble 2.x** (Node-18-blocked), **D3 i18n native review**
  (needs speakers): unchanged deferrals.

## 4. Decisions reserved for the owner

1. **Spend order for Tracks B vs C** if serialized: B is higher product value (moderated mesh); C is
   cheaper and retires more uncertainty per pound. (Both can run — B starts as Sol review.)
2. **Identity Option A vs B** for M4 (`docs/23` §9; A — portable pseudonym + encrypted backup — is
   the recorded lean; Sol round 2 pressure-tests it).
3. **The M1/M2 demotion question** after the Track C spike — a direction change from `docs/16`'s
   phased plan, so it is the owner's call, made on the spike's evidence.
4. **Track C hardware purchase** (~£150: Pi + 2× RNode-flashed Heltec/LilyGO).
5. **SW1 rate-limit numbers** (per-IP budgets for tunnel-wrapped expensive routes).
6. **S8 mesh key lifecycle** (does a `hardened` panic wipe destroy the mesh keyseed — likely yes).

## 5. Full backlog disposition (every open `docs/25` item)

| Item | Disposition |
|---|---|
| S1 SQLCipher runtime · I3 signed install · T3 on-device LLM · I2 webview 14 · I1 checklist · HW1 bridge0 | **Track 0** (device gate) |
| Group D (P5 provider + @mention bot) · P2 · P3 · P7 | **Track A** (post-Sol-consent) |
| S7 join-QR follow-ups · T1/T2/D1 remainder · SW1 (needs §4.5) · sweep nits | **Track A** |
| Sol round 2 (`docs/23` + lighter slice) | **Track B step 1** (already queued) |
| C2 delete propagation · S5 long-term (signed authors) | **Track B step 2** (signed-sync slice) |
| M4 portable identity epic · P17 key verify · S8 (after §4.6) | **Track B step 3** |
| M3 LoRa | **Track C** (spike decides: adopt RNS / ideas-only / reject) |
| Announce-based peer discovery · binary sync framing · paper/QR transport (`docs/28`) | **Track C** side-steals (spike-independent) |
| M1 mesh Phase 3 · M2 Phase 4 battery · PH2–PH7 | **Parked pending Track C** (§4.3) |
| PH1 BLE advertise overflow | Fix blind when adjacent (deterministic) |
| P9 courier | Parked; first pull-forward if testers run multi-node |
| S4 mesh acks · S6 rotating creds · P18 contact requests · P19 sealed fan-out | Mesh product track, after Track C |
| S2 E2EE · S3 auth · P8 map · P16 backup | **Parked** (product decisions; §3 Parked) |
| P1 RAG · P6 personas | LLM fork after group D beds in (P1 first — the off-grid differentiator) |
| P15 web-push | Resolved as removed for LAN joiners (`docs/27` PR 1-F); revisit only for the Android host |
| I4 · I5 · D3 | **Deferred** (unchanged) |

## 6. Why this shape

The MVP gate stays first and alone because the freeze-then-prove logic of `docs/27` §6 still holds —
hardware verification mustn't chase a moving target. After it, the phase deliberately splits *reactive*
work (Track A: testers now exist; listen to them) from *strategic* work (Tracks B and C), and both
strategic tracks are structured to spend a little before committing a lot: B starts as an external
design review, C as a bounded spike — because the two biggest risks on the board (rushed identity
crypto, and phone-radio work "where Briar stalled") are exactly the failure modes of comparable apps
(`CLAUDE.md`, Bridgefy/FireChat). The convergences in §2 are the reason this isn't just a priority
list: one signed-content foundation serves four backlog items, and one cheap spike can retire or
redirect three hardware epics. Sequencing them as tracks means each expensive commitment is made on
evidence the phase itself produces.
