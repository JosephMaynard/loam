# LOAM architecture

A map of how LOAM is put together, for people reading or changing the code. `CLAUDE.md` holds the
detailed working notes written for AI agents; this file is the shorter human orientation. Paths are
relative to the repository root.

## What LOAM is

LOAM is a local-first messaging app for places where the internet is missing, overloaded or not the
right tool. One device, an Android phone, a laptop or a Raspberry Pi, becomes the host and runs the
whole network; people nearby scan a QR code and the web app opens in their browser. Nobody makes an
account: each person gets an anonymous, generated identity and can post in channels, reply in threads,
send direct messages, react, share pictures and files, and optionally talk to a small language model
running on the host. Everything stays on the host and on the devices of the people using it, and
switching the host off ends the network. The client is an installable web app that keeps a local copy
of what it has seen and reconnects on its own.

Three priorities, in order, decide the trade-offs:

1. **Simplicity**: scan and go; no setup, no install, no sign-up.
2. **Privacy**: anonymous and ephemeral by default; nothing is collected, and nothing leaves the local
   network unless the host links to another LOAM network.
3. **Resilience**: low bandwidth and connections that come and go are the normal case.

## Repository layout

A pnpm workspace (`pnpm-workspace.yaml` lists `apps/*` and `packages/*`; `cli/` is published on its
own as the `loamnet` npm package). Node is pinned to 24.15.0 in `.node-version`; the package manager
is `pnpm@10.30.2`.

| Path | What it is |
|---|---|
| `apps/server` | The Fastify server: REST and WebSocket, SQLite behind a data-access layer, sync, mesh, the optional LLM assistant. |
| `apps/client` | The Preact + Vite web app every participant uses, built as an installable PWA. |
| `apps/app` | The Android host app (Expo SDK 57 / React Native 0.86): embedded Node.js server, hotspot, WebView, setup screens. |
| `apps/site` | The loamnet.com website (Vite, static HTML pages). |
| `packages/schema` | `@loam/schema`: the Zod schemas and TypeScript types that form the client-server contract. |
| `packages/crypto` | `@loam/crypto`: X25519 handshake, XChaCha20-Poly1305 framing and the Ed25519/X25519 sealed sender, on `@noble/*`. |
| `packages/display-name` | `@loam/display-name`: a deterministic anonymous name (`adjective.material.creature`) from an id. |
| `packages/avatar` | `@loam/avatar`: a deterministic SVG avatar from an id (face, initial or pattern mode). |
| `packages/qr` | `@loam/qr`: a dependency-free QR encoder with SVG and terminal renderers. |
| `packages/tui` | `@loam/tui`: the `loamnet` terminal screen (join QR, activity, people, settings, debug, kiosk mode). |
| `cli` | The `loamnet` npm package: `bin/loam.js` boots the bundled server and web client from one command. |
| `scripts` | `dev.ts` (the root dev launcher), `build-cli.mjs`, `cli-smoke.mjs`, `check-versions.mjs` and its test. |

## How a message flows

Posting to a channel touches these pieces, in order:

1. **Browser.** A helper in `apps/client/src/lib/api.ts` (failures are a typed `ApiError { status, code }`)
   sends the request through `apps/client/src/lib/transport.ts` (`encryptedFetch`): the body is sealed on
   an encrypted session, and on a `required` node or a bound session the whole request is wrapped in an
   opaque `POST /api/transport/tunnel` (`tunnelFetch`).
2. **Transport layer.** Global Fastify hooks in `apps/server/src/transport-server.ts`: `onRequest` resolves
   the session, `preValidation` decrypts the body and checks the anti-replay sequence, `onSend` seals the
   response. A tunnelled request is re-dispatched to its inner route via `server.inject`.
3. **Route.** `POST /api/messages` in `apps/server/src/routes-messages.ts` validates the body with
   `MessageCreateRequestSchema` and calls `ctx.createMessage(body, authorId)`.
