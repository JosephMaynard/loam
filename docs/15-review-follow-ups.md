# 15 — Review follow-ups (next-phase backlog)

Output of a full four-area code review (server / client / packages+android / tests) plus a
dependency-alignment pass. The high-value, low-risk findings were **fixed in the same branch**
(shadow-ban REST leak, shadowBanned egress strip, panic fingerprinting, unbounded schema strings,
silent message sends, a pnpm catalog for version alignment, and assorted robustness). This file is
the **deferred** backlog — the items that are larger, riskier, or need hardware/product decisions —
ranked within each group. Each entry names the file and the concrete change.

## Security — do these before any hostile-environment deployment

1. **Sync import trusts peer-supplied `authorId` (impersonation).** `importPeerMessages`
   (`apps/server/src/app.ts`) accepts any `authorId`. The locally-**authoritative** guard has landed
   (`isLocallyAuthoritative` rejects an import colliding with a local admin/moderator/greeter). **Sol
   round-4 (2026-07-14) confirms the residual:** a collision with an ordinary **regular** local user is
   still accepted — transport auth proves which *node* sent the message, not which *user* authored it. So
   an authenticated peer can still make a message render as a regular local user. **Fixes:** per-author
   **signed authors** is the durable one (docs/11/16); a lighter interim is **namespacing remote identities
   by peer** (e.g. prefix imported author ids with the peer) so a remote author can never collide with a
   local id. Address **before real/sensitive-data multi-node use**.
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
4. ~~**"Wipe this device" can't revoke the server session.**~~ **RESOLVED** (`feat/deploy-hardening`):
   `POST /api/session/end` invalidates the caller's token server-side and clears the cookie
   (`Max-Age=0`); `purgeLocalData` calls it on a device wipe, so a reload mints a fresh identity
   instead of re-hydrating the wiped one. `markLocalStoreWiped()` latches the local store so a racing
   in-flight fetch's `putRecords`/`putRecord` can't re-create the DB after the wipe. Server + client tests.
5. ~~**Transport encryption (docs/08).**~~ **BUILT — Layer 1** (`feat/transport-encryption`):
   QR-bootstrapped app-layer session encryption on `@loam/crypto` (X25519 handshake — host-static +
   ephemeral, forward-secret; XChaCha20-Poly1305 framing). The server serves `POST
   /api/transport/handshake`, transparently decrypts request bodies / encrypts responses (global
   Fastify hooks) + seals WS frames, persists a host key (kill-switch-rotated), and enforces
   `required` mode; the client `transport.ts` handshakes off the QR `#k=` key (MITM-resistant),
   migrated all fetches + WS through it (off-mode = pure passthrough), with a fingerprint UX. Gated by
   `security.transportEncryption` (`off` default), now the axis that distinguishes the profiles
   (docs/09). **Layer-1 scope:** request/response BODIES + WS frames encrypted; GET paths/query
   strings + image bytes stay visible metadata (a full tunnel + image encryption are v2). Follow-ups:
   thread the `#k=` fragment through the remaining join-QR surfaces (InviteControl / Android
   host-panel / NodeLinkControl); live re-handshake on a runtime mode flip.
6. **On-device SQLCipher.** The Android DB is unencrypted at rest; needs a multiple-ciphers ABI-108
   android-arm64 prebuild (docs/01, docs/04).
6a. **Node-to-node sync now rides the transport channel — but inter-node MITM is TOFU by default.**
   **BUILT** (`feat/sync-transport-encryption`, `apps/server/src/sync-transport.ts` + `fetchPeerJson`):
   a pulling node establishes a transport session with each peer and seals its digest/messages/attachment
   requests with the `{ s, b, tok }` envelope (reconciled with the transport-hardening merge, so a
   `required` peer's replay window is satisfied), which also fixes the gap that a `required`-mode peer
   401'd every plaintext pull and so couldn't be synced from. Because auth-binding made user content
   tunnel-only, the sync routes are reached via a **direct sealed request** (`DIRECT_SEALED_SYNC_ROUTES`
   in `app.ts`) — still sealed, just exempt from the identity tunnel — and peer posture is read from the
   public `/api/bootstrap` (not the now-session-gated `/api/config`). The `sync.token` rides sealed INSIDE
   the envelope (never a wire header) over an encrypted channel, and attachments cross via
   `POST /api/sync/attachment` (base64 JSON, sealable) rather than the tunnel-only binary route. **Residual:**
   the peer's static key is learned over plain HTTP (not out-of-band like the browser's join QR), so this is
   passive-eavesdropper confidentiality + integrity, **not active-MITM resistance** between nodes unless the
   operator **pins** the key via the optional `SyncPeer.transportKey` (verified against the handshake,
   fail-closed on mismatch); unpinned = unauthenticated key discovery. Next: surface the pinned-key field in
   the admin peers UI (config-schema support already landed); longer-term, per-peer signed authors (item 1)
   for full peer authentication.

## Correctness / robustness

