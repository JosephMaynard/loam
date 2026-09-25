# Changelog

All notable changes to LOAM are recorded here. LOAM is a local-first, off-grid messaging app (see
`README.md` and `MISSION.md`). Format loosely follows [Keep a Changelog](https://keepachangelog.com);
the project is pre-1.0, so the surface can still change. Dates are UTC.

## [Unreleased]

The pre-release review release: fixes from two full-codebase reviews (2026-09-04, 2026-09-25) and an
external one (2026-08-15), the server split, and Play Store groundwork. Will ship as 0.5.0.

### Security
- **Key pinning is fail-closed.** A QR-joined client can no longer fall back to plaintext on an
  `optional` node when its handshake fails, and refuses plaintext fetches/sockets outright. A node whose
  key changed (Emergency Reset, stale poster) shows a "scan the current join QR" gate instead of looping.
  A join link carrying a *different* key now asks first, showing both fingerprints, instead of quietly
  replacing the pin. On a pinned session the client refuses an unsealed tunnel reply (an on-path attacker
  could otherwise forge one, e.g. a mesh contact card). The invite QR a client shows carries the node key
  only from its own QR-verified session, and join-key fragments are stripped from links in messages.
- **Plaintext transport can't be configured any more.** `security.transportEncryption: "off"` is refused
  by the admin API; an `off` left in `config.json` or the database is read as `optional`, with a warning.
  Developer Mode (`LOAM_DEV_MODE`, never in production) is the only plaintext path.
- **Encrypted databases fail closed.** If the SQLCipher driver won't load, an encrypted Android node now
  stops on a lock screen (Retry, or a confirmed "Start without encryption") instead of silently running on
  plaintext SQLite; the `loam` CLI checks the driver before it starts, and the server locks with the same
  error when a keyed open fails for lack of the driver. After every keyed open the server refuses a
  database file that is still plaintext, and a keyed open that fails on a new node no longer leaves a
  plaintext file behind.
- **CLI passphrases stay out of `ps` and shell history.** Bare `loam --encrypt` takes `$LOAM_DB_KEY` or
  prompts without echo; `--encrypt <passphrase>` still works but warns.
- **Android host.** The host phone's own screen claims admin with a per-boot token (`hostDevice`), so no
  LAN device can take the first-user admin grant while the node boots. Passphrase mode asks for the
  passphrase at every start and never stores it. Android 12+ device-to-device transfer no longer copies
  the database, media or config to a new phone. The loopback mesh bridge requires the launcher's token on
  every host (a desktop/Pi node has no bridge).
- **Logs don't undo the tunnel.** Requests re-dispatched inside the encrypted tunnel are no longer
  request-logged (that printed the hidden path and query), and query strings are stripped from every
  logged URL. Unexpected server errors return a generic body; details go to the log only.
- **Server hardening.** Uploaded avatar ids are validated (a crafted id could reach outside the avatar
  directory); the assistant bot id must be an `llm.*` id and can't be pointed at a person's account;
  record ids are capped at 128 characters; session ids are longer (64-bit, minted collision-free) and
  session tokens 256-bit; admin-claim and panic attempt limits also count requests made through the
  tunnel; inbound WebSocket frames are capped at 16 KiB.
- **Node-to-node sync.** A peer can no longer edit a post a local user wrote, re-type a private message
  into a public channel, bind a local or pending attachment to its own message, undo a moderator's
  removal, or add new replies or reactions under a post a moderator removed here. Only the authors of accepted messages are imported, and mesh or assistant ids are refused. The
  sync token is never sent on a plaintext pull, a `required` node refuses plaintext pulls, and a peer that
  negotiated encryption is never silently downgraded.
- **Mesh.** Replay protection keys on the sealed content (ciphertext, routing tag and expiry), only the
  canonical encoding is accepted, and a forged hop budget or metadata can no longer shadow genuine mail.
  A node now fetches every eligible sealed offer rather than only its own mail, so the serving peer can't
  learn which node a recipient uses (docs/16 states the remaining leak). Mesh identities are only minted
  for local users, and rows an older build minted for synced users are deleted at boot.
- **Emergency Reset.** An upload landing mid-reset can no longer restore the pre-reset user or leave a
  file behind; start-fresh recovery snapshots are swept too; an assistant reply streaming across a reset
  is abandoned; a device that was offline during the reset clears its local copy when it next connects.
  On a fixed-key node without the Android launcher, the full config is re-persisted after the reset.
- **One content-mutation policy** (from the external review): removed private-channel members, timed-out
  users, archived channels and posting-policy lockdowns can no longer be bypassed through edit, delete or
  reaction paths; moderator timeouts also cover channel creation, metadata edits, roster growth, profile
  edits, avatar uploads and mesh sends; rate limits apply inside the encrypted tunnel. `SECURITY.md`
  corrected.

### Fixed
- **Dead connections are noticed.** The server sends a heartbeat on every WebSocket; a client that stops
  hearing it reconnects, and re-checks when the device comes back online or the page becomes visible.
- **Android keeps hosting with the screen off**: the foreground service is re-asserted whenever the app
  returns to the foreground (a start from the background can be refused), and the notification permission
  is requested so the "LOAM is hosting" notice shows on Android 13+. A system-stopped hotspot (tethering,
  Wi-Fi toggle) is reflected on the share screen and restarts on reopen.
- Drafts, pending attachments, report dialogs and scroll position no longer follow you into the next
  conversation, and a report dialog stays bound to the user it was opened for.
- A message deleted or edited while its conversation was loading is no longer resurrected or reverted;
  unread markers use the server's timestamps rather than the device clock.
- Moderator timeouts are a duration applied on the node's clock (capped at 7 days), so a moderator's
  device clock can't set a years-long or already-expired timeout.
- A message removed by a moderator can't be edited by its author or take new replies or reactions.
- Assistant: a reply interrupted by a crash is finalized on restart, a moderator removal stops a reply
  mid-stream, replies are limited to one per user and two at a time per node, and an admin save no
  longer freezes the Android host's model switching. An admin's own on-device model change is saved to
  `config.json` when that file holds the on-device settings (the Android host, or any node after an
  Emergency Reset), so a restart no longer undoes it.
- Claiming admin on a node that requires join approval now leaves the claimer approved.
- The orphaned-attachment sweep can no longer delete a file an in-flight upload is about to use.
- Non-image files sync between nodes over encrypted sync, up to the 1 MiB file limit.
- The legacy demo users (`user.1234`/`user.5678`) and their messages are removed from older databases.
- Android: overlapping encryption/model requests to the embedded server no longer time each other out.
- Android build: the plain SQLite driver is now vendored in the repo, after an upstream re-upload broke
  the pinned download.
- Large encrypted requests (up to 4 MiB) no longer block the server for tens of milliseconds while being
  decoded.
- Earlier review fixes: a transparent re-handshake closes the socket sealed under the old key; a wipe also
  forgets the cached node key, image URLs and rendered-message cache; a non-member editing a private
  channel gets the same 404 as elsewhere; sync honours a channel's posting policy and the node's flags;
  typing signals respect posting policy; sealed mail is dropped when DMs are off; unreferenced avatars are
  cleaned up at boot; the `npx loamnet` join QR carries the node key; the 1 MB attachment limit is
  actually reachable.
- Search rejects a malformed query with a 400; a malformed link no longer crashes routing.
- Sync: offers refused under an old policy are fetched again right after an admin config save or a change
  to a channel's archived, posting or replies setting, instead of up to an hour later.
- `loam --encrypt`: an empty passphrase for an existing database is refused (it used to pick an ephemeral
  key that can never open it), a pasted passphrase and confirmation are no longer cut at the first line,
  and the missing-driver message says to reinstall `loamnet` rather than install the driver globally,
  where `loam` never looks.
- Android: the "Start without encryption" confirmation no longer tells an ephemeral-mode host that its old
  database stays on disk; it was already deleted.
- The Play listing no longer hides from landscape-only devices such as Chromebooks: the portrait screen is
  declared optional.
- An Emergency Reset journal whose saved config predates this release (`off` transport, an old bot id) is
  repaired like `config.json` instead of locking the node as corrupt, and a repaired stored config is
  written back once, so its warning doesn't repeat every boot.
- A node upgraded from 0.4 boots even when its database or `config.json` holds values past the new
  bounds: a stored user, channel or message with an id over 128 characters is skipped (logged, left on
  disk), and an assistant model label over 120 characters is truncated.

### Added
- **Blocking.** Block someone from their DM header; unblock there or in Settings. Blocking stops DMs, DM
  reactions and typing both ways and hides the person's channel posts, replies and reactions on your
  device. They aren't told: a DM to someone who blocked them gets the same "not available" answer as one to
  a banned member. The list is private to you, never synced, and cleared by Emergency Reset.
- **Privacy policy** at [loamnet.com/privacy](https://loamnet.com/privacy), linked from the site footer,
  the client's Settings and the Android host menu.
- **Report this user** from a DM's header.
- Channel **Delete** (permanent, with its messages, reactions and files; sync never re-imports it).
- A download confirmation for on-device models, stating the size and warning about mobile or metered
  data.
- A dismissible error notice at the top of the screen, a "conversation not available" state, and a
  recoverable crash screen.
- `pnpm --filter app aab` builds an Android App Bundle for Google Play, and tag builds in CI produce it as
  the `loam-host-aab` workflow artifact (not attached to the Release); a themed (monochrome) app icon.
- Every one of the 14 non-English locales now covers every string, with a test that keeps it that way
  (machine-translated, pending native review).
- CI checks that all package versions agree; tag builds also check the tag and that `versionCode` is above
  every earlier release tag's. `vX.Y.Z-rc.N` and `vX.Y.Z-beta.N` tags build like releases (keystore, tests,
  the AAB) and are published as GitHub pre-releases. A stale generated Android project now fails the build
  instead of shipping old settings.

### Changed
- **Archived channels are read-only but visible** (readable, searchable, listed with a badge; composing,
  actions and roster growth frozen). See the upgrade notes.
- Release signing: `pnpm --filter app aab` refuses to build without a release keystore, and a
  debug-signed APK build warns unless acknowledged with `--debug-signed`. CI actions are pinned to commit
  SHAs (Dependabot bumps them weekly), and the job that publishes releases is separate from the build.
- **DMs to banned or not-yet-approved members are refused** (`dm_unavailable`). They used to be accepted.
  It's the same answer a blocked sender gets, so it doesn't reveal a block.
- Android: Wi-Fi, location and Bluetooth are declared optional hardware (so Play doesn't filter out
  tablets and Chromebooks); unused template permissions are blocked; incoming `loam://` links only ever
  open the host screen.
- The server's 9.4k-line `app.ts` is split into a ~2k-line core and sibling modules (no behaviour change).
- README and the site no longer claim an installable offline app on the plain-`http` hotspot path.
- Dependencies: Vitest 5, Fastify 5.12, Zod 4.6, Vite 8.3, DOMPurify 3.4.15, and other minor updates.

### Upgrade notes
- Channels archived under the old semantics were *hidden*; they now reappear for their audience as
  read-only (archive was never an access control, but it was a visibility control). Use **Delete** for
  gone-for-good. Archiving no longer purges members' local caches; Delete does.
- A `config.json` with `"transportEncryption": "off"` now boots as `optional`; set `LOAM_DEV_MODE=1` (not
  in production) if you need plaintext for debugging.
- Existing session ids keep working; new ones are `user.` + 16 hex characters.

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
