# CLAUDE.md

Guidance for AI agents (and humans) working in the LOAM repo. Read this before making changes.

## What LOAM is

LOAM is a **local-first, off-grid messaging app**. A host runs it on a laptop, Raspberry Pi, or
phone hotspot; nearby people scan a QR code and join over the local network — no internet, no
accounts, no cloud. Users get an anonymous, ephemeral identity and can post to channels, reply in
threads, DM, react, and (optionally) chat with a local LLM. The client is an installable PWA that
keeps working offline against its local cache.

Priorities, in order: **simplicity** (no setup), **privacy** (anonymous/ephemeral), **resilience**
(low bandwidth, intermittent connectivity). It is transport-agnostic by design (WiFi today; LoRa
relay is a stated future goal).

**Positioning & governance.** LOAM is framed as *local communication for crowded or disrupted
environments* (emergencies, travel, community events) — see `MISSION.md`, `ACCEPTABLE_USE.md`, and the
translation policy in `docs/13`. Keep **user-facing/marketing copy** (site, README) accurate but
non-inflammatory (the node-wide wipe is "Emergency Reset" in public copy; code identifiers like
`killSwitch`/`/api/panic` and the blunt security docs stay as-is). The **security docs stay
technically honest** — the distinction is documenting privacy accurately vs. presenting
law-enforcement avoidance as the purpose.

**Opportunistic mesh / DTN** (`docs/16-opportunistic-mesh.md`) — delay-tolerant "carry my message"
(A→C→B) delivery. **Phases 0–2 are BUILT & TESTED** (see the doc's "Implementation status"):
`packages/crypto` (`@loam/crypto`) is the Ed25519/X25519 sealed-sender primitive; the server has a
`sealed` `Message` arm, per-user mesh identities (`mesh_identities` DAL table), `POST
/api/mesh/messages` to seal, and bounded relay (TTL/hop/cap, no acks) — all gated on `mesh.enabled`
(default off; enable via config for now). It's **entirely server-side** (LOAM's host is already
trusted for its local users, so the E2E guarantee is against carrier *nodes*), rides the existing
sync transport, and doesn't touch public sync. **Not built:** Phase 3 (BLE/Wi-Fi-Aware opportunistic
transport — needs physical devices), the secret-token `toTag` (v1 tags derive from the public kx → no
metadata-unlinkability yet), contact/QR key discovery, and an admin-UI mesh toggle. Do not rush the
unbuilt crypto/transport — that's the documented way comparable apps (Bridgefy, FireChat) failed.

## Layout