7. **Unbounded tombstone growth on ephemeral-retention nodes.** The reaper adds a tombstone per
   reaped message forever (`tombstones` Set + DB table), so a long-lived high-traffic ephemeral node
   grows without bound. **Note (do NOT gate tombstoning on `sync.enabled`):** an attempted fix that
   skipped tombstoning while sync was off was reverted — `sync` is a runtime toggle, so a node that
   deletes (e.g. a moderator delete) while sync is off and joins a mesh later would let a peer
   **resurrect** the deleted message (moderation bypass; falsifies docs/11's unconditional guarantee).
   The correct fix is a **horizon-based GC**: keep tombstoning unconditionally, stamp each tombstone,
   and age entries out beyond a horizon longer than any realistic sync window. That needs a
   `created_at` column on the `tombstones` table + a GC pass — a focused follow-up, not shipped here.
8. ~~**Switching bootstrap to `setupCode` via config PATCH is inert.**~~ **RESOLVED**
   (`feat/deploy-hardening`): a PATCH that transitions `admin.bootstrap` into `setupCode` now mints a
   single-use code (only on the transition, so a code consumed by an earlier claim isn't re-minted),
   flipping `allowAdminClaim` on. Test covers it.
9. ~~**Minor unbounded maps.**~~ **PARTIALLY RESOLVED** (`feat/deploy-hardening`): `peerSyncStatus` is
   now pruned to the active peer set on every config PATCH, so removing a peer drops its status.
   `attemptRateLimited`'s opportunistic >1000 prune is left as-is — genuinely bounded by LAN scale
   (a real >1000-distinct-active-IP case implies spoofing, which the LAN model already excludes).
10. **QR capacity ceiling can drop the WiFi QR.** The encoder maxes at version 6 / ECC level **H**
    (58 bytes); a `LocalOnlyHotspot` SSID plus a longer/escaped passphrase can exceed it, silently
    degrading Step-1 to plain text (`packages/qr`). Support a lower ECC level (L/M ≈ doubles capacity)
    for the WiFi payload path, or higher versions.
11. **Foreground-service wake lock has no timeout.** `LoamHostService.kt` acquires a
    `PARTIAL_WAKE_LOCK` with no bound; a `START_STICKY` restart after an OOM kill could pin the CPU
    indefinitely. Acquire with a bounded timeout and re-acquire, or add a hard cap.
12. ~~**Service worker is cache-first, not "network-first-ish" as documented.**~~ **RESOLVED**
    (`feat/deploy-hardening`): navigations/document requests are now **network-first** (fall back to
    the cached shell only when offline), immutable hashed assets stay cache-first; cache bumped to
    `loam-poc-v2` so the stale-shell cache is evicted on activate.

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

## Android host / APK readiness (Sol round-4 repo sweep, 2026-07-14)

A repository sweep during the transport-auth-binding review (Sol built + verified a debug APK — 568 tests,
all workspace builds, apps/app tsc, `pnpm audit --prod` clean, API 36 arm64-v8a, 16 KB-aligned; **fine for
a default-transport synthetic-data two-device smoke test as-is**). Fix these before the noted milestones.

**Before HARDENED-profile (required-mode) device testing:**
- **A1. Required transport can't bootstrap on Android.** The embedded WebView and the native sharing QR
  both use plain URLs with **no `#k=` transport key** (`apps/app/src/app/index.tsx:222`). So enabling
  `required` mode can lock the host's own UI out, and joining devices get a QR that must be rejected. Fetch
  the host transport public key over trusted loopback and append `#k=` to **both** URLs.
- **A2. Foreground hosting service can outlive the Node server.** `LoamHostService` is `START_STICKY` with
  an unbounded wake lock, but the React lifecycle never stops it (`LoamHostService.kt:38`) — after process
  death Android can recreate the service without restarting Node, leaving a "hosting" notification + wake
  lock for a dead server. Add an explicit stop lifecycle, a bounded wake lock, and likely
  `START_NOT_STICKY` (unless the service itself can restart Node).

**Before REAL / sensitive-data use:**
- **A3. Author authentication** — see item **1** (regular-user impersonation across authenticated peers).
- **A4. Android storage is plaintext.** The packaged host selects plain `better-sqlite3` with no DB key
  (`apps/app/nodejs-project-template/main.js:25`) — messages/sessions/identities/config are extractable on
  a rooted/compromised device. (On-device SQLCipher is item **6**; needs an ABI-108 multiple-ciphers
  android-arm64 prebuild.)
- **A5. Embedded Node 18.20.4 is EOL** (`apps/app/package.json:6`) — `pnpm audit` can't assess the bundled
  native runtime. OK for controlled LAN; public/hostile deployment needs a maintained runtime or an
  explicit security-backport plan (nodejs-mobile ceiling — see docs/01/04).

**Multi-device reliability (P2):**
- **A6. Transient attachment failures become permanent.** A message imports even if its attachment copy
  fails; later digests see it as already-synced, so the attachment is never re-requested — an
  attachment-only message can stay permanently empty (`apps/server/src/app.ts` `importPeerAttachments`).
  Persist a "missing attachment" work item and retry it independently of message import.
- **A7. Web-client invite URL can be stale after a hotspot start.** The server picks its LAN address once
  at startup, but the hotspot starts later (`apps/server/src/embedded.ts:79`); native sharing refreshes
  addresses, but a QR generated in the web UI may still advertise localhost / an earlier Wi-Fi address.
- **A8. Async embedded-startup failures don't reach the RN error UI.** The launcher catches synchronous
  `require()` failures, but a config/listen failure is a rejected promise after `require()` returns
  (`apps/server/src/embedded-main.ts:6`) — the process exits and the UI only shows a generic ~150 s
  timeout. Report the rejection over the bridge + offer a config reset/recovery path.
- **A9. Expo dependency matrix unsatisfied.** `expo-doctor` flags Gesture Handler 3.0 vs 2.32, TS 7 vs 6,
  and an incompatible `@expo/metro-runtime` patch (`apps/app/package.json:27`, `pnpm-workspace.yaml:17`);
  the APK compiles but device behaviour is harder to interpret until aligned. The committed `expo lint`
  also can't run in a clean checkout (no ESLint config/deps committed).
- **A10. Android 13+ requests precise location unnecessarily.** `with-loam-host.js:23` requests both
  `ACCESS_FINE_LOCATION` and `NEARBY_WIFI_DEVICES` while the UI says location is never requested. Restrict
  fine location to API ≤32 and use `neverForLocation` on Nearby Wi-Fi for API 33+.
