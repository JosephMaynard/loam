# 02 — Kill switch (fast data wipe)

> **Status: landed.** `killSwitch: { enabled (default false), requireConfirmation (default true),
> panicToken? }` in the shared config schema; `POST /api/admin/kill-switch` (admin + enabled +
> `{ "confirm": "wipe" }` when confirmation is on) and unauthenticated `POST /api/panic` (404
> unless a token ≥16 chars is configured; rate-limited; the token is stored **scrypt-hashed**, so
> a seized node's config does not reveal it). The wipe empties all tables via the DAL's `wipeAll()`,
> deletes `avatars/` and `attachments/`, invalidates every session, broadcasts a `wipe` event, closes all sockets, and
> re-seeds defaults — config survives so the switch can fire again. Clients purge IndexedDB,
> localStorage, service worker + caches, and show a neutral "Disconnected" screen. Admin UI has a
> Safety panel with type-to-confirm arming. A client that was **offline** during the wipe (so missed the
> `wipe` event) purges its cache when it reconnects: it records the last server-confirmed identity
> (`loam.confirmedUserId`) and treats a different `currentUser` on its next boot as a reset. **Now with a cryptographic wipe when encryption at rest
> is on** (`LOAM_DB_KEY`): instead of a logical `DELETE`, the kill switch closes the store, deletes
> the DB files (`loam.db`/`-wal`/`-shm`), and — in `ephemeral` mode — rotates to a fresh random key,
> so any bytes still physically present on flash become unreadable. Every branch also removes the
> `.loam-recovery-*` snapshots a "start fresh" moves aside (an older DB set + plaintext media) and their
> anchor — fail-closed (lock-down, 503) in the encrypted branches, best-effort with a loud warning in the
> plaintext logical wipe. Reboot in `ephemeral` mode also
> loses the key permanently. Known limitation: Node strings can't be reliably zeroed in RAM, so a
> device seized *while running* remains the weak case (documented honestly). **Second known
> limitation (external review, 15 August 2026): uploaded media, avatar and attachment files, live OUTSIDE the
> encrypted DB as plaintext files, so the cryptographic wipe does not apply to them; the kill switch
> deletes the files, which on flash is best-effort removal, not secure erasure.** Media-at-rest
> encryption is tracked in `docs/29` (Track 2). Remaining (future): duress/decoy passphrase; RAM
> key-zeroing via a native buffer.
>
> **Failure handling.** Every in-process branch of the wipe runs under one guard: if a store call
> (`wipeAll()`, the reopen after the files are deleted, the reload) or the filesystem throws partway, the
> wipe is reported as **incomplete** exactly like a deletion that could not be verified: the `wipe` event is
> still broadcast so clients purge, sockets are closed, in-memory state is dropped, and the node stays
> locked (every route but `/api/health` answers 503) until it is restarted. Every branch, the plaintext
> logical wipe and the ephemeral key rotation included, writes the wipe journal (`.loam-wipe-phase`: the
> intent plus the sanitized config snapshot) before its first destructive step, so the next boot finishes an
> interrupted wipe (deletes the database files and media, restores the config, re-seeds) before anything is
> served and stays locked if that fails; only when the journal itself could not be written does a restart
> not finish the wipe, and the notice and the 503 body then say so: the body's `code` is `wipe_incomplete`
> (a restart finishes it) or `wipe_unrecorded` (restart, then run the reset again), and its `journaled`
> field carries the same fact for the launcher, which also gets it from the in-process host reset. The route
> answers 503, never a 500 that would leave the gate raised with nothing told to purge. The plaintext logical
> wipe checkpoints the write-ahead log into `loam.db` (`checkpoint()`, which syncs the file) right after
> `wipeAll()`: the store commits under `synchronous = NORMAL`, so without it a power cut after the journal is
> cleared could roll the deletion back with nothing left to finish it. A checkpoint that comes back busy or
> partial counts as a failed wipe, so the node stays locked with its journal on disk.
>
> **Durable writes on Windows.** The wipe journal and `config.json` are written to a staging file, flushed,
> renamed into place, and then the directory is flushed. Windows needs two changes to that recipe: the
> staging file is flushed through a handle opened for writing (FlushFileBuffers refuses a read-only one),
> and the directory flush is skipped, because Node has no way to flush a directory there and NTFS journals
> the rename itself. Before this, every durable write on a Windows `loamnet` host reported failure, so an
> Emergency Reset would have locked the node. The fix is covered by tests that emulate the Windows rules, but
> it has not yet been run on a real Windows machine (docs/25, O3).
>
> **Which branch a keyed node takes.** `persistent`/`passphrase` nodes take the journaled fixed-key wipe
> (delete, prove gone, journal, hand off or recreate); `ephemeral` nodes rotate their RAM key. A real key
> with no declared `LOAM_DB_ENCRYPTION_MODE` (the `loamnet --encrypt` CLI, a bare `LOAM_DB_KEY=<secret>`)
> is a fixed key, so both entry points (`server.ts`, `embedded.ts`) treat it as `passphrase` and it gets the
> journaled branch too; only the literal `LOAM_DB_KEY=ephemeral` is ephemeral.
>
> **Sync after a fixed-key reset.** The config a hooked fixed-key wipe carries across the launcher restart is
> written to plain files (`.loam-wipe-phase`, `config.json`), so the plaintext bearer `sync.token` is
> stripped from it. A node that synced *with* a token must not come back syncing *without* one (pulling
> unauthenticated, its own `/api/sync/*` open), so the same snapshot turns `sync.enabled` off; the next
> boot logs that sync was turned off by the reset and the operator sets a new token and turns it on again.
> A no-hook fixed-key wipe re-persists the full config (token included) into the fresh encrypted database,
> which wins over `config.json` on the next boot, so there sync stays as it was.

## Goal & threat model

A **config-gated, admin-triggered** action that deletes all LOAM data quickly. Primary threat model:
LOAM used at a protest under an oppressive regime, where a host device may be seized and must be
wiped fast. Secondary reality: many deployments (team-chat / open-Slack, long-running LLM servers) will
**not** want this — so it must be **off by default** and enabled explicitly in config. Keep it low-key
in the default UI (don't advertise heavily).

**Critical insight:** wiping only the server is not enough. Every connected client caches messages,
users, and channels in **IndexedDB** (`loam-poc` db) and identity in **localStorage**, plus the service
worker cache (`loam-poc-v1`). For the protest threat model, the kill switch must also tell connected
clients to purge their local copies. Server-only wipe leaves the conversation on every participant's
phone.

## Current state (what you'll touch)

- **No wipe/config API exists.** Routes are enumerated in `CLAUDE.md`; there is no admin/config/wipe
  endpoint yet.
- **Server data**: in-memory `data` + `sessions` + `.loam/*.json` (→ SQLite after initiative 1) +
  `.loam/avatars/` files. A wipe must clear all of these and re-seed defaults (default channels, seed
  users, Ollama bot) so the node is usable afterwards — or intentionally leave it empty.
- **Broadcast**: `broadcast(event)` fans a `ClientEvent` to sockets; the union is `messageCreated |
  messageUpdated | messageDeleted | userUpserted`. Add a new `wipe`/`purge` event here.
- **Client cache**: `apps/client/src/lib/local-store.ts` (IndexedDB `loam-poc`, stores
  `channels/messages/sync/users`); localStorage keys in `app.tsx`: `loam.currentUserId`,
  `loam.currentUserCreatedAt`, `loam.lastConversation`, `loam.serverUrl`; service worker cache
  `loam-poc-v1`. The client's WS handler (`parseSocketEvent` + `onmessage`) must learn the new event.

## Design

### Server
- **Config** (see 03): `killSwitch: { enabled: boolean; requireConfirmation: boolean; panicToken?: string }`,
  default `enabled: false`. Add to the config schema/loader.
- **`wipeAll()` in the DAL** (initiative 1): within one transaction, delete all rows from
  `messages`/`users`/`sessions` (and channels), then re-seed defaults. Delete the `avatars/` dir
  contents. With **encryption at rest**, the strongest wipe is to drop the encryption key and delete the
  DB file (data becomes unrecoverable even from disk forensics) — another reason encryption pairs with
  this feature (see [decisions.md](decisions.md)).
- **Endpoint**: `POST /api/admin/kill-switch`, guarded by `currentUser.isAdmin` **and**
  `killSwitch.enabled`. On success: run `wipeAll()`, invalidate all sessions, and `broadcast({ type:
  "wipe" })` before closing sockets.
- **Optional panic trigger**: an unauthenticated `POST /api/panic` accepting a pre-shared `panicToken`
  (from config), so a wipe can be fired fast (bookmark/NFC/second device) without navigating the admin
  UI during a raid. Off unless a token is configured. Rate-limit and constant-time compare the token.

### Client
- Handle the `wipe` WS event: clear IndexedDB (delete the `loam-poc` database), remove the localStorage
  keys, unregister the service worker + `caches.delete('loam-poc-v1')`, drop in-memory state, and show a
  neutral "disconnected" screen (avoid a scary banner that signals what happened).
- The admin who triggers it gets the same purge locally.

### Data-at-rest caveat (document honestly)
SQLite leaves data in the main DB file, `-wal`, and `-journal`, and deleted rows/files may be
recoverable by forensic tools on flash storage. A `DELETE FROM` is **not** secure erasure. The robust
answer is **encryption at rest** (SQLCipher/libsql) where the wipe throws away the key. If encryption is
out of scope, note the limitation in user-facing docs rather than overpromising.

## UX decisions (confirm with owner — see [decisions.md](decisions.md))
- **Speed vs. accident-prevention**: a raid wants one tap; normal ops want a confirm. Recommendation:
  config `requireConfirmation` (default true for team use), and a fast path (hold-to-fire or panic
  token) for protest deployments.
- **Remote-wipe connected clients?** Strong recommendation: **yes** — it's the point of the feature.
- **Duress/decoy** (a second passphrase that wipes instead of unlocking) — possible later; note as future.

## Testing
- DAL `wipeAll()` empties all tables and re-seeds (or leaves empty) as specified.
- Endpoint auth matrix: non-admin → 403; admin with `enabled:false` → 403/404; admin with `enabled:true`
  → wipes + broadcasts.
- Client reducer for the `wipe` event clears IndexedDB/localStorage/caches (jsdom test).
- Panic-token compare rejects wrong/absent tokens.

## Depends on
- Initiative 1 (`wipeAll()` DAL method, transactional store).
- Initiative 3 (admin auth + config editing to toggle `killSwitch.enabled` and trigger it from the UI).