4. **Domain core.** `createMessage()` in `apps/server/src/app.ts` enforces feature flags, membership and
   posting rules, bans, blocks and member-rules acceptance, then assigns `id`, `authorId`, `createdAt`
   and `meta` and parses the result with `MessageSchema`.
5. **Write-through storage.** `store.insertMessage(message)` on the `LoamStore` data-access layer
   (`apps/server/src/db.ts`) writes synchronously to SQLite; only then is the message pushed onto the
   in-memory `data.messages` mirror that reads are served from.
6. **Broadcast.** The route calls `ctx.broadcast({ type: "messageCreated", message })`. In
   `apps/server/src/realtime.ts`, `broadcast()` offers the event to every socket, `socketCanReceiveEvent`
   drops it outside its audience (DM participants; private-channel members), and `wsSend` seals and
   sequence-numbers the frame on an encrypted socket.
7. **Other clients.** `parseSocketEvent` in `apps/client/src/lib/protocol.ts` re-validates the frame with
   the shared schemas; `LoamApp` in `apps/client/src/app.tsx` applies it to state and to the IndexedDB
   cache in `apps/client/src/lib/local-store.ts`.

Edits, deletions, reactions, users and channels follow the same shape: route, domain helper, store
write, broadcast.

## The schema contract

`packages/schema` is the single source of truth for everything on the wire: `Message` (a discriminated
union on `type`: `channelPost`, `channelReply`, `dm`, `reaction`), the `MessageCreateRequest` union
clients post, `Channel` with its `visibility` and private roster, `User`, `NetworkConfig` (the flags sent
to clients), `LoamConfig` and its PATCH shape, the LLM `StreamEvent`, and `IdSchema` (ids are capped at
`ID_MAX_LENGTH`, 128). Both ends validate with the same Zod schemas: the server at every route boundary
and on sync imports, the client on every payload it receives (`parseSocketEvent`, `parseMessageResponse`).

The two sides resolve the package differently. The server consumes the compiled package (`package.json`
`main` points at `dist/`), so a schema edit is invisible to a running `tsx watch` server until the package
is rebuilt (`pnpm --filter @loam/schema build`, or `pnpm -r build`). The client aliases the same packages
to their `src/` entry points (`apps/client/vite.config.ts`, `tsconfig.app.json` `paths`) and picks edits
up live. The same applies to every `packages/*` the server imports.

## Server modules

`buildApp()` in `apps/server/src/app.ts` is the composition root and the domain core (session identity,
users and moderation policy, channels, messages, the reapers, static files). It builds one `AppContext`
and hands it to the sibling modules:

| Module | Owns |
|---|---|
| `app-context.ts` | `AppContext`: accessor-backed views of the mutable state, the shared containers and every domain helper with its signature; a compile-time check asserts the object is complete. |
| `runtime.ts` | `Runtime`, the smaller live view handed to `llm.ts`, `mesh.ts` and `sync.ts`. |
| `store-lifecycle.ts` | Opening the database under the resolved key, the recovery paths, the durable wipe journal, `persistConfigForRestart`. |
| `kill-switch.ts` | Emergency Reset: the single-flight wipe and the key rotation that goes with it. |
| `transport-server.ts` | Host transport identity, sessions and replay windows, the internal tunnel token, request-auth helpers, the global hooks and rate limiter, the handshake, resume, logout and tunnel routes. |
| `realtime.ts` | Sockets, audience filtering, sealed WS frames, presence, `GET /ws` with its key confirmation. |
| `sync.ts`, `mesh.ts`, `llm.ts` | Node-to-node sync; the sealed-mail mesh layer; the LLM assistant. |
| `routes-session.ts`, `routes-users.ts`, `routes-channels.ts`, `routes-messages.ts`, `routes-sync-mesh.ts`, `routes-admin.ts` | REST routes by domain (users also covers moderation, reports, join approval, typing and attachments). |
| `db.ts` | The `LoamStore` data-access layer and `openStore()`. |
| `config.ts`, `secrets.ts`, `identity.ts`, `media.ts`, `ids.ts`, `defaults.ts`, `errors.ts`, `types.ts`, `boot-bridge.ts` | Pure helpers with no closure state. |
| `server.ts`, `embedded.ts`, `embedded-main.ts` | Entry points: the plain process, the library entry (`startEmbeddedServer`) used by the CLI and the Android launcher, and the Android bundle entry. |

