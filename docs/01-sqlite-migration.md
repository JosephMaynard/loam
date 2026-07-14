# 01 — SQLite migration

> **Status:** Phase A landed, **and encryption at rest is now implemented** (decision #1). The
> driver-agnostic `LoamStore` DAL (`apps/server/src/db.ts`) selects its backend at `openStore` time:
> `node:sqlite` by default (no encryption, no native dep), or **better-sqlite3-multiple-ciphers**
> (SQLCipher) when an `encryptionKey` is passed — lazy-`require`d so bare deployments never load the
> native module. Wired through `buildApp({ dbEncryptionKey })` from the `LOAM_DB_KEY` env var.
> Verified: the same DAL test suite passes against both drivers, the encrypted DB file leaks no
> plaintext and rejects the wrong key, and a live server booted with `LOAM_DB_KEY` writes an
> encrypted DB. **`LOAM_DB_KEY=ephemeral`** uses a random RAM-only key (never persisted), and the
> **kill switch now does a cryptographic wipe** (delete files + rotate key) — see docs/02.
> **Remaining:** passphrase key-derivation hardening, config/security-profile integration (docs/09),
> RAM key-zeroing, and encryption at rest **on-device** (needs a multiple-ciphers ABI-108 android
> prebuild). **Update (PR B):** the on-device *key handoff* is now wired — see
> ["On-device key handoff (Android host, PR B)"](#on-device-key-handoff-android-host-pr-b) below. RN
> (`apps/app/src/lib/db-encryption.ts`) resolves/generates the key per `security.dbEncryption` mode,
> stores it Keystore-backed (`expo-secure-store`), and hands it to the embedded launcher
> (`nodejs-project-template/main.js`) over a race-free request/response on the nodejs-mobile bridge;
> the launcher falls back to today's plaintext driver whenever no key comes back, and reports loudly
> (never silently or by crashing boot) if the SQLCipher native module isn't in the build. **This is
> wiring only** — the ABI-108 android-arm64 `better-sqlite3-multiple-ciphers` prebuild itself (the
> device seam below) is still unbuilt, so encrypted modes currently downgrade to plaintext on every
> real device build until that prebuild ships. Phase B (hot reads via SQL) deferred. **Update:** `openStore` now takes a
> `driver?: "node-sqlite" | "better-sqlite3"` option (threaded via `buildApp({ dbDriver })` ←
> `LOAM_DB_DRIVER`), and the plain (unencrypted) **better-sqlite3** driver on the digidem ABI-108
> android-arm64 prebuild now runs the **real server on-device** in the LOAM app (docs/04) —
> CREATE/INSERT/SELECT via the full REST API. `node:sqlite` stays the desktop/CI default and is now
> lazy-`require`d so the bundle never eagerly loads it on the device's Node 18.

## Goal

Replace the flat-JSON persistence with SQLite, behind a small data-access layer (DAL), without
changing the wire API. Gains: transactional durability (removes the 1-second data-loss window),
scalable message queries, and a foundation for the kill switch (drop/rekey a DB file) and admin config.

## Current state (what you're replacing)

All in `apps/server/src/server.ts`:

- **In-memory model**: `let data: AppData = { users, channels, messages }` plus `const sessions =
  new Map<token, userId>()`. Everything is loaded into memory at boot and mutated in place.
- **Load**: `loadData()` reads `.loam/{users,channels,messages,sessions}.json` via `readJsonArray()`,
  Zod-parses each row, seeds default channels/users, ensures the Ollama bot.
- **Persist**: `markDirty()` sets `dirty = true` and bumps `dataRev`. A `setInterval(…, 1000)` calls
  `saveAllData()`, which rewrites **all four JSON files** wholesale via `writeJson()`. Also flushed on
  `SIGINT`. This is the 1s window: crash between writes loses recent messages.
- **Config**: separate file `.loam/config.json`, read once by `loadAppConfig()` (see 03).
- **Avatars**: binary files in `.loam/avatars/` (`avt_<hex>.<ext>`), not in the store. Leave as files
  for now (simpler) or move to BLOBs later — not required for this migration.
- **Data dir**: `LOAM_DATA_DIR ?? <root>/.loam`. `.loam/` is gitignored.

Data shapes are all defined in `packages/schema` (`UserSchema`, `ChannelSchema`, `MessageSchema` —
a discriminated union on `type`). `SessionRecord = { token, userId }` is defined inline in the server.

## Driver options

| Option | Native build? | Encryption at rest | Notes |
|--------|---------------|--------------------|-------|
| **`node:sqlite`** (built-in) | None | No | Verified working on the repo's Node **24.13.1** (`DatabaseSync`, sync API, emits an ExperimentalWarning). Zero deps — powers the interim Phase-A DAL. **Verified ABSENT under nodejs-mobile** (Node 18.20.4) — cannot be the Android-host driver. |
| **better-sqlite3** family | Yes (prebuilt binaries for common targets; ABI-108 Android prebuilds proven by digidem) | Via **better-sqlite3-multiple-ciphers** (no OpenSSL) | Mature, fast, synchronous. **Chosen path** — see spike verdict below. |
| **libsql / @libsql/client** | Yes | Yes (encryption at rest) | **Ruled out**: ships no Android prebuilds (darwin/linux/win32 only); would need an unprecedented Rust cross-compile against Node 18 ABI 108. |

**Decision (settled): encryption at rest is REQUIRED** — see [decisions.md](decisions.md) #1. So
`node:sqlite` cannot be the final driver (no encryption).

**Spike verdict (2026-07-01) — the driver question is settled.** The nodejs-mobile spike (see 04)
found the embedded Android Node is **18.20.4 (ABI 108)**, where `node:sqlite` **does not exist**
(verified on-device: `ERR_UNKNOWN_BUILTIN_MODULE`; it needs Node ≥ 22.5). Outcomes:

- **Chosen: `better-sqlite3-multiple-ciphers`** (decision recorded; the dependency itself is not yet
  in the workspace manifests — it lands with the initiative-4 embedding work once the ABI-108
  prebuilds exist) — actively maintained (v12.11.1, June 2026), same synchronous API/build system as
  better-sqlite3, encryption via SQLite3MultipleCiphers (**no OpenSSL**; ChaCha20-Poly1305 default,
  SQLCipher-compatible mode). The Android path is proven by
  **`digidem/better-sqlite3-nodejs-mobile`**, which publishes plain better-sqlite3 prebuilds against
  ABI 108 for android-arm/arm64 (CoMapeo ships them in production) — and the phase-2 spike **ran
  that prebuild on-device in LOAM's own app** (CREATE/INSERT/SELECT OK). Its CI compiles the SQLite
  amalgamation directly, so swapping in the MultipleCiphers amalgamation is a contained change. The
  same driver runs on Pi/laptop via upstream prebuilds — one driver everywhere.
- **Fallback:** plain `better-sqlite3` (Android prebuilds exist today) + application-level encryption
  of row payloads/DB file. Note the fallback can **not** ride `node:sqlite` (absent on-device).
- **Ruled out:** `libsql` (no Android prebuilds at all — darwin/linux/win32 only) and
  `@journeyapps/sqlcipher` (async API; no public nodejs-mobile success story, one report of it
  silently not encrypting there).

Keep the DAL driver-agnostic so the swap (and the fallback) stay cheap. The encryption key
derivation/storage (passphrase, device keystore, or ephemeral) is its own sub-decision — for the
protest model an **ephemeral or passphrase-derived key that is never written to disk** makes the
kill switch a key-discard.

## Proposed shape

1. **Add a DAL module** (e.g. `apps/server/src/db.ts`) that owns the connection and exposes typed
   methods the routes call: `listUsers()`, `upsertUser()`, `listChannels()`, `messagesForChannel()`,
   `dmMessages()`, `insertMessage()`, `deleteMessage()`, `getSession()/putSession()`, `getConfig()/
   setConfig()`, and `wipeAll()` (for initiative 2). Keep Zod validation at this boundary.
2. **Schema (DDL)**: tables `users`, `channels`, `messages`, `sessions`, `config` (key/value or a single
   JSON row). Store message type-specific fields either as typed columns or a `json` payload column +
   indexed `type`, `channel_id`, `author_id`, `recipient_id`, `target_message_id`, `created_at`. Index
   the columns the current filters use (`channelMessages`, `dmMessages`, reaction lookups by
   `targetMessageId`).
3. **Migration path (two phases, low risk):**
   - **Phase A — swap the backend, keep the model.** Replace `readJsonArray`/`writeJson`/`saveAllData`
     with DAL calls but keep the existing in-memory arrays as a cache; on each mutation write through to
     SQLite in a transaction instead of debouncing. Behaviour identical, durability improved, `markDirty`
     and the 1s interval retire. Smallest diff, easy to verify.
   - **Phase B — push hot reads to SQL.** Convert `channelMessages()`/`dmMessages()`/reaction summaries
     to queries so the whole message history no longer lives in memory. Do this once message volume
     matters; not required for correctness.
4. **One-time importer**: if `.loam/*.json` exists and the DB is empty, import it, then rename the JSON
   files to `*.json.bak`. Preserves existing local data on upgrade.
5. **Retire**: `dirty`, `dataRev`, `saveInProgress`, `saveAllData`, the `setInterval`, `readJsonArray`,
   `writeJson`, `dataPath`. The `SIGINT` handler just closes the DB.

## Testing (landed with Phase A)

The first `apps/server` suite exists: `src/db.test.ts` covers the DAL against `:memory:`/temp-file DBs
(insert/list round-trips, all discriminated-union message variants, reaction toggle delete, session
persistence, transaction rollback, `wipeAll()`, and the JSON→SQLite importer), and `src/app.test.ts`
covers routes via `buildApp()` + `server.inject()`. The `test` script in `apps/server/package.json` is
picked up by CI (`pnpm test`).

## On-device key handoff (Android host, PR B)

`security.dbEncryption` (`off | ephemeral | persistent | passphrase`, `packages/schema`) is a
**declared posture** — a config axis an admin can set from the admin UI. On a laptop/Pi deployment
that's the whole story: `apps/server/src/server.ts` reads `LOAM_DB_KEY` straight from the environment
and hands it to `openStore()`. The Android host is different: the embedded Node process
(`nodejs-project-template/main.js`) has no access to the Android Keystore, so the key has to live in
the React Native process and be handed across the nodejs-mobile bridge at boot. This section documents
that handoff. **Status: the wiring is VERIFIED (typecheck + `node --check`, request/response logic
inspected end to end); actually running an encrypted DB on a physical device is a DEVICE SEAM — see
below.**

### The four modes

| Mode | Key material | Survives restart? | Where it lives |
|------|---------------|-------------------|-----------------|
| `off` | none | — | n/a — plaintext DB (today's default) |
| `ephemeral` | random 32-byte key, generated fresh **every launch** | No — see "ephemeral wipe" below | RAM only, for the life of one key-handoff round trip; never written to disk |
| `persistent` | random 32-byte key, generated **once** | Yes | `expo-secure-store` (Android Keystore-backed) |
| `passphrase` | SHA-256 of an operator-entered passphrase, hex-encoded | Yes | the passphrase itself lives in `expo-secure-store`; the derived key is recomputed each boot, never stored |

The passphrase KDF is deliberately simple (a single SHA-256 pass, no salt, no iteration count) — a v1
shortcut documented as such, not a hardened design. A proper scrypt/Argon2 derivation (matching the
approach used for `admin.passphrase`/`killSwitch.panicToken` server-side, see CLAUDE.md) is a follow-up
once the on-device crypto primitives for it are worth the dependency weight.

### The handoff protocol (race-free request/response)

`apps/app/src/lib/db-encryption.ts` (RN side) and `apps/app/nodejs-project-template/main.js` (embedded
launcher side) talk over the existing `nodejs.channel` bridge, mirroring the request/response idiom
`loam-model-set-active` already uses for the model manager:

1. **main.js REQUESTS.** Before `require('./loam-server.js')`, it registers a listener for
   `loam-db-key-response`, *then* posts `loam-db-key-request`. Registering before posting means there
   is no race against RN's answer, however fast — main.js never depends on RN having started listening
   first (RN's `registerDbEncryption` is registered once, at screen-mount, and just answers whatever
   request arrives).
2. **RN ANSWERS.** `registerDbEncryption`'s handler reads the persisted mode
   (`getDbEncryptionMode()`, default `'off'`), resolves/generates its key material
   (`resolveDbKey(mode)`), and posts `loam-db-key-response` with `{ mode, key? }` — `key` is a hex
   string, present only for the three encrypted modes (and only when a key could actually be
   produced — see the passphrase case below).
3. **main.js WAITS**, with a 5-second timeout. **The safe default is always "off":** if the mode is
   `off`, the wait times out, or no key comes back for *any* reason (old RN build, a thrown `post()`,
   a malformed payload), main.js falls through to **exactly today's behaviour** —
   `process.env.LOAM_DB_DRIVER = 'better-sqlite3'`, no `LOAM_DB_KEY`. Crisis messaging must always
   work; a stuck or missing key handoff can never block or crash boot.
4. **Encrypted-driver-availability guard.** When a key *is* present, main.js first checks
   `require.resolve('better-sqlite3-multiple-ciphers')` in a `try/catch` — that native module is **not
   shipped on-device yet** (only plain `better-sqlite3` is, via `fetch:native` — see docs/04). If it's
   missing, main.js does **not** set `LOAM_DB_KEY`; instead it calls the existing A8 boot-error bridge
   (`global.__loamReportBootError('Encrypted storage needs the SQLCipher native module, which isn't in
   this build yet — starting UNENCRYPTED.', 'db_encryption_unavailable')`) and falls back to the
   plaintext driver. This surfaces the downgrade **loudly** to the host screen instead of silently
   serving plaintext or throwing deep inside `openStore()`.
5. **Ephemeral wipe.** For `mode === 'ephemeral'`, main.js deletes any stale `loam.db`/`loam.db-wal`/
   `loam.db-shm` files in `dataDir` (best-effort, `ENOENT` ignored) *before* requiring the server —
   because the key is fresh every launch, a DB encrypted under a previous launch's key can never be
   opened again, so the old files would otherwise just make `openStore()` fail with a confusing
   "file is not a database" error.
6. If a key **is** set: `process.env.LOAM_DB_KEY = key`, and `LOAM_DB_DRIVER` is left unset —
   `openStore()`'s `encryptionKey` path takes precedence over the driver env var (see `db.ts`).

**The key never touches plaintext disk, and is never logged.** `resolveDbKey()`'s three encrypted
branches all end in `expo-secure-store` (Android Keystore) or pure RAM (`ephemeral`); no branch writes
key or passphrase material through `AsyncStorage`, a plain file, or `console.log`/`console.error`. The
mode *selection* itself (not secret) is stored the same way, in `expo-secure-store`, purely for
implementation simplicity (one storage primitive). main.js's own handling never logs `key` either — the
only thing it ever does with it is assign it to `process.env.LOAM_DB_KEY`.

### The picker UI

`apps/app/src/components/db-encryption-settings.tsx` (`DbEncryptionSettingsOverlay`, opened from an
"Encryption" button in the host bar next to "AI model"/"Share · Host") is a radio list of the four
modes with a one-line description each (including that ephemeral wipes on restart and persistent
survives reboots via the device Keystore), a passphrase entry field when `passphrase` is selected, and
a persistent note that **encrypted modes need a build that includes the SQLCipher native module and
take effect on the next app restart** — nodejs-mobile can't restart its runtime in-process (same
constraint the model manager's "Set active" already documents), so a mode change is picked up the next
time the operator (re)opens the host app. Selecting a mode calls `setDbEncryptionMode()` immediately;
nothing here ever calls the embedded server over HTTP (same "never fetch an authenticated route from
this process" rule the model manager follows, to avoid stealing the one-time `firstUser` admin grant).

### VERIFIED vs. DEVICE SEAM

**Verified:**
- Desktop/CI encryption at rest (`better-sqlite3-multiple-ciphers` via `openStore({ encryptionKey })`)
  — the existing DAL test suite (Phase A, above).
- The key-handoff wiring itself: `node --check` on `main.js`, `pnpm --filter app typecheck` on the RN
  side, and manual trace of the request/response/timeout/fallback logic (no physical device needed to
  reason about the control flow — it's plain JS/TS on both ends of an event-emitter bridge).

**Device seam (needs a physical arm64 device + the missing native module):**
- The `better-sqlite3-multiple-ciphers` ABI-108 android-arm64 prebuild does not exist yet — see the
  cross-compile recipe below. Until it ships, the availability guard in main.js means every encrypted
  mode silently (but *loudly reported*) downgrades to plaintext on a real device build.
- A live Keystore round trip for `persistent` mode (`expo-secure-store` write/read surviving an actual
  app restart) — the code path is the same one CoMapeo/comapeo-mobile use in production, but LOAM
  itself hasn't run it on hardware yet.
- `PRAGMA key`/rekey behaviour of the multiple-ciphers driver specifically under nodejs-mobile's Node
  18.20.4 (ABI 108) runtime, once the prebuild exists (docs/04's spike list, item 3).

### Cross-compile recipe: the missing `better-sqlite3-multiple-ciphers` ABI-108 android-arm64 prebuild

This mirrors how `apps/app/scripts/fetch-native-modules.mjs` fetches the **plain** `better-sqlite3`
prebuild from `digidem/better-sqlite3-nodejs-mobile` (pinned version + sha256, downloaded into
`node_modules/better-sqlite3/build/Release/`). The encrypted driver needs the equivalent artifact for
`better-sqlite3-multiple-ciphers`, which nobody currently publishes for Android/ABI 108:

1. **Fork the digidem build.** `digidem/better-sqlite3-nodejs-mobile` is a CI wrapper around
   `better-sqlite3` that cross-compiles it against nodejs-mobile's Node 18 headers using the Android
   NDK, producing `android-arm64`/`android-arm` `.node` binaries at ABI 108. Fork it (or replicate its
   CI config) as the starting point — it already solves the "nodejs-mobile headers + NDK toolchain"
   half of the problem.
2. **Swap the amalgamation.** Replace the plain SQLite amalgamation (`deps/sqlite3.c`/`.h`) the fork
   compiles with the **SQLite3MultipleCiphers** amalgamation (the `better-sqlite3-multiple-ciphers` npm
   package vendors it — copy `deps/` from that package instead of upstream `better-sqlite3`'s). No
   OpenSSL dependency (ChaCha20-Poly1305 default cipher, SQLCipher-compatible mode available) — this
   matters because OpenSSL cross-compiled for Android/NDK is its own can of worms; MultipleCiphers was
   chosen specifically to avoid it (see "Driver options" above).
3. **Point the NDK build at the same target the fork already uses**: `android-arm64`
   (`aarch64-linux-android`), API level matching the app's `minSdkVersion`, NDK r27+ (16KB page-size
   alignment, same requirement as the plain-driver build — see docs/04 prerequisites).
4. **Produce the `.node` artifact** the same way the fork does for plain better-sqlite3: a
   `better-sqlite3-<version>-node-108-android-arm64.tar.gz` containing a single
   `better_sqlite3.node` at the tarball root (matching the layout `fetch-native-modules.mjs` already
   expects and extracts).
5. **sha256-pin it and add it to `fetch-native-modules.mjs`**: add a second pinned
   `{VERSION, ASSET, URL, SHA256}` tuple (mirroring `BETTER_SQLITE3_VERSION`/`PREBUILD_SHA256`) for the
   multiple-ciphers artifact, fetched into a **separate** `node_modules/better-sqlite3-multiple-ciphers/
   build/Release/` (not overwriting the plain driver — `apps/server/src/db.ts` lazy-`require`s
   whichever one it actually needs, so both can be present in the bundle). Verify the tarball's sha256
   before extracting, exactly as the existing script does for the plain driver — never install an
   unverified native binary.
6. **Verify on-device**: repeat the phase-2 spike's CREATE/INSERT/SELECT proof (docs/04), then
   specifically exercise `PRAGMA key`/rekey (matching what the desktop DAL test suite already covers)
   to confirm the compiled cipher actually round-trips on ABI 108 hardware, not just that the module
   loads.

Once that prebuild exists and is wired into `fetch:native`, main.js's `require.resolve('better-
sqlite3-multiple-ciphers')` availability check (above) starts succeeding and encrypted modes take
effect for real, with no further changes needed to the key-handoff protocol itself.

## Open questions

- Encryption at rest? (drives the driver — see above and [decisions.md](decisions.md)).
- Keep avatars as files (recommended) or move to BLOBs?
- Phase B now or defer? (Recommend defer; land Phase A first.)
