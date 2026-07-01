# 03 — Admin UI

## Goal

Move node configuration out of hand-edited text files into an **admin-only area in the client app**.
Admins can edit identity/LLM/feature settings, manage users/channels, and trigger admin actions (e.g.
the kill switch, initiative 2). Non-admins never see it; the server enforces every admin action.

## Hard prerequisite: admin bootstrap

Today **no real user can be an admin.** `isAdmin` is only true for seed users `user.1234` /
`user.5678` (set in `loadData()` via `ensureUser(id, id === "user.1234")`), and every browser session
gets a random `user.<hex>` id from `getSessionUserId()`. So an admin-gated UI is unreachable in
practice. **Solve this first.** Options:

1. **Console/QR setup code** — the server prints a one-time admin claim code on startup (and could
   render it as a QR next to the join QR in `scripts/dev.ts`). An endpoint `POST /api/admin/claim`
   exchanges the code for admin on the current session. Good for the host who has terminal/device access.
2. **First-user-claims-admin** — the first session to hit a fresh node becomes admin. Simple, but racy
   on a busy first boot and weak if a stranger connects first.
3. **Config passphrase** — `admin.passphrase` in config; a login form grants admin to the session.
   Familiar, but a shared secret to distribute.

**Decision (settled): bootstrap is per-deployment and pluggable** — see [decisions.md](decisions.md) #3.
Model it as a config strategy (e.g. `admin.bootstrap: "hostDevice" | "firstUser" | "setupCode" |
"passphrase"`) with a sensible default per platform:

- **Android host app** → `hostDevice`: the phone owner is the admin. Since the RN app *is* the embedded
  server (initiative 4), the app can grant admin to the local host session directly — e.g. the embedded
  server issues an admin session for connections from `localhost`/the host WebView, or the app injects a
  local-only admin token the server trusts. Remote joiners over the hotspot are never auto-admin.
- **Raspberry Pi / headless** → `firstUser`: the first session on a fresh node becomes admin (accept the
  minor first-boot race, or pair with a short console-printed code to close it).
- Keep `setupCode` (console/QR claim code) and `passphrase` available for other setups.

Persist which user ids are admin in the DB (initiative 1) rather than hardcoding the `user.1234` seed.
Whatever the strategy, the server is the enforcer; the client only reflects `isAdmin`.

## Current state

- **Config is load-once, read-only, partial.** `loadAppConfig()` reads `.loam/config.json`
  (`LOAM_CONFIG_FILE` override) and only understands `identity.*` and `llm.ollama.*`; everything else in
  `NetworkConfig` is **hardcoded** in `currentNetworkConfig()` (e.g. `enablePrivateChannels: false`,
  `enableReplies: true`). There is no endpoint to read or write config, and no hot-reload.
- **Client already knows who's admin.** `/api/config` returns `currentUser` including `isAdmin`, held in
  `LoamApp` state. The sidebar has a settings link (`SettingsView` in `app.tsx`) but no admin section.
- **Existing admin-ish route**: `PATCH /api/users/:userId` already checks `currentUser.isAdmin &&
  appConfig.identity.allowAdminUserEdit` — a pattern to reuse for new admin endpoints.

## Design

### Server
- **Persist config** in the DB `config` table (initiative 1) instead of / in addition to the JSON file,
  so the admin UI can write it and it survives restart. Keep env/file override for headless setup.
- **Endpoints** (all guarded by `currentUser.isAdmin`):
  - `GET /api/admin/config` — full editable config.
  - `PATCH /api/admin/config` — validate (Zod) + persist + **hot-reload** `appConfig` and re-derive
    `currentNetworkConfig()`; broadcast a config-changed event so clients refresh feature flags live.
  - `POST /api/admin/kill-switch` (initiative 2).
  - (Later) channel create/archive, user role management, session revocation.
- **Wire the hardcoded flags.** As part of this, make the currently-constant `NetworkConfig` flags
  (private/user channels, replies, reactions, markdown, DMs, LLM) real config values and **enforce them
  server-side** in the relevant routes/`createMessage()` — right now they're decorative.
- Add a shared config schema to `packages/schema` so client and server validate the same shape.

### Client
- **Admin route** (e.g. `/admin`), rendered only when `config.currentUser.isAdmin`; add a sidebar entry
  gated the same way. Follow the existing `SettingsView` structure/styling in `app.tsx`.
- Sections: **Node config** (identity, feature flags, LLM), **Safety** (kill-switch enable + trigger,
  initiative 2), later **Users** and **Channels**.
- Forms PATCH `/api/admin/config`; reflect the config-changed broadcast so other admins/clients update.
- Never rely on client gating for security — it's cosmetic; the server is the gate.

## Testing
- Auth matrix on every `/api/admin/*` route (non-admin → 403).
- Config PATCH validates, persists, hot-reloads, and rejects bad shapes.
- Admin-bootstrap flow (claim code single-use; wrong code rejected).
- Client: admin UI hidden for non-admins; visible + functional for admins (jsdom).

## Depends on / enables
- **Depends on** initiative 1 (config persistence) and the admin-bootstrap decision above.
- **Enables** initiative 2 (kill-switch toggle + trigger live here).
