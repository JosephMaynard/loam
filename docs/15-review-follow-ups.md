# 15 — Review follow-ups (next-phase backlog)

Output of a full four-area code review (server / client / packages+android / tests) plus a
dependency-alignment pass. The high-value, low-risk findings were **fixed in the same branch**
(shadow-ban REST leak, shadowBanned egress strip, panic fingerprinting, unbounded schema strings,
silent message sends, a pnpm catalog for version alignment, and assorted robustness). This file is
the **deferred** backlog — the items that are larger, riskier, or need hardware/product decisions —
ranked within each group. Each entry names the file and the concrete change.

## Security — do these before any hostile-environment deployment

1. **Sync import trusts peer-supplied `authorId` (impersonation).** `importPeerMessages`
   (`apps/server/src/app.ts`) accepts any `authorId`, including a **local** admin/moderator's id, and
   renders the injected message as authored by that identity. Mitigation now: `sync.token` gates
   *which* peers may talk. Next: reject an imported message whose `authorId` matches a locally
   *authoritative* user (admin/moderator/greeter) unless that author record was itself imported;
   longer-term, per-peer **signed authors** (docs/11).
2. ~~**Kill switch can be partially undone by an in-flight sync round.**~~ **RESOLVED**
   (`feat/mesh-secure-addressing`): a `wipeGeneration` counter is bumped at the top of
   `executeKillSwitch` (before its first await); `syncWithPeer` snapshots it and bails after the digest
   fetch, after each message fetch, and `importPeerMessages` bails after its attachment fetch — so a
   pull that resumes after a wipe abandons the round instead of re-persisting peer data.
   `importPeerAttachments` carries the same guard (bails after its download, and unlinks the file if a
   wipe lands during the write), so no orphaned attachment survives. The deterministic gated-peer test
   (kill switch fires while the pull is suspended on the peer's response) verifies the **message + user**
   path specifically; the attachment guard is the same construction, not separately fixtured.
3. ~~**`roles` leak.**~~ **RESOLVED** (`feat/mesh-secure-addressing`): `publicUser` now strips `roles`
   as well as `shadowBanned`; a new `rolesVisibleUser` keeps them for the subject's own record and for
   moderators, and one `sanitizeUserFor(viewer, user)` helper is the single decision every user-egress
   path routes through. Covered: `GET /api/users` (`visibleUsers(viewer)`), `/api/config` `currentUser`
   (own roles kept), the recipient-aware `userUpserted` broadcast (roles only to subject + moderators),
   the sync author export, **the private-channel member list** (`GET /api/channels/:id/members` — a
   non-moderator member no longer sees others' roles/`shadowBanned`), and **the pending-access endpoints**
   (`/api/access/pending|approve|deny` — a non-moderator greeter no longer sees them). Member-list and
   roster tests cover it. (Known residual: `isAdmin` is still enumerable to everyone — lower
   sensitivity, pre-existing, left as-is.)
4. **"Wipe this device" can't revoke the server session.** The identity is the HttpOnly
   `loam_session` cookie, which JS can't clear, so a reload re-mints the same identity and re-hydrates
   the cache (`purgeLocalData`, `apps/client/src/app.tsx`). Add an endpoint to invalidate the current
   session that the wipe calls, and guard `putRecords`/`putRecord` against writing after a wipe flag is set (a
   racing in-flight fetch can otherwise re-create the DB). Or document that device-wipe is cache-only.
5. **Transport encryption (docs/08).** LOAM serves plain HTTP on the LAN by design — fine for a
   trusted room, not an adversarial network. This is the largest remaining hostile-environment gap.
6. **On-device SQLCipher.** The Android DB is unencrypted at rest; needs a multiple-ciphers ABI-108
   android-arm64 prebuild (docs/01, docs/04).

## Correctness / robustness

7. **Unbounded tombstone growth on ephemeral-retention nodes.** The reaper adds a tombstone per
   reaped message forever (`tombstones` Set + DB table), so a long-lived high-traffic ephemeral node
   grows without bound even when sync is off. Don't tombstone retention-reaped messages, skip
   tombstoning entirely when `sync.enabled` is false, or age tombstones out beyond a horizon.
8. **Switching bootstrap to `setupCode` via config PATCH is inert.** A code is only minted at boot /
   kill-switch, never when a runtime PATCH transitions `admin.bootstrap` into `setupCode`, so the
   claim flow is advertised but produces no code. Mint one on that transition.
9. **Minor unbounded maps.** `attemptRateLimited` only prunes above 1000 entries (so >1000 distinct
   source IPs grow past the cap); `peerSyncStatus` is never pruned when an admin removes a peer.
   Bounded by LAN scale, but worth a periodic sweep.
10. **QR capacity ceiling can drop the WiFi QR.** The encoder maxes at version 6 / ECC level **H**
    (58 bytes); a `LocalOnlyHotspot` SSID plus a longer/escaped passphrase can exceed it, silently
    degrading Step-1 to plain text (`packages/qr`). Support a lower ECC level (L/M ≈ doubles capacity)
    for the WiFi payload path, or higher versions.
11. **Foreground-service wake lock has no timeout.** `LoamHostService.kt` acquires a
    `PARTIAL_WAKE_LOCK` with no bound; a `START_STICKY` restart after an OOM kill could pin the CPU
    indefinitely. Acquire with a bounded timeout and re-acquire, or add a hard cap.
12. **Service worker is cache-first, not "network-first-ish" as documented.** Navigation/document
    requests can serve a stale `index.html` after a deploy (`public/service-worker.js`). Use
    network-first for navigations, keep hashed assets cache-first. (No cache-poisoning risk — it
    already excludes `/api` and `/ws`.)

## Dependencies

13. **`react-native-webview` 13 → 14** (held). A major bump that broke the `apps/app` typecheck
    (`onError`/`onHttpError` `nativeEvent` implicit-any). Expo 57 accepts any version (`*`), so it's
    unblocked upstream — annotate the WebView event handlers with the v14 event types and **verify on
    a physical device** before it ships in the APK.
14. **`@types/node`** intentionally stays on `^24` (tracks the pinned Node 24 runtime); revisit when
    the Node LTS the project targets moves. Now centralised in the pnpm `catalog:` so it moves in one
    place.

## Test coverage (highest-value gaps)

15. **LLM/Ollama streaming is completely untested server-side** — the delta-privacy invariant (deltas
    to DM participants only), single-`messageUpdated` convergence, Ollama-unreachable error handling,
    and `enableLLMChat`/`enableLLMStreaming` gating. Needs a mocked Ollama endpoint. Highest-value gap.
16. **i18n error-code completeness vs the source of truth.** `i18n.test.ts` compares catalogs against
    a hand-copied `SERVER_ERROR_CODES` snapshot, so it can't catch a *new* server code that ships
    untranslated. Move the canonical code list to `@loam/schema` (both server and client depend on
    it) and assert against it.
17. **Extract + test `app.tsx` logic.** The WS reducer (applies `messageCreated/Updated/Deleted`,
    `channelRemoved`, `configUpdated`, `wipe`, `presence`) and reconnect/backoff are untested; the
    pure helpers `messageConversationKey`, `conversationMessages`, `topLevelMessages`, `repliesFor`,
    `reactionSummary`, `bodyFor` are trivially extractable and drive what every screen renders.
18. **Markdown image-src XSS vectors.** `renderMarkdown` hardens `<a href>` explicitly but leaves
    `<img src>` from `![alt](url)` to DOMPurify alone; add tests for `![x](javascript:…)` and
    obfuscated schemes (`JaVaScRiPt:`, control chars).
19. **Client wipe-event reaction end-to-end** (WS `wipe` → `destroyDatabase` + localStorage/SW-cache
    purge + neutral screen); **avatar contrast multi-seed sweep** (≥4.5 on both surfaces);
    **QR multi-block interleave** golden matrix; **schema refinement** unit tests.
20. **Retention-reaper tests use real timers** (700 ms sleeps dominate the server suite). Convert to
    fake timers for determinism and speed.

## Architecture / tech debt

21. **`app.tsx` is ~5,400 lines.** Extract presentational components into `src/components/` with
    tests, highest ROI first: `AvatarImageEditor` (self-contained canvas/pointer logic),
    `MessageItem`, `MessageComposer`, `ChannelMembersPanel`, `Sidebar`, and the `AdminView` sub-panels.
22. **Dead code.** The `SERVER_URL_KEY` custom-server branch is read but never written (unreachable);
    `notifyIfHidden` never fires because `Notification.requestPermission()` is never called. Remove or
    wire each. Extract the duplicated base64-encode loop in `uploadAttachment`/`uploadAvatarImage`
    into a `blobToBase64` helper.

## Product / roadmap

23. Private-channel **join-request flow** (today invite-only); **ownership transfer** already landed.
24. **LoRa / alternate transports** — the node-to-node sync protocol (docs/11) is the transport layer
    a LoRa link would carry.
25. **Release signing** is scaffolded (`pnpm --filter app keystore` + config plugin); the follow-up is
    an actual device-tested signed release + a backed-up production keystore.
26. **In-app "Kill switch" → "Emergency Reset" rename.** The public marketing surfaces (site, README)
    were softened per the framing review, but the admin-panel UI labels still say "Kill switch". Rename
    the English values in `apps/client/src/i18n/en.ts` (`admin.killSwitch*`, `error.kill_switch_disabled`
    message text, the `profile*Summary`/`axesManaged`/`retentionNote` mentions, "arm"→"unlock",
    "firing"→"triggering") and carry the equivalent change across all 14 other catalogs. Keep the code
    identifiers (`killSwitch` config, `/api/panic`, `error.kill_switch_disabled` **code**, filenames)
    and the security docs unchanged — only display text.
27. **Opportunistic mesh / DTN delivery** (`docs/16`) — the committed next major initiative: carry a
    message from A to B via an intermediary C. Start at Phase 0 (`packages/crypto` identity primitive).