Three conventions hold the modules together:

- **Persist, then mirror, then broadcast.** A mutation writes through to SQLite with the matching
  `store.*` method, updates the in-memory arrays, then calls `broadcast(...)`. There is no dirty flag or
  flush interval.
- **Shared state through `ctx.<name>`.** Module bodies reach state only through the context accessors
  (`ctx.data`, `ctx.appConfig`, `ctx.store`), never a captured copy, so a reassignment such as a reopened
  store lands on the live binding. A helper a route needs is added to `AppContext` and to the `base`
  literal in `buildApp`.
- **Feature flags are enforced in `createMessage()`.** `enableReplies`, `enableDMs`, `enableReactions`,
  `enablePublicChannels` and `enableMarkdown` are checked on the server; client gating is cosmetic.

## Identity and sessions

**Anonymous sessions.** On a plaintext connection, or an `optional` node without a pinned key,
`getSessionUserId` reads the `loam_session` cookie. If there is none it mints a `user.<16hex>` id (64
random bits, retried on collision) plus a 256-bit token and sets an HttpOnly, SameSite=Lax cookie.
Minting is bounded per IP (default 60 per 10 minutes). The client's locally generated id is only a
placeholder until the server's `currentUser` arrives.

**Bound sessions.** A client that joined by QR holds the host's key and promotes its transport session
with a sealed `POST /api/session/resume` carrying a separate identity token. Its identity is then the
session key, never a cookie, and its content is reachable only through the tunnel, so no bearer
credential crosses the LAN in clear (`docs/20-transport-auth-binding.md`).

