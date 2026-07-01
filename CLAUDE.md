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

## Layout

pnpm workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`). Node pinned to `24.13.1`
(`.node-version`), package manager `pnpm@10.30.2`.

| Path | Role |
|------|------|
| `apps/server` | Fastify backend: REST + WebSocket, SQLite persistence behind a DAL (`src/db.ts`), optional Ollama LLM. App factory: `src/app.ts` (`buildApp()`, all routes/logic — testable via `inject`); `src/server.ts` is the thin entry point (env, listen, SIGINT). |
| `apps/client` | Preact + Vite PWA. Main app: `src/app.tsx` (~2k lines, all components). Libs in `src/lib/`. |
| `apps/app` | Expo SDK 57 / RN 0.86 starter — the future **Android host** (embedded Node server + hotspot + WebView, see `docs/04-android-host-app.md`). No LOAM code yet; no build/test script, so CI skips it. |
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
pnpm test             # pnpm -r --if-present test: runs vitest in the 4 packages + apps/server
```

There is **no lint script and no typecheck-only script**. Type-checking happens as part of `build`
(`tsc`). A `.stylelintrc.json` exists but is not wired to any script. CI (`.github/workflows/ci.yml`)
runs exactly `pnpm build` then `pnpm test` on push/PR to `master`.

**Tests**: `packages/*` (43 tests: schema, display-name, avatar, qr) plus `apps/server` (27 tests:
`src/db.test.ts` for the DAL/importer, `src/app.test.ts` for routes via `buildApp()` +
`server.inject()` — admin bootstrap matrix, config API, flag enforcement). `apps/client` has **no
test script**, so `pnpm test` skips it — a Vitest+jsdom client harness is still a good early win.

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
  mode) via the DAL in `src/db.ts` (`LoamStore`, opened with `node:sqlite` — emits an
  ExperimentalWarning, that's expected). The DAL is deliberately **driver-agnostic** so an encrypted
  driver (SQLCipher/libsql) can replace `node:sqlite` (see `docs/01-sqlite-migration.md`). On first
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
  `createMessage()`.
- **Ephemeral messages** (off by default; `retention.messageTtlMs`): a 30s reaper (+ boot sweep)
  deletes expired messages and broadcasts `messageDeleted`; streaming LLM messages are spared until
  complete.
- **Kill switch** (off by default; `killSwitch.enabled`): `executeKillSwitch()` wipes all tables
  (`store.wipeAll()`), deletes avatars, invalidates sessions, broadcasts `wipe` (clients purge
  IndexedDB/localStorage/SW caches and show a neutral disconnected screen), closes sockets, and
  re-seeds defaults. Config survives the wipe. Optional unauthenticated panic token
  (`killSwitch.panicToken`) fires it via `POST /api/panic`. Note: without encryption at rest this
  is a delete, **not** secure erasure (docs/02).
- **Broadcast filtering**: `broadcast()` sends to all sockets but `socketCanReceiveEvent` restricts DM
  and DM-reaction events to their participants; channel messages and `userUpserted` go to everyone.
- **REST endpoints**: `GET /api/config`, `GET/PATCH /api/users`, `PATCH /api/users/me`,
  `PUT /api/users/me/avatar-image`, `PATCH /api/users/:userId` (admin), `GET /api/avatars/:fileName`,
  `GET /api/channels`, `GET /api/messages/:channelId`, `GET /api/dms/:userId`, `POST /api/messages`,
  `POST /api/admin/claim`, `GET/PATCH /api/admin/config` (admin), `POST /api/admin/kill-switch`
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
`enablePrivateChannels`/`enableUserChannels` are stored and surfaced but have nothing to gate yet
(no channel creation or private channels exist). `security.profile` is stored but does not drive
any behaviour yet (see `docs/09-security-profiles.md`).

## Client architecture (`apps/client/src/app.tsx`)

- Preact + `preact-iso` for routing (hash-free paths: `/channels`, `/channel/:id`,
  `/channel/:id/thread/:tid`, `/dm/:id`, `/settings`, `/admin`). `parseRoute` maps path →
  `RouteState`. The admin area (`AdminView`) and the claim form in settings appear per
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

- No tests for `apps/client` — a Vitest+jsdom client test harness would be high value and easy to
  slot into CI.
- `enablePrivateChannels`/`enableUserChannels` gate nothing yet — channel creation and private
  channels are the natural features to hang off them.
- `security.profile` config exists but no preset logic consumes it yet (docs/09).
- LoRa / alternate transports are a stated design goal but unimplemented.
- Channel creation, private channels, and message editing/deletion by users are not exposed yet
  though schema/data structures partially anticipate them.
