# 29 — Next phase: stabilize, prove, then extend

**Status: plan of record for the post-v0.4.0 phase — revision 2, incorporating Sol's full-codebase
review (2026-08-15, `sol-review/REVIEW-RESULT-full-codebase-2026-08-15.md`).** Successor to `docs/27`
(Path to MVP). Every open item in the consolidated backlog (`docs/25`) is dispositioned in §5 so
nothing is silently lost. Sizes use the `docs/25` key (S ≈ hours–1d · M ≈ days · L ≈ 1–2wk ·
epic ≈ multi-session).

Revision 1 assumed LOAM was one hardware-verification pass from MVP. Sol's review showed it is **one
security/correctness pass plus one hardware pass**: the create-path checks (membership, timeout,
flags) are solid, but the *mutation* paths (edit/delete/react) don't re-check them, archive semantics
are internally inconsistent, media files sit outside the at-rest encryption story, and the flagship
`npx loamnet` join QR lacks the `#k=` transport key. Those findings — all independently code-verified —
are now Track 0.

## 1. Where LOAM is (verified, August 2026)

`docs/27`'s **PR 1 is delivered** (#109 + #110: report loop/governance, C1 provenance re-sync,
@mentions, per-channel TTL, lock/pin, typing, file attachments, join requests, S5 pinned-key UI)
**except group D** (cloud-LLM provider + in-channel bot — awaits the consent design, now Track 3) and
the S7 join-QR follow-ups. **PR 2 (device verification) is mid-flight**: v0.4.0 is tagged, released,
and `loamnet@0.4.0` is on npm; the first device-feedback round (#114) fixed the hotspot join-address
blocker; the on-device re-test of those fixes, the STA+AP two-phone re-test, and the rest of the
`docs/21` checklist remain open. **Sol's stabilization findings (Track 0) now precede all of it.**

## 2. How the pieces fit together — three convergences

The backlog's epics are not independent; they cluster around three centres of gravity, one per
prior-art review (`docs/22`/`23` AT Proto, `docs/26` Buzz/Nostr, `docs/28` Reticulum):

**Convergence 1 — signed content is one foundation shared by four tracked items.** M4 (portable
identity + signed repos), C2 (delete/moderation propagation), the long-term half of S5 (per-peer
signed authors), and the sync-peer impersonation finding are all the same capability: content
carrying signatures verifiable without trusting the relaying node. **Caveat (Sol):** the convergence
is real but the *slice size* is not settled — "signed messages" only beat impersonation if the
verifier knows which key legitimately belongs to which author, and that binding question (who signs?
node or user? how does an anonymous `user.<8hex>` acquire a key? who may sign a tombstone?) may pull
in most of M4. A **node-signed provenance** slice ("node A asserts this message came from A") is
honestly M-sized, fixes peer impersonation, and defers the user-identity questions entirely. Sol
round 2 decides which slice is real; do not force the prettier one (§ Track 4).

**Convergence 2 — Reticulum reframes the transport epics and challenges their ordering.** M3 (LoRa)
collapses from an epic to a thin adapter + a ~£150 spike (Pi + two RNodes, `docs/28`). If the spike
shows range comes from a host-side radio bridge, and store-and-forward from courier sync (P9) + the
shipped sealed-mail relay, then M1/M2 (phone BLE/Wi-Fi Aware + battery — "where Briar stalled", with
known deterministic defects PH1–PH7) stop being the mesh critical path and can be deliberately
demoted rather than silently stalled.

**Convergence 3 — the LLM track has one designed-but-unbuilt piece, then a fork.** The cloud
provider + bot (ex group D) is the most tester-visible improvement available, but it is also the
product's largest trust-model exception, so it runs as its own explicitly-labelled experiment
(Track 3) and never delays reliability work. Beyond it: P1 RAG (the off-grid differentiator), P6
personas (Buzz pattern).

## 3. The plan — six tracks

### Track 0 — Stabilize the RC *(STATUS: DELIVERED — PR #118, this branch; kept as the record of scope)*
The security/correctness pass from Sol's review, all buildable blind, one branch → one PR:
1. **One shared mutation policy** — "may this user create *or alter* content in this channel right
   now" (membership/audience, timeout, ban/pending, archived, flags) applied uniformly to post,
   edit, delete, react, attach, and typing. Fixes: removed members editing old private-channel
   messages; timed-out users editing; mutations in archived channels.
2. **Archive/delete semantics (owner-decided 2026-08-15):** archive = **read-only but still
   available** to its prior audience (listed, readable, nothing new — no posts/edits/reactions/
   attachments); delete = **permanent** — a first-class channel delete with cascade (messages +
   attachments), a sync tombstone so peers can't re-import it, and a targeted `channelRemoved`.
   Applied centrally: history, reactions, edit/delete, attachments, search, sync.
3. **CLI keyed join** — `npx loamnet` obtains the host transport key and prints the `#k=` join URL/QR
   (closes the first-join MITM gap on the flagship CLI path; the concrete missing S7 surface).
4. **Attachment body-limit fix** — set the Fastify `bodyLimit` so the decoded 1 MB cap is actually
   reachable through base64+JSON framing; regression-test at realistic sizes.
5. **Tunnel semantic rate limits** — per-IP limits on the expensive inner routes (uploads, mesh,
   search) charged under `/api/transport/tunnel`; conservative configurable engineering defaults,
   no owner numbers needed.
6. **Media-at-rest honesty** — correct SECURITY.md/`docs/02`/profile docs: media files are plaintext
   on disk and key destruction does not cryptographically erase them; kill-switch deletion is
   best-effort. (Actual media encryption is Track 2 — deliberate crypto is not rushed pre-freeze.)
7. **Expo dependency triage** — reconcile `expo install --check` drift *with judgment*: revert
   accidental Dependabot drift, keep deliberate pins (webview 13.16.1 is SDK 57's expectation),
   document each call. Precondition for trusting Track 1 results.
8. **Lifecycle regression tests** for every transition above (removal×edit, archive×everything,
   timeout×mutations, realistic attachment sizes).
9. **Doc-drift sweep** (same branch): SECURITY.md stale claims (transport encryption/peer auth/
   Android encryption are *shipped*), CHANGELOG 0.4.0, `docs/roadmap.md`/`docs/25`/`docs/27`
   statuses, `docs/06`/`docs/16`/`decisions.md`, CLAUDE.md/README.

### Track 1 — Device verification gate *(the MVP gate; owner's phones)*
**Freeze discipline (explicit):** once Track 0 merges, tag an RC and rebuild the APK; the RC takes
**only** fixes for bugs Track 1 itself finds. All feature work happens on branches and merges only
after the checklist completes. Contents: on-device re-test of the #114 fixes + STA+AP two-phone
re-test; the remaining `docs/21` items — S1 SQLCipher runtime (`PRAGMA key`/rekey/wipe,
wipe-under-process-kill, locked-DB recovery), I3 signed-install verify, T3 on-device LLM
(switch/delete/RAM), webview verify (I2 = verify-in-place; no bump — SDK 57 pins 13.16.1), HW1
`bridge0` ROM check, several-device scale spot-check. **Exit: MVP declared, tag shipped, testers
onboarded.**

### Track 2 — Tester support & reliability *(post-MVP; feedback outranks this list)*
- **Field feedback first** — the RC is in front of real users for the first time.
- **Media encryption at rest** (the deferred half of Track 0 §6): encrypt attachment/avatar files
  with a key held in the encrypted DB (`@loam/crypto`), restoring the cryptographic-erase story.
- **Courier ("data mule") sync (P9)** — promoted (Sol concurs): works on every phone, exercises the
  sync model, provides store-and-forward with zero radio risk, and field-validates delivery-ack +
  signed-sync designs before any radio carries them. Pair with S4 mesh acks (design decided) and
  storage quotas.
- **Operator diagnostics + storage budgets** (Sol's feature list): disk/encryption/sync health,
  attachment orphans, upload quotas, low-disk protection; a guided pre-event "field drill" check.
- Remainder: T1/T2/D1 test-debt, sweep nits, accessibility pass.

### Track 3 — Cloud LLM experiment *(separate branch; optional, loud, off by default)*
The ex-group-D provider work (`llm.provider`: `ollama` | `openai` | `on-device`; OpenRouter et al),
**DM-only initially**, with the consent model tightened per Sol: an in-channel bot requires
**channel-level admin enablement + persistent participant-visible disclosure** — a mention exports
*other participants'* messages, so mentioner consent is not consent. Cloud stays disabled in
`hardened`. P2 token budget + P3 cancellation ride along. Never delays Track 2.

### Track 4 — Signed sync → portable identity *(starts as review, not code)*
1. **Sol round 2** on `docs/23` + the slice question, now sharpened: settle the key↔author binding
   (user- vs node-signed; tombstone authority; rotation/revocation/replay/legacy-unsigned) before
   sizing. Candidate outcomes: (a) author-signed slice separates cleanly → build it; (b) it doesn't →
   build **node-signed provenance** (M-sized, fixes peer impersonation, no identity questions);
   (c) neither pre-epic.
2. The chosen slice → C2 delete/moderation propagation as the user-visible payoff.
3. The full M4 epic (identity Option A — portable pseudonym + encrypted backup — pending owner
   confirmation) only after MVP feedback stabilizes.

### Track 5 — Reticulum spike *(independent; ~£150 hardware)*
Per `docs/28`: Pi + two RNodes, `rnsd` sidecar, thin adapter, digest→diff→fetch over an RNS link;
measure. Result decides M3 (adopt / ideas-only / reject) and informs the M1/M2 demotion call. The
spike-independent steals stand regardless: announce-based peer discovery, compact binary sync
framing, paper/QR message transport.

### Parked — with reasons
- **S2 E2EE**: strongest in a signed native client (a host-served PWA can replace its own JS);
  defer until identity + native distribution are stable. **S3 auth / P8 maps / P16 backup**: product
  decisions, no dependency pressure; P8's tiles should be an optional operator-installed pack.
- **M1/M2 + PH2–PH7**: pending Track 5 evidence. **PH1 + the unimplemented BLE fallback are
  deterministic implementation gaps, not hardware unknowns** — fix whenever adjacent; docs describe
  Phase 3 as "compiled (in APK builds) but not radio-validated".
- **P18 contact requests · P19 sealed fan-out** (verify partial status vs the mesh broadcast path
  before restating) · **S6 rotating sync creds**: mesh product track, after Track 5.
- **I4 32-bit ABI · I5 @noble 2.x (Node-18-blocked) · D3 i18n native review**: unchanged deferrals.

## 4. Decisions reserved for the owner

1. **Spend order for Tracks 4 vs 5** if serialized (4 = product value; 5 = cheapest risk retirement).
2. **Identity Option A vs B** for M4 (`docs/23` §9; A is the recorded lean; round 2 pressure-tests it).
3. **The M1/M2 demotion question** — decided on Track 5's evidence, owner's call.
4. **Track 5 hardware purchase** (~£150: Pi + 2× RNode-flashed boards).

*Removed from the list (Sol, agreed):* tunnel rate-limit numbers → conservative configurable
engineering defaults; mesh-key-wipe-on-panic → a security **invariant** (hardened panic wipe
destroys every locally held identity/decryption key) rather than a choice. *Decided 2026-08-15:*
archive = read-only-available, delete = permanent (§3 Track 0.2).

## 5. Full backlog disposition (every open `docs/25` item)

| Item | Disposition |
|---|---|
| Sol P1 1–3 (mutation authz) + archive/delete semantics + lifecycle tests | **Track 0.1–2, 0.8** |
| Sol P1 5 / S7 remainder (CLI `#k=`) | **Track 0.3** (browser/Android surfaces already built) |
| Sol P2 body-limit · SW1 tunnel limits | **Track 0.4–5** (engineering defaults) |
| Sol P1 4 (media at rest) | honesty **Track 0.6** → encryption **Track 2** |
| Expo matrix triage · doc drift | **Track 0.7, 0.9** |
| S1 SQLCipher runtime · I3 signed install · T3 on-device LLM · I2 webview verify · I1 checklist · HW1 | **Track 1** |
| P9 courier · S4 mesh acks · media encryption · diagnostics/quotas · T1/T2/D1 · accessibility | **Track 2** |
| Ex-group-D provider (P5) + bot · P2 · P3 · P7 | **Track 3** |
| Sol P2 peer impersonation · C2 delete propagation · S5 long-term · M4 · P17 | **Track 4** (slice per round 2) |
| M3 LoRa · announce discovery · binary framing · paper/QR transport | **Track 5** |
| M1 · M2 · PH2–PH7 | Parked pending Track 5 (PH1 + BLE fallback: fix when adjacent) |
| S2 E2EE · S3 auth · P8 map · P16 backup · P18 · P19 (verify) · S6 | Parked (§3) |
| S8 | Resolved as invariant (§4) · P15 web-push: resolved-removed (`docs/27`) |
| I4 · I5 · D3 | Deferred (unchanged) |

## 6. Why this shape

Track 0 exists because Sol's review found the create-path/mutation-path asymmetry that 999 green
tests missed — coverage concentrated on steady-state, not transitions; the fix and its regression
tests are cheap *now* and expensive after testers hit them. The freeze rule in Track 1 resolves the
revision-1 contradiction between "parallel work" and "don't chase a moving target": parallel work is
fine, *merging it into the RC under test is not*. Tracks 2–5 keep the revision-1 logic — reactive
work split from strategic work, and both strategic tracks spend a little before committing a lot
(round 2 review before signed-sync code; a £150 spike before any radio epic) — because rushed
identity crypto and phone-radio background work are exactly how comparable apps died
(`CLAUDE.md`, Bridgefy/FireChat). The cloud LLM is quarantined in its own track because it is the
one feature that *weakens* a security promise rather than strengthening one; it must never be a
dependency of anything else.