pnpm workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`). Node pinned to `24.13.1`
(`.node-version`), package manager `pnpm@10.30.2`.

| Path | Role |
|------|------|
| `apps/server` | Fastify backend: REST + WebSocket, SQLite persistence behind a DAL (`src/db.ts`), optional Ollama LLM. App factory: `src/app.ts` (`buildApp()`, all routes/logic — testable via `inject`); `src/server.ts` is the thin entry point (env, listen, SIGINT). |
| `apps/client` | Preact + Vite PWA. Main app: `src/app.tsx` (~2k lines, all components). Libs in `src/lib/`. |
| `apps/app` | Expo SDK 57 / RN 0.86 — the **Android host** (embedded Node server + hotspot + WebView, see `docs/04-android-host-app.md`). Has `scripts/bundle-server.mjs` (esbuild → `nodejs-assets/nodejs-project/loam-server.js`, gitignored) and the host UI (`HostPanel`, `QRCode`). No test script, so `pnpm test` skips it; validate with `pnpm --filter app typecheck` (also a CI step). |
| `packages/schema` | **The client↔server contract.** Zod schemas + inferred TS types for users, channels, messages, config, stream events. |
| `packages/display-name` | Deterministic anonymous name from an id (`adjective.material.creature`), FNV-1a + mix32 hashed. |
| `packages/avatar` | Deterministic SVG avatar from an id. Three modes: `face` (SVG template), `initial`, `pattern`. OKLCH colour derivation with WCAG contrast fixups. Has a standalone `demo/`. |
| `packages/qr` | Dependency-free QR encoder + SVG/terminal renderers and payload helpers. |
| `scripts/dev.ts` | Root dev launcher: prints a join QR + LAN URL, spawns server and client. |

## Commands

```bash
pnpm install          # install workspace deps
pnpm dev              # root: runs server + client together, prints join QR (see ports below)
pnpm build            # pnpm -r build: builds all packages, then server (tsc) and client (tsc -b && vite build)
pnpm test             # pnpm -r --if-present test: runs vitest in the 4 packages + apps/server + apps/client
```

There is **no lint script**. Type-checking happens as part of `build` (`tsc`), except `apps/app`,
which has a dedicated `typecheck` script (`pnpm --filter app typecheck`). A `.stylelintrc.json`
exists but is not wired to any script. CI (`.github/workflows/ci.yml`) runs `pnpm build`, `pnpm
test`, then the apps/app typecheck on push/PR to `master`.

**Tests**: `packages/*` (schema, display-name, avatar, qr), `apps/server` (`src/db.test.ts` for the
DAL/importer, `src/app.test.ts` for routes via `buildApp()` + `server.inject()` — admin bootstrap
matrix, config API, flag enforcement, kill switch, retention, private channels, search, WebSocket
privacy filtering via a real listener — plus `src/embedded.test.ts`), and `apps/client` (Vitest + jsdom:
`src/lib/markdown.test.ts` sanitizer/XSS, `src/lib/local-store.test.ts` IndexedDB round-trips +
kill-switch purge via `fake-indexeddb`, `src/lib/protocol.test.ts` route + WS-event + message-response
parsers). Client tests use a standalone `vitest.config.ts` (jsdom + `@preact/preset-vite`, so `*.test.tsx`
mount real components into jsdom); `*.test.ts`/`*.test.tsx` are excluded from the `tsc -b` build. The
pure route/protocol parsers live in `src/lib/protocol.ts` (extracted from `app.tsx`); rendered
components extracted to `src/components/` (`Avatar`, `UnreadBadge`, `InviteControl`, `SearchResult`) have `.test.tsx`
suites. `apps/app` has no test script, so `pnpm test` skips it — validate with
`pnpm --filter app typecheck` (CI runs this as its own step).

## How dev mode wires together (important)

`pnpm dev` (`scripts/dev.ts`) starts two processes:

- **client** — Vite dev server on **:3000** (`CLIENT_PORT`).
- **server** — Fastify on **:3001** (`PORT`), via `tsx watch`.

The browser talks to the client origin. Vite (`apps/client/vite.config.ts`) **proxies** `/api` and
`/ws` to the server at `LOAM_API_PORT` (3001). So in dev there are two origins bridged by the proxy.

In **production** there is one origin: `apps/client` is built to `apps/client/dist`, and the server
serves it as static files (`registerStaticFiles`) with an SPA fallback to `index.html`. Run it with:

```bash
pnpm build && pnpm --filter @loam/server start   # node dist/server.js, defaults to PORT 3000
```

Env vars the server/dev script read: `PORT`, `CLIENT_PORT`, `HOST`, `LOAM_JOIN_HOST`,
`LOAM_DATA_DIR`, `LOAM_CONFIG_FILE`, `LOAM_API_PORT` (client), `NODE_ENV` (`production` adds
`Secure` to the session cookie).

## Data model & the schema contract

`packages/schema` is the source of truth for wire types. Both ends validate with Zod:

- **Message** is a discriminated union on `type`: `channelPost`, `channelReply`, `dm`, `reaction`.
  A separate `MessageCreateRequest` union is what clients POST (server assigns `id`, `authorId`,
  `createdAt`, `meta`).
- **Channel** carries `visibility` (`public` | `private`) and, for private channels, `memberUserIds`
  (the invite-only roster; the owner is always an implicit member). `ChannelCreateRequest` accepts
  `visibility`; `ChannelMemberAddRequest` is the invite payload.
- **User**: `{ id, displayName, avatar?, type: human|bot|system, isAdmin, createdAt, ephemeral }`.
  `avatar` is either generated (`seed`+`mode`) or an uploaded `image` (`imageId`+`mimeType`).
- **StreamEvent**: `start | delta | end | error` — the LLM streaming protocol over the WebSocket.
  Deltas carry only the new text (sent just to the DM participants); the final complete message is
  persisted and broadcast once via `messageUpdated`, so non-streaming clients still converge.
- **NetworkConfig**: feature flags sent to the client from `/api/config` (and re-broadcast live via
  the `configUpdated` WS event when an admin edits config).
- **LoamConfig / LoamConfigUpdate**: the full node configuration (identity, features, llm, admin
  bootstrap, security profile) and its PATCH shape — shared by the server config loader, the
  `/api/admin/config` endpoints, and the client admin UI.

**Gotcha — build the schema package after editing it.** The server imports `@loam/schema` which
resolves to the compiled **`dist/`** (`package.json` `main`). `tsx watch` does *not* rebuild the
package, so schema edits are invisible to the running server until you rebuild it
(`pnpm --filter @loam/schema build`, or `pnpm -r build`). The **client** imports the same packages
via **Vite aliases to `src/`** (see `vite.config.ts` / `tsconfig.app.json` `paths`), so it picks up
edits live. This asymmetry applies to all `packages/*` (schema, avatar, display-name, qr).

## Server architecture (`apps/server/src/app.ts`)

- **Storage**: reads are served from in-memory arrays (`data.users/channels/messages`) + a
  `sessions` Map; every mutation **writes through synchronously** to SQLite (`.loam/loam.db`, WAL
  mode) via the DAL in `src/db.ts` (`LoamStore`). `openStore(path, { encryptionKey })` selects the
  driver: default `node:sqlite` (ExperimentalWarning is expected; no native dep), or
  **better-sqlite3-multiple-ciphers** (SQLCipher, **encrypted at rest**) when a key is passed —
  lazy-`require`d, so only encrypted deployments load the native module (it's in
  `pnpm-workspace.yaml` `onlyBuiltDependencies`). Set via `buildApp({ dbEncryptionKey })` ←
  `LOAM_DB_KEY`; encrypted stores need a file path, not `:memory:`. On first
  boot with legacy data, `importLegacyJsonData()` migrates the old `*.json` files into the DB and
  renames them `*.json.bak`. `config.json` and the `avatars/` dir remain plain files. There is no
  `markDirty`/flush interval any more — call the matching `store.*` method after mutating in-memory
  state, then `broadcast(...)`. `.loam/` is gitignored.
- **Sessions/identity**: `getSessionUserId` reads the `loam_session` cookie; if absent it mints a new
  `user.<8hex>` id + token and `Set-Cookie`s it (HttpOnly, SameSite=Lax). The **server session cookie
  is the real identity**; the client's locally generated id is a pre-hydration placeholder that gets
  replaced by `config.currentUser` on first load.
- **Admin**: comes only from the config-selected **bootstrap strategy** (`admin.bootstrap`):
  `firstUser` (default — the first session on a fresh node becomes admin), `setupCode` (a one-time
  code logged at startup, exchanged via `POST /api/admin/claim`, rate-limited + constant-time
  compared), `passphrase` (same endpoint, reusable secret from config), `hostDevice` (reserved for
  the Android host, initiative 4), or `none`. Seed users `user.1234`/`user.5678` still exist but are
  **never admins** (legacy admin seeds are demoted at boot). Admin-only endpoints check
  `currentUser.isAdmin`; client gating is cosmetic.
- **Config**: layered defaults ← `config.json` ← DB-persisted admin edits (`config` table), all
  validated against the shared `LoamConfigSchema`. `PATCH /api/admin/config` merges, persists,
  hot-reloads, and broadcasts `configUpdated`. Feature flags are **enforced server-side** in
  `createMessage()`. Secrets (`admin.passphrase`, `killSwitch.panicToken`) are stored
  **scrypt-hashed** (`scrypt:<salt>:<hash>`) — plaintext from a config file or PATCH is hashed at
  merge time and verified with `verifySecret()`; never store or compare them in the clear.
- **Rate limiting**: `@fastify/rate-limit` runs globally (300/min/IP) with a tighter per-route cap
  on avatar uploads; claim/panic add their own semantic attempt limiters on top.
- **Ephemeral messages** (off by default; `retention.messageTtlMs`): a 30s reaper (+ boot sweep)
  deletes expired messages and broadcasts `messageDeleted`; streaming LLM messages are spared until
  complete.
- **Kill switch** (off by default; `killSwitch.enabled`): `executeKillSwitch()` deletes avatars,
  invalidates sessions, broadcasts `wipe` (clients purge IndexedDB/localStorage/SW caches and show a
  neutral disconnected screen), closes sockets, and re-seeds defaults. Config survives. The data
  wipe depends on encryption: **encrypted** (`LOAM_DB_KEY` set) → close store, delete DB files, and
  (ephemeral mode) rotate to a fresh key — a cryptographic wipe that makes flash remnants
  unreadable; the store is reopened so `app.store` is a **getter**, not a snapshot. **Unencrypted** →
  `store.wipeAll()` (logical DELETE, **not** secure erasure on flash — docs/02). Optional
  unauthenticated panic token (`killSwitch.panicToken`) fires it via `POST /api/panic`.
- **Broadcast filtering**: `broadcast()` sends to all sockets but `socketCanReceiveEvent` restricts DM
  and DM-reaction events to their participants and **everything about a private channel (the channel
  upsert, its messages, and reactions on them) to its members** (`messageAudienceUserIds` resolves the
  member set); public channel messages and `userUpserted` go to everyone. A member removed from a
  private channel gets a targeted `channelRemoved` event via `sendEventToUsers` (clients purge the
  channel + cached messages and navigate away).
- **Private channels**: `createChannelFromRequest` honours `visibility` (`private` requires the
  `enablePrivateChannels` flag; creator becomes owner + sole member). Enforcement is everywhere the
  data flows: `GET /api/channels` filters per-user; `GET /api/messages/:channelId` 404s identically
  for unknown and inaccessible channels (existence is never leaked, and posting as a non-member gets
  the same "Channel does not exist"); member management is
  `GET/POST /api/channels/:id/members` + `DELETE /api/channels/:id/members/:userId` (owner/admin
  invite+remove, self-remove = leave, the owner can never be removed) +
  `POST /api/channels/:id/transfer` (owner/admin hand ownership to another user; the new owner joins
  the private roster if absent, the old owner stays a member). **Node admins get no implicit
  read access** — they manage private channels (rename/archive via `/api/admin/channels`) without
  joining their audience.
- **Search**: `GET /api/search?q=&limit=` — case-insensitive substring over message bodies, newest
  first, scoped to the caller (accessible non-archived channels + own DMs, shadow-ban respected).
- **Attachments**: messages may carry ≤4 images (`attachments` on posts/replies/DMs; image-only
  messages are valid). `POST /api/attachments` mirrors the avatar pipeline (base64, magic-byte vs
  MIME, 256KB cap, rate-limited); ids are uploader-bound and consumed on first use; files served
  from `GET /api/attachments/:fileName` (unguessable ids), deleted with their message / kill switch.
  Clients downscale to ≤1280px webp on-device first (`apps/client/src/lib/attachments.ts`).
  `enableAttachments` flag, default on.
- **Network identity & presence**: `node.name` (default "LOAM local") is the operator-set network
  name in `NetworkConfig.nodeName` (client sidebar/join/tab title), editable via the admin Network
  panel. `enablePresence` (default on) makes the WS broadcast a `presence` event (online user ids,
  visible users only) on every connect/disconnect — the client shows online dots; disable for
  high-risk deployments (it reveals who is connected).
- **Admin promotion**: `POST /api/admin/users/:userId/promote` (admin-only) makes a member admin.
  Deliberately **one-way** — no demote route; admin removal is via re-bootstrap / kill switch, so a
  contested node can't fall into a mutual-demotion fight (see docs/12).
- **Node-to-node sync** (docs/11): `sync.{enabled,peers,intervalMs}` config; pull-based gossip of
  **public data only** via `GET /api/sync/digest` + `POST /api/sync/messages` (404 unless enabled).
  DMs/private channels/shadow-banned authors never export. Imports are defensive (public-local
  channels only, users stripped of authority, edits only when newer, attachments copied
  best-effort). Local deletes write **tombstones** (DB table) so peers can't re-import them.
  Admin: `GET /api/admin/sync`, `POST /api/admin/sync/run`, and the admin-UI peers panel. A peer's
  join URL is its sync address.
- **Security headers**: an `onSend` hook sets `X-Content-Type-Options: nosniff` on every response and
  a strict CSP (`default-src 'self'`, `frame-ancestors 'none'`, no external origins) on the app shell
  (non-`/api/` navigations). No HSTS — LOAM serves plain HTTP on the LAN by design. The session
  cookie's `Secure` flag tracks the real request protocol (`x-forwarded-proto`/TLS), not `NODE_ENV`.
- **REST endpoints**: `GET /api/health` (liveness, mints no identity — the Android launcher probes
  this so it can't consume the `firstUser` admin grant), `GET /api/config`, `GET/PATCH /api/users`, `PATCH /api/users/me`,
  `PUT /api/users/me/avatar-image`, `PATCH /api/users/:userId` (admin), `GET /api/avatars/:fileName`,
  `GET/POST /api/channels`, `PATCH /api/channels/:channelId` (owner or admin),
  `GET/POST /api/channels/:channelId/members`,
  `DELETE /api/channels/:channelId/members/:userId`, `GET /api/messages/:channelId`,
  `GET /api/dms/:userId`, `POST /api/messages`, `PATCH/DELETE /api/messages/:messageId`,
  `GET /api/search`, `GET /api/moderation/users` + `PATCH /api/moderation/users/:userId`
  (admin/moderator ban + shadow-ban), `GET /api/access/pending` +
  `POST /api/access/users/:userId/approve|deny` (admin/greeter join approval),
  `PATCH /api/admin/users/:userId/roles` + `POST /api/admin/users/:userId/promote` (admin),
  `POST /api/attachments` + `GET /api/attachments/:fileName`, `POST /api/admin/claim`,
  `GET/PATCH /api/admin/config` (admin),
  `GET /api/admin/channels` (admin), `POST /api/admin/kill-switch`
  (admin + `killSwitch.enabled`), `POST /api/panic` (unauthenticated pre-shared token; 404 unless
  configured). WebSocket at `GET /ws` (requires the session cookie to already be set — the client
  opens it only after `/api/config` resolves).
- **Avatar uploads**: base64 JSON body, ≤128KB, magic-byte signature checked against declared MIME,
  written to `.loam/avatars/`. Original files never leave the browser (cropped client-side to 256×256).
- **LLM (optional)**: when `llm.ollama.enabled`, a bot user appears as a DM contact. DMing it streams
  a reply from Ollama's `/api/chat` into a new assistant message, updated incrementally. All gated on
  config; absent config = no bot, no LLM routes.

**Feature-flag note**: the messaging flags (`enableReplies`, `enableDMs`, `enableReactions`,
`enablePublicChannels`, `enableMarkdown`) are real config values enforced in `createMessage()`.
`enableUserChannels` gates user channel creation (`POST /api/channels`); `enablePrivateChannels`
(default **on**) gates the *creation* of private channels — existing private channels keep working
if it is later switched off. **`security.profile` is authoritative**: a named profile (`open`/`standard`/`hardened`)
forces a coherent bundle of the already-enforced axes — `access.joinPolicy`, `retention.messageTtlMs`,
`killSwitch.enabled` — onto the effective config at `mergeConfig()` time via `securityProfilePreset()`
(shared from `@loam/schema`). `custom` (**the default**) forces nothing, leaving those axes
individually configurable. A boot-time `reconcileLegacyProfile()` demotes an older persisted preset to
`custom` if its stored axes diverge, so the profile becoming authoritative never silently disarms a
kill switch. See `docs/09-security-profiles.md`.

## Client architecture (`apps/client/src/app.tsx`)

- Preact + `preact-iso` for routing (hash-free paths: `/channels`, `/channel/:id`,
  `/channel/:id/thread/:tid`, `/dm/:id`, `/settings`, `/admin`, `/people`, `/search`). `parseRoute`
  maps path → `RouteState`. The admin area (`AdminView`) and the claim form in settings appear per
  `currentUser.isAdmin` / `networkConfig.allowAdminClaim` — cosmetic only; the server enforces.
- State is plain `useState` in `LoamApp` (no store lib). Flow: hydrate from **IndexedDB**
  (`src/lib/local-store.ts`, db `loam-poc`) → fetch `/api/config`, `/api/channels`, `/api/users` →
  open WebSocket → apply live `messageCreated/Updated/Deleted` and `userUpserted` events. Reconnect
  uses exponential backoff (cap 30s).
- All server payloads are re-validated client-side with the same Zod schemas (`parseSocketEvent`,
  `parseMessageResponse`).
- **Markdown**: `src/lib/markdown.ts` renders with `snarkdown`, escapes first, sanitises with
  `DOMPurify`, and hardens links (safe protocols only, `rel=noreferrer target=_blank`). Any new
  rendered-HTML path must go through this — never inject raw message HTML.
- **PWA**: `public/service-worker.js` (cache `loam-poc-v1`) caches the app shell, network-first-ish
  for other GETs, never touches `/api` or `/ws`. Registered only in PROD (`main.tsx`).
- **Avatar upload editor**: `AvatarImageEditor` in `app.tsx` — canvas crop/zoom/rotate with pointer
  gestures, re-encodes to webp/png under 128KB before upload.

## Conventions

- TypeScript strict everywhere; `noUnusedLocals`/`noUnusedParameters`/`verbatimModuleSyntax` on. Use
  `import type` for type-only imports (enforced).
- ESM only (`"type": "module"`). Server uses `NodeNext` resolution; client uses bundler resolution.
- Named functions with JSDoc are the house style (see existing code). Match the surrounding density.
- Validate at boundaries with the shared Zod schemas rather than trusting `any`.
- After mutating server state, write through to the store (`store.upsertUser(...)`,
  `store.insertMessage(...)`, etc.) and `broadcast(...)` as the existing handlers do.
- Relative imports inside `packages/*/src` must use explicit `.js` extensions — the compiled `dist/`
  runs under Node ESM (the server consumes it), which rejects extensionless specifiers.

## Good first areas / known gaps

- `apps/client` has a Vitest+jsdom harness now (lib parsers + rendered-component tests for `Avatar`,
  `UnreadBadge`, `InviteControl`, `SearchResult` under `src/components/`). Most of `app.tsx` is still
  one big module, so extracting more presentational components into `src/components/` to test them is
  high value.
- **Private channels are implemented** (membership, full server-side enforcement, member management
  UI, targeted `channelRemoved`) — see the server-architecture notes above. **Ownership transfer**
  landed too: `POST /api/channels/:id/transfer` (owner/admin only; the new owner is added to a private
  roster if absent, the old owner stays a member) with a "Make owner" control in the Members panel.
  Remaining refinement idea: a join-request flow (today it is invite-only).
- Message search is server-side substring (`LIKE`-equivalent over the in-memory mirror); semantic
  search would fall out of the RAG embeddings (docs/06) if that lands.
- `security.profile` is wired (see the feature-flag note) but only bundles the axes LOAM enforces
  today; the axes that would distinguish `open` from `standard` (transport encryption, invite tokens
  — docs/08) are unbuilt, so those two profiles apply the same settings for now.
- On-device SQLCipher (encrypted Android DB) is still deferred — needs a multiple-ciphers ABI-108
  android-arm64 prebuild (docs/01, docs/04).
- LoRa / alternate transports: the node-to-node sync protocol (docs/11) is the transport-agnostic
  layer a LoRa link would carry; the LoRa framing/bandwidth work itself is unbuilt. **Sync peer
  authentication is now built**: an optional shared `sync.token` (stored in the clear — it's a bearer
  secret the node must present) is required via the `x-loam-sync-token` header on `/api/sync/*` when
  set, and attached when pulling; a missing/wrong token 404s identically to sync being off. Unset =
  open (the pre-token behaviour). Transport encryption (docs/08) is still the remaining hostile-env
  gap.
- **Anonymous-user creation is bounded**: `getSessionUserId` mints a new identity only within a per-IP
  budget (`maxNewIdentitiesPerWindow`, default 60 / 10 min; `AppOptions`), throwing a `429` past it —
  a client that keeps its session cookie never touches it, and on a LAN each device has its own IP.
- **Release APK signing**: `pnpm --filter app keystore` generates a real signing key;
  `plugins/with-release-signing.js` injects the release `signingConfig` at prebuild **only when
  `keystore.properties` exists** (no-op otherwise, so the default debug-signed build is unaffected).