**Admin bootstrap.** Admin rights come only from the configured `admin.bootstrap` strategy: `firstUser`
(the default in `apps/server/src/config.ts`: the first session on a fresh node), `setupCode` (a one-time
code logged at startup, exchanged via `POST /api/admin/claim`), `passphrase` (a reusable secret from
config, stored scrypt-hashed), `hostDevice` (the launcher mints a per-boot host token, so only the
host's own screen can claim; the Android app and `loamnet` both run this way), or `none`. Promotion
(`POST /api/admin/users/:userId/promote`) is deliberately one-way; there is no demote route. Admin-only
endpoints check `currentUser.isAdmin` on the server.

## Transport encryption and the trust model

LOAM serves plain HTTP on a LAN address, which browsers treat as an insecure context: no TLS without a
publicly trusted certificate, no WebCrypto, no service worker. Confidentiality is therefore
application-layer: `@loam/crypto` runs an X25519 handshake against the host's static key and seals
bodies and WebSocket frames with XChaCha20-Poly1305. The host's public key travels in the join QR as a
`#k=` URL fragment, so trust is rooted in the physical code rather than the network, and a swapped
poster shows up as a different emoji fingerprint.

- **Protected:** request and response bodies and WebSocket frames, against someone on the same Wi-Fi
  who eavesdrops, injects or replays. Each sealed request carries a monotonic sequence; a replay gets a 409.
- **Not protected:** anything from the host. The host decrypts everything to store, search, relay and
  run the assistant. The host operator is trusted by design; end-to-end encryption that hides content
  from the host is a separate, unbuilt layer (`docs/07`).
- **Visible even when encrypted:** request and response sizes and timing.

Two postures are operator-settable (`security.transportEncryption`). `optional`, the default, encrypts
every client that joined by QR but still accepts a plaintext client that typed the address by hand;
paths and image bytes stay in clear. `required` refuses plaintext clients, tunnels every request through
`POST /api/transport/tunnel` so paths are hidden, and serves avatars and attachments only through the
tunnel. The `hardened` security profile forces `required`; `open` and `standard` force `optional`. `off`
is not operator-settable: the only plaintext path is Developer Mode (`LOAM_DEV_MODE=1`, refused when
`NODE_ENV=production`, announced to every client with a red banner). A `#k=` fragment establishes a
pin; a different key is never swapped in silently, only offered once the pinned key stops working and
accepted only if it matches what the node itself reports. `docs/08-transport-security.md` is the
design; `docs/18-transport-security-review.md` is the reviewer's guide with the guarantees, the known
limitations and what to attack.

## Storage

Reads are served from in-memory arrays (`data.users`, `data.channels`, `data.messages`) and a sessions
map; every mutation writes through synchronously to SQLite in WAL mode (`loam.db` in the data
directory, `.loam/` by default) via the `LoamStore` data-access layer in `apps/server/src/db.ts`. Tables
cover users, channels, messages, sessions, config, tombstones, sync provenance, mesh identities and
contacts, reports and blocks. `config.json` and the `avatars/` and `attachments/` directories stay as
plain files. A stored row that no longer validates is repaired in memory where a safe repair exists,
otherwise quarantined (left on disk, never loaded, its id reserved) rather than failing boot. Legacy flat
JSON data is migrated by `importLegacyJsonData()` on first boot and renamed `*.json.bak`.

## Encryption at rest

`openStore(path, { encryptionKey })` picks the driver: `node:sqlite` by default (no native dependency),
or `better-sqlite3-multiple-ciphers` (SQLCipher) when a key is passed, loaded lazily so only encrypted
deployments touch the native module. The key arrives through `LOAM_DB_KEY` on a desktop or Pi
(`loamnet --encrypt` asks for a passphrase) and through the Android launcher's key handoff on a phone,
where `security.dbEncryption` is `off`, `ephemeral` (a random key held only in memory), `persistent`
(the phone's keystore) or `passphrase`. An encrypted mode fails closed: if the SQLCipher driver will not
load there is no fallback to plaintext, and after every keyed open the file header is checked so a
codec-less driver cannot silently write a plaintext database. Media files sit beside the database,
unencrypted. See `docs/01-sqlite-migration.md`.

## Emergency Reset

`executeKillSwitch()` in `apps/server/src/kill-switch.ts` (user-facing copy says Emergency Reset; config
and routes say `killSwitch`, `POST /api/admin/kill-switch` and `POST /api/panic`) deletes avatars and
attachments, invalidates every session, broadcasts a `wipe` event so connected clients purge IndexedDB,
localStorage and caches, closes the sockets and re-seeds defaults; config survives. On an encrypted
store it closes the database, deletes the files and, in ephemeral mode, rotates to a fresh key, which
makes any remnants on flash unreadable. On a plaintext store it is a logical `DELETE`, not secure
erasure. A client that was offline during the wipe sees on reconnect that its server-confirmed identity
changed (`apps/client/src/lib/identity.ts`) and purges then. Off by default (`killSwitch.enabled`); the
optional panic token fires it unauthenticated. See `docs/02-kill-switch.md`.

## Sync and mesh

**Node-to-node sync** (`apps/server/src/sync.ts`, `docs/11-node-sync.md`) is pull-based gossip of
public data only, off by default (`sync.enabled`). A node polls each configured peer's
`GET /api/sync/digest` and fetches records with `POST /api/sync/messages`; both return 404 unless sync is
on. Direct messages, private channels and shadow-banned authors never export. Imports are defensive:
public local channels only, users stripped of authority, edits only of messages this node itself
imported, and local deletions leave tombstones so a peer cannot bring them back. Two nodes are linked
with a single-use, ten-minute link code shown as a QR by an admin or the host phone (`sync-links.ts`).
An optional shared `sync.token` authenticates peers; the pull rides the same transport encryption as
clients.

**Opportunistic mesh** (`apps/server/src/mesh.ts`, `docs/16-opportunistic-mesh.md`) is delay-tolerant
"carry my message" delivery: A seals mail for B, C carries it without being able to read or correlate
it, B opens it. Phases 0 to 2 are built and tested: the `@loam/crypto` sealed sender, per-user mesh
identities and contact cards (`GET /api/mesh/identity`, `POST /api/mesh/contacts`),
`POST /api/mesh/messages` sealing only to an added contact, bounded relay over the existing sync
transport, and replay protection keyed on a hash of the ciphertext. It is off by default (`mesh.enabled`)
and entirely server-side: the guarantee is against carrier nodes, not the recipient's own trusted host.
Phase 3, the radio transport (Android BLE discovery plus Wi-Fi Aware transfer in
`apps/app/modules/loam-mesh-transport`, with the launcher-only bridge endpoints `GET /api/mesh/outbound`
and `POST /api/mesh/inbound`), is scaffolded only: the Kotlin compiles into every APK but has not been
run against real radios, because CI has none. `docs/17-mesh-transport-testing.md` is the two-phone test
procedure and the register of what is stubbed.

## The client

`apps/client` is Preact with `preact-iso` for routing. `parseRoute` in `src/lib/protocol.ts` maps paths
to a `RouteState`: `/channels`, `/channel/:id`, `/channel/:id/thread/:tid`, `/dm/:id`, `/settings`,
`/admin`, `/people`, `/search`, `/mesh`, `/rules` and `/privacy`. State is plain `useState` inside
`LoamApp` in `src/app.tsx`; there is no store library. Screens live in `src/views/`, components in
`src/components/` (`ConversationView` with its `MessageList` and `ThreadPanel`, `Sidebar`, `AdminView`,
`WelcomeScreen`, and the `Dialog`, `Menu` and `ScreenHeader` primitives), helpers in `src/lib/`.
`apps/client/DESIGN.md` is the UI contract.

Boot runs: hydrate from IndexedDB (`src/lib/local-store.ts`, database `loam-poc`), then the public
cookie-free `GET /api/bootstrap`, then either a sealed session resume (a QR-bound client) or the cookie
`GET /api/config`, then `/api/channels` and `/api/users`, then the WebSocket. Reconnects use exponential
backoff capped at 30 seconds; a liveness watchdog (`src/lib/ws-liveness.ts`) declares a socket dead after
about 60 seconds without the server's 25-second heartbeat. `src/lib/identity.ts` records the
server-confirmed user id and purges the cache when it changes. Markdown renders only through
`src/lib/markdown.ts` (`snarkdown`, then `DOMPurify`, safe link protocols, `#k=` fragments stripped).

The PWA caveat: `public/service-worker.js` caches the app shell (network-first for navigations,
cache-first for hashed assets, never `/api` or `/ws`) and is registered only in production builds. A
plain `http://<lan-ip>` origin is not a secure context and the browser refuses to register a service
worker there, so the offline shell works only on a secure origin such as `http://localhost`. The
IndexedDB cache does not depend on a service worker and works everywhere.

## The Android host

`apps/app` turns a phone into a complete host (`docs/04-android-host-app.md`). The server is bundled by
`scripts/bundle-server.mjs` (esbuild) into `nodejs-assets/nodejs-project/loam-server.js` and run inside
an embedded Node.js (nodejs-mobile) by the launcher in `nodejs-project-template/main.js`; the web client
is shown in a WebView. Both android-arm64 SQLite prebuilds (plain `better-sqlite3` and the SQLCipher
`multiple-ciphers` build) are vendored under `native-prebuilds/` with pinned hashes. The native pieces
are Expo modules in `modules/`: `loam-hotspot` (LocalOnlyHotspot, interface enumeration, Wi-Fi station
info), `loam-mesh-transport` (the Phase 3 scaffold) and `loam-updates` (update news on the setup screen).

Two hosting modes (`HostMode = 'hotspot' | 'wifi'` in `src/lib/host-mode.ts`, persisted in
SecureStore): Hotspot raises the phone's own local-only Wi-Fi; Wi-Fi mode advertises the phone's address
on the network it is already on and never asks for location. The join address is discovered, never
assumed: Android gives a hotspot a different random address each start, so the native module lists
candidates and `src/lib/hotspot-address.ts` scores them; with no confident pick the join screen shows a
manual route instead of a guess.

The launcher mints a random per-boot host token and passes it to the server as `LOAM_HOST_TOKEN`. That
token forces the `hostDevice` admin strategy, is injected only into the host's own WebView
(`window.__loamHostDeviceToken`, beside the node's transport key) and gates the launcher-only endpoints
(`/api/host/clients`, `/api/host/invite`, `/api/host/link-code`, the mesh bridge), so no LAN client can
claim admin during the boot window. The setup wizard (`src/components/setup-wizard.tsx`, logic in
`src/lib/setup.ts` and `src/lib/new-network.ts`) runs before the runtime starts: language, kind of
network (a security profile plus identity, presence and database-encryption choices), name, Hotspot or
Wi-Fi; later launches offer one-tap Continue or a hold-to-confirm new network. The app has its own i18n
in `src/lib/i18n`, covering the same 15 locales as the client.

## Testing

```bash
pnpm install
pnpm build                     # every package, then the server (tsc) and the client (tsc -b && vite build)
pnpm test                      # vitest in every workspace, then node --test over scripts/ and cli/test/
pnpm --filter app typecheck    # the Android app's own type-check (it has no build script)
pnpm smoke:cli                 # pack and install loamnet, then drive the installed `loam`
```

There is no lint script; type-checking happens inside `build`, plus the separate `typecheck` for
`apps/app`. The suites: `packages/*` (schema, display-name, avatar, qr, crypto, tui); `apps/server`
(`src/db.test.ts` for the data-access layer and importer, route suites by subject (`admin`, `channels`, `messages`,
`moderation`, `kill-switch`, `transport`, `sync`, `mesh`…) driving `buildApp()` through `server.inject()`
with a shared harness in `src/test-support/` (its header maps the files), and focused suites for realtime, llm, mesh-bridge, sync-transport,
tombstone, net, embedded, invites, rate-limit, member rules and blocking); `apps/client` (Vitest with
jsdom: `src/lib/*.test.ts` for markdown and XSS, IndexedDB round-trips with `fake-indexeddb`, parsers,
transport and liveness, plus a `.test.tsx` beside most components; test files are excluded from the
`tsc -b` build); `apps/app` (`src/**/*.test.ts`); and `scripts/check-versions.test.mjs` with
`cli/test/*.test.mjs` under `node --test`.

CI (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `master`:
`node scripts/check-versions.mjs` (every workspace `package.json`, `cli/package.json` and `app.json`
`expo.version` must agree), `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm test`,
`pnpm --filter app typecheck`, then `pnpm smoke:cli`. A second job builds on the pinned Node, then
installs and drives the packed CLI under Node 22.14, the oldest version `loamnet` supports.
`build-apk.yml` runs on tags: it re-checks versions against the tag, builds and tests, signs the APK and
attaches it to the release.

Two things new contributors run into:

1. **Rebuild `packages/*` for the server.** The server resolves `@loam/schema` and the other workspace
   packages to their compiled `dist/`. After editing a package, run `pnpm --filter @loam/<name> build`
   (or `pnpm -r build`); `tsx watch` will not do it. The client reads `src/` directly.
2. **Never put `*.test.*` files under `apps/app/src/app/`.** That directory is the Expo Router root, and
   its `require.context` bundles every file in it into the release APK; a test's `vitest` import then
   pulls `vite` into the bundle and breaks `assembleRelease`. Debug builds are unaffected, so the failure
   hides until an APK build. Keep tests in `src/lib/` or `src/__tests__/`.

## Docs index

Each file in `docs/`, with a class: **Live** describes shipped behaviour, **Plan** describes work not
built, **Investigation** is exploratory, **Historical** has been superseded. The class comes from the
doc's own status banner where it has one; where it does not, the class was decided from the content and
the entry says so.

| Doc | Class | What it covers |
|---|---|---|
| `01-sqlite-migration.md` | Live | The `LoamStore` data-access layer, both SQLite drivers, encryption at rest and the Android key handoff. |
| `02-kill-switch.md` | Live | Emergency Reset: the wipe, the panic token, the cryptographic wipe under encryption. |
| `03-admin-ui.md` | Live | Admin bootstrap strategies, the claim route, config layering and the admin area. Its "remaining" list predates later work such as the channels and Safety panels. |
| `04-android-host-app.md` | Live | The Android host: embedded Node, hotspot and Wi-Fi modes, join address discovery, setup screens, build and signing. |
| `05-authentication.md` | Plan | Optional real accounts (Better Auth or atproto) as a deployment mode. Not built: no workspace package depends on an auth library. |
| `06-llm.md` | Live | The assistant as built (Ollama and the on-device model), followed by a list of improvements to investigate that are not built. No banner. |
| `07-more-features.md` | Plan | A menu of candidate features ranked by fit; the table notes which rows have since landed. |
| `08-transport-security.md` | Live | The app-layer transport encryption design: handshake, sealing, tunnel, pinning, image encryption. |
| `09-security-profiles.md` | Live | `security.profile` as the authoritative bundle over join policy, retention, kill switch and transport mode. |
| `10-maps-location-sharing.md` | Investigation | A built-in map with location sharing; no code. |
| `11-node-sync.md` | Live | Node-to-node sync: the digest and messages endpoints, import rules, tombstones, linking. |
| `12-operators-guide.md` | Live | Running a network, for the host: devices, setup, admission, moderation, linking, reset. |
| `13-i18n.md` | Live | The 15-locale, admin-selected, node-wide translation and the translation policy. |
| `14-distribution.md` | Live | The `loamnet` npm package: what ships and how it is built. |
| `15-review-follow-ups.md` | Historical | The deferred backlog from a July 2026 review; most entries are fixed, and what is open moved to `25`. |
| `16-opportunistic-mesh.md` | Live | The sealed-mail mesh: Phases 0 to 2 shipped, the Phase 3 radio transport scaffolded and unverified on hardware. |
| `17-mesh-transport-testing.md` | Live | The two-phone test procedure and stub register for the Phase 3 scaffold; the hardware pass is still outstanding. |
| `18-transport-security-review.md` | Live | The reviewer's guide to transport encryption: code map, guarantees, limitations, attack checklist. Its banner lists what `20` changed since. |
| `19-courier-sync.md` | Plan | A human-carried, offline "data mule" transport beside LAN sync. Design only. |
| `20-transport-auth-binding.md` | Live | Binding identity to the transport session: bound sessions, `GET /api/bootstrap`, tunnel-only content. |
| `21-device-verification-checklist.md` | Live | On-device checks (model loading, SQLCipher keying, wipe timing, the host service) for shipped code that CI cannot exercise. The pass itself is outstanding. |
| `22-atproto-p2p.md` | Historical | Portable identity and user-owned repos, as an introduction; superseded by `23`. |
| `23-atproto-p2p-plan.md` | Plan | The revised plan of record for portable identity, pre-implementation after external review. |
| `24-electron-desktop.md` | Investigation | Feasibility of a double-click desktop host. |
| `25-backlog.md` | Live | The list of open work: §0 has the current open items, the older sections keep per-item detail. |
| `26-prior-art-buzz.md` | Investigation | Findings from reading Block's Buzz. |
| `27-path-to-mvp.md` | Historical | The pre-tester plan, superseded by `29`. |
| `28-prior-art-reticulum.md` | Investigation | Findings on Reticulum as a candidate LoRa transport. |
| `29-next-phase.md` | Historical | The August 2026 plan (stabilise, prove, extend). Track 0 shipped; the rest is still open and tracked in `25`. |
| `30-play-store.md` | Live | The Google Play readiness audit of the release build and what remains in the Play Console. |
| `decisions.md` | Live | The decision log: settled choices, and the open ones (identity mode, accounts, end-to-end encryption) with today's behaviour. |
| `roadmap.md` | Live | The public roadmap: what is built, what is next, what is being considered. |
