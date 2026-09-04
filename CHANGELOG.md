# Changelog

All notable changes to LOAM are recorded here. LOAM is a local-first, off-grid messaging app (see
`README.md` and `MISSION.md`). Format loosely follows [Keep a Changelog](https://keepachangelog.com);
the project is pre-1.0, so the surface can still change. Dates are UTC.

## [Unreleased]

- **Review fixes (2026-09-04 full-codebase review).** Client: a QR-joined client can no longer fall back
  to plaintext on an `optional` node when its handshake fails (the decision now comes from the transport
  layer's QR-pinned effective mode, not the unauthenticated advertisement); a node whose transport key
  changed (Emergency Reset, stale poster) marks the pinned key broken and shows a "scan the current join
  QR" gate instead of looping on a doomed resume — the pin is kept (never replaced by an advertised key)
  and only a fresh scan clears it, and a pinned client refuses plaintext fetches/sockets outright; a transparent re-handshake closes the socket sealed under the old
  key; a wipe also forgets the cached host key, revokes decrypted image `blob:` URLs and clears the
  rendered-markdown cache; a live transport-mode flip re-runs session setup. Server: WebSocket inbound
  frames capped at 16 KiB (was the 100 MiB library default, buffered even on pre-auth sockets); a
  non-member's PATCH on a private channel answers 404 like every sibling route; sync import honours a
  locally-authoritative channel's posting policy and the node's channel/reply/reaction flags; typing
  signals respect the posting policy; sealed mesh mail is dropped (and tombstoned) when DMs are off; avatar
  files no user references are reaped at boot. Android host: **`hostDevice` admin bootstrap** — the
  launcher mints a per-boot host token and the host's own WebView claims admin with it, so no LAN session
  can take `firstUser` in the boot window; the loopback mesh bridge requires the same token;
  **passphrase mode asks for the passphrase at every start and never stores it** (a legacy stored copy is
  retired only once the server confirms the database opened under it — never on a discarded attempt; the
  unreadable-DB recovery screen offers "enter it again" for a typo, and "start fresh" re-asks for the
  passphrase so a fresh database is never keyed by a mistyped one; the host's own admin claim is honoured
  ahead of the per-IP attempt limiter and retried on later passes; after a node wipe the host screen
  rejoins under the new key and re-claims admin without an app restart); a
  system-stopped hotspot (tethering, Wi-Fi toggle) is reflected in the share screen and restarts on reopen;
  ephemeral mode removes avatars/attachments with the database; the native SQLite wrappers' transitive
  deps are pinned. `docs/21` gains host-claim and system-stopped-hotspot checks.
- **Server split.** `apps/server/src/app.ts` (9.4k lines) is now a ~2k-line composition root + domain
  core; the transport layer, realtime, kill switch, store lifecycle, sync, mesh, LLM and per-domain
  routes are sibling modules over one `AppContext` (CLAUDE.md "Server architecture"). No behaviour change.
- README and the site no longer claim an installable offline PWA on the plain-http hotspot path (a
  hotspot address is not a browser secure context); the copy now says what joiners actually get.
- **Pre-tester hardening** (from an external full-codebase review, 2026-08-15, plus a three-agent
  adversarial pass over the fixes): one shared content-mutation policy — removed private-channel
  members, timed-out users, archived channels, and post-hoc posting-policy lockdowns can no longer
  be bypassed via edit, delete, or **reaction** paths; archive is now uniformly **read-only but
  available** (readable, searchable, listed with a badge; composer/actions disabled; roster growth
  — invite/transfer/join-request-approval — frozen); channels gain a first-class **permanent
  delete** (cascade incl. reactions + attachment files, sync tombstone, join-request cleanup,
  slug never reused, survives restarts — and a non-admin owner cannot delete a channel holding
  other people's messages); moderator timeouts also cover channel creation, metadata edits, and
  roster growth (invite/transfer/approval — shrinking access stays available) and profile edits
  (join *requests* deliberately stay open — they publish nothing and grant nothing unapproved);
  switching DMs or replies off blocks edits of pre-shutdown messages (deletion stays, as cleanup); the `npx loamnet` join QR carries the `#k=` transport key (and the QR
  encoder auto-degrades EC level so keyed URLs actually render — this also silently broke the
  browser invite QR); the 1 MB attachment limit is actually reachable (per-route body ceilings on
  the upload + tunnel paths only); semantic rate limits apply inside the encrypted tunnel across
  uploads, mesh, sync, and search (image *reads* got higher caps so `required`-mode clients don't
  starve); avatar uploads and mesh sends respect moderator timeouts; SECURITY.md corrected.
- **Upgrade notes:** channels archived under the old semantics were *hidden*; after this release
  they reappear for their audience as read-only (archive was never an access control — direct
  reads always worked — but it *was* a visibility control; use **Delete** for gone-for-good).
  Archiving also no longer purges members' local caches — **Delete is the purge lever** now. PR #122 review follow-ups: an Emergency Reset on a fixed-key node without the launcher hook now
  re-persists the FULL config (sync token included) into the fresh encrypted DB row, matching the ephemeral
  branch (the plaintext `config.json` copy stays sanitized); the Android passphrase entry is tried before a
  legacy stored passphrase so a pre-change install can change it (the legacy value is retired only on the
  server's confirmed-open ack); a key scanned this session always wins over a stale stored pin; a failed
  sealed resume also closes the socket sealed under the old key; the Android wipe handler re-gates the
  WebView before re-bootstrapping; per-route rate limits are inline literals so CodeQL can see them.

## [0.4.0] - 2026-08-08

The device-feedback release, and the first version published to npm as
[`loamnet`](https://www.npmjs.com/package/loamnet) (`npx loamnet` runs a node on a laptop/Pi). All
workspace versions aligned to 0.4.0 (Android `versionCode` 6).

### Fixed
- **Hotspot join QR pointed at an unreachable address** on phones with STA+AP concurrency (host on
  home WiFi *and* hotspot): the join URL now targets the hotspot gateway (`192.168.49.1`) while the
  LocalOnlyHotspot is running, and the real LAN address otherwise (`apps/app/src/lib/join-url.ts`).
- Settings screen: profile-edit controls now render only when the node allows them (no more
  greyed-out "disabled" noise); the "Open the admin area" button no longer renders as a one-word-
  per-line column.
- `docs/21` corrected: passphrase change is delete-and-start-fresh; in-place rekey is unbuilt.

### Changed
- Delivered the `docs/27` "PR 1" completeness arc (#109/#110): moderation **report loop** (private
  reports → mod queue → dismiss/delete/timeout/ban/escalate, honest tombstones, composer countdown),
  channel-metadata re-sync with per-peer provenance, general **@mentions**, per-channel retention
  TTL, lock/pin channels, **typing indicators**, private-channel **join requests**, non-image **file
  attachments** (1 MB), pinned-peer-key admin field, i18n en-fallback.
- Dependencies: jsdom 30, js-sha256 1.0, Node pin 24.15.0.

## [0.3.0] - 2026-07-31

Everything landed on `master` since 0.1.0 — 0.2.0 was an interim device-test build, and **0.3.0 is the
first release-signed build** (CI signs and attaches the APK to each tagged release). Verified on a
physical phone this cycle: the on-device LLM works, encryption persists, and the earlier crashes are
fixed. Also added an LLM DM-context bound, a 256KB sync-import body cap, and a docs / README / site
accuracy pass. The detail below is the full arc since 0.1.0.

### Security & privacy
- **Transport encryption (docs/08) — QR-bootstrapped app-layer session encryption over plain HTTP.**
  X25519 handshake (host static + ephemeral, forward-secret) + XChaCha20-Poly1305, keyed by the join
  QR's `#k=` fragment (out-of-band, MITM-resistant). Modes `off` / `optional` / `required`; the axis
  that now distinguishes the `open`/`standard`/`hardened` security profiles. A QR-pinned join can't be
  downgraded to plaintext by a tampered `/api/config`.
- **Transport v2 hardening** _(in review at 0.3.0; since shipped)_: per-session **anti-replay** (DTLS-style sliding
  window), a **path-hiding tunnel** in `required` mode (every request → opaque `POST
  /api/transport/tunnel`, so paths/queries/response bodies are all ciphertext), and **image
  encryption** (avatars/attachments fetched through the tunnel into `blob:` URLs). Reviewer's guide in
  `docs/18`.
- **Node-to-node sync transport encryption** _(in progress at 0.3.0; since shipped)_ — encrypts the pull-based sync channel and
  fixes a `required`-mode sync gap.
- At-rest SQLCipher encryption, kill switch / panic token, ephemeral message retention, per-IP
  anonymous-identity budget, shadow-ban / roles egress hardening, and bounded rate-limit maps.

### Messaging
- Public + **private channels** (membership, ownership transfer, targeted removal), threads, DMs,
  reactions, **image attachments**, message **search**, **location sharing** (opt-in, `geo:` link),
  and an optional local **LLM** (Ollama / on-device) chat contact.
- **Opportunistic mesh / DTN** (docs/16): sealed-sender `@loam/crypto`, self-certifying `mesh.` ids,
  contact-based secure addressing, bounded relay, group/broadcast fan-out. **Phase 3** native
  BLE/Wi-Fi-Aware transport _(in review at 0.3.0; since merged — still needs radio verification)_.

### Apps & platform
- Installable **Preact PWA** client; **Fastify** server (SQLite DAL, REST + WebSocket).
- **Android host app** (Expo): embedded Node server, `LocalOnlyHotspot`, QR join, background
  foreground-service hosting, kiosk mode, one-command APK build, release-signing scaffold.
- **i18n** across 15 locales; node-to-node **sync** (public data only, tombstones, optional bearer
  token); node **presence**; admin **security profiles**, moderation, and join-approval.

### Internal / quality
- `app.tsx` modularized from ~6100 → ~3300 lines: message render helpers → `lib/messages`, and
  `Avatar*`/`MessageComposer`/`MessageItem`/`Sidebar`/`ChannelMembersPanel`/`AdminView` (+ sub-panels)
  → `src/components/` with tests _(the AdminView split was in review at 0.3.0; since merged)_.
- O(N·M) → O(M) conversation render; cached Intl formatters + per-message markdown; in-order message
  merge. Deterministic crypto tamper test. Expanded package/server test coverage.
- User-facing copy softened from thriller/espionage framing toward calm utility language ("Kill
  switch" → "Emergency Reset" in the UI; code identifiers unchanged).

## [0.1.0] — pre-1.0 baseline

The first cohesive feature set: SQLite persistence behind a DAL, the `buildApp()` server factory with
admin bootstrap + config API, kill switch, ephemeral messages, the PWA client + test harness, the
Android host (embedded server + hotspot + QR join), at-rest encryption, private channels, search,
attachments, node-to-node sync, presence, roles/moderation, security profiles, and the mesh/DTN
foundation. See the git history and `docs/` for the full initiative-by-initiative record.
