# 01 — SQLite migration

> **Status:** Phase A landed — `node:sqlite` behind the driver-agnostic `LoamStore` DAL
> (`apps/server/src/db.ts`), write-through mutations, one-time JSON importer, and the first
> `apps/server` test suite. The nodejs-mobile spike (2026-07-01) settled the encrypted driver:
> **better-sqlite3-multiple-ciphers** (see below); swap it in behind `LoamStore` once Android
> ABI-108 prebuilds exist. Phase B (hot reads via SQL) deferred as recommended.

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

- **Chosen: `better-sqlite3-multiple-ciphers`** — actively maintained (v12.11.1, June 2026), same
  synchronous API/build system as better-sqlite3, encryption via SQLite3MultipleCiphers (**no
  OpenSSL**; ChaCha20-Poly1305 default, SQLCipher-compatible mode). The Android path is proven by
  **`digidem/better-sqlite3-nodejs-mobile`**, which publishes plain better-sqlite3 prebuilds against
  ABI 108 for android-arm/arm64 (CoMapeo ships them in production); its CI compiles the SQLite
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

## Testing (new — there are currently no server tests)

This is the natural place to introduce the first `apps/server` test suite (Vitest). Test the DAL against
a `:memory:` (or temp-file) DB: insert/list round-trips, the discriminated-union message variants,
reaction toggle delete, DM audience filtering, session persistence, and the JSON→SQLite importer. Add a
`test` script to `apps/server/package.json` so CI (`pnpm test`) picks it up.

## Open questions

- Encryption at rest? (drives the driver — see above and [decisions.md](decisions.md)).
- Keep avatars as files (recommended) or move to BLOBs?
- Phase B now or defer? (Recommend defer; land Phase A first.)
