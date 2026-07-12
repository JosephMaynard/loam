# Changelog

All notable changes to LOAM are recorded here. LOAM is a local-first, off-grid messaging app (see
`README.md` and `MISSION.md`). Format loosely follows [Keep a Changelog](https://keepachangelog.com);
the project is pre-1.0, so the surface can still change. Dates are UTC.

## [Unreleased]

Work landed on `master` since 0.1.0, plus items in review.

### Security & privacy
- **Transport encryption (docs/08) — QR-bootstrapped app-layer session encryption over plain HTTP.**
  X25519 handshake (host static + ephemeral, forward-secret) + XChaCha20-Poly1305, keyed by the join
  QR's `#k=` fragment (out-of-band, MITM-resistant). Modes `off` / `optional` / `required`; the axis
  that now distinguishes the `open`/`standard`/`hardened` security profiles. A QR-pinned join can't be
  downgraded to plaintext by a tampered `/api/config`.
- **Transport v2 hardening** _(in review, #75)_: per-session **anti-replay** (DTLS-style sliding
  window), a **path-hiding tunnel** in `required` mode (every request → opaque `POST
  /api/transport/tunnel`, so paths/queries/response bodies are all ciphertext), and **image
  encryption** (avatars/attachments fetched through the tunnel into `blob:` URLs). Reviewer's guide in
  `docs/18`.
- **Node-to-node sync transport encryption** _(in progress)_ — encrypts the pull-based sync channel and
  fixes a `required`-mode sync gap.
- At-rest SQLCipher encryption, kill switch / panic token, ephemeral message retention, per-IP
  anonymous-identity budget, shadow-ban / roles egress hardening, and bounded rate-limit maps.

### Messaging
- Public + **private channels** (membership, ownership transfer, targeted removal), threads, DMs,
  reactions, **image attachments**, message **search**, **location sharing** (opt-in, `geo:` link),
  and an optional local **LLM** (Ollama / on-device) chat contact.
- **Opportunistic mesh / DTN** (docs/16): sealed-sender `@loam/crypto`, self-certifying `mesh.` ids,
  contact-based secure addressing, bounded relay, group/broadcast fan-out. **Phase 3** native
  BLE/Wi-Fi-Aware transport _(in review, #77 — needs a physical-device test)_.

### Apps & platform
- Installable **Preact PWA** client; **Fastify** server (SQLite DAL, REST + WebSocket).
- **Android host app** (Expo): embedded Node server, `LocalOnlyHotspot`, QR join, background
  foreground-service hosting, kiosk mode, one-command APK build, release-signing scaffold.
- **i18n** across 15 locales; node-to-node **sync** (public data only, tombstones, optional bearer
  token); node **presence**; admin **security profiles**, moderation, and join-approval.

### Internal / quality
- `app.tsx` modularized from ~6100 → ~3300 lines: message render helpers → `lib/messages`, and
  `Avatar*`/`MessageComposer`/`MessageItem`/`Sidebar`/`ChannelMembersPanel`/`AdminView` (+ sub-panels)
  → `src/components/` with tests _(the AdminView split is in review, #81)_.
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
