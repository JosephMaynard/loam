# 02 — Kill switch (fast data wipe)

> **Status: landed.** `killSwitch: { enabled (default false), requireConfirmation (default true),
> panicToken? }` in the shared config schema; `POST /api/admin/kill-switch` (admin + enabled +
> `{ "confirm": "wipe" }` when confirmation is on) and unauthenticated `POST /api/panic` (404
> unless a token ≥16 chars is configured; rate-limited; the token is stored **scrypt-hashed**, so
> a seized node's config does not reveal it). The wipe empties all tables via the DAL's `wipeAll()`,
> deletes `avatars/`, invalidates every session, broadcasts a `wipe` event, closes all sockets, and
> re-seeds defaults — config survives so the switch can fire again. Clients purge IndexedDB,
> localStorage, service worker + caches, and show a neutral "Disconnected" screen. Admin UI has a
> Safety panel with type-to-confirm arming. Remaining (future): duress/decoy passphrase; key-discard
> wipe once encryption at rest lands (see the caveat below — a `DELETE` is not secure erasure).

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
