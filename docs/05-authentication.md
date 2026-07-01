# 05 — Optional authentication (Better Auth / atproto)

## Goal

Let LOAM optionally run with **real accounts** so it can be hosted as a public/website deployment with
login — **without** compromising the anonymous, no-account experience that the Android/Pi off-grid mode
depends on. Authentication is a **deployment mode**, never forced.

## Frame it as "identity modes"

Make identity a first-class, config-selected mode rather than bolting auth onto the anonymous flow:

| Mode | Who it's for | Identity | Default where |
|------|--------------|----------|----------------|
| `anonymous` (today) | protest / off-grid / event | server-minted id via the `loam_session` cookie, ephemeral, no login | Android host, Raspberry Pi |
| `authenticated` | team chat / open-Slack / public website | real accounts (email/passkey/social/atproto), persistent; first-admin bootstrap still handled separately (see 03) | internet-hosted website |

The `User` schema already has the hooks: `type: human|bot|system`, `ephemeral: boolean`, `isAdmin`. In
`authenticated` mode an account maps to a `User` with `ephemeral: false` and a real `displayName`; roles
drive `isAdmin` (and solve the admin-bootstrap problem from [03](03-admin-ui.md) cleanly).

## Current identity model (what auth slots into)

In `apps/server/src/server.ts`: `getSessionUserId()` reads/sets the `loam_session` cookie and maps it to
a random `user.<hex>` via the in-memory `sessions` Map; `ensureUser()` lazily creates the `User`. No
passwords, no verification, cookie is the only credential. Auth replaces *how a request resolves to a
user* in `authenticated` mode, leaving the anonymous path untouched.

## Option A — Better Auth (recommended first)

[Better Auth](https://better-auth.com) is a headless, framework-agnostic TypeScript auth framework with
**official Fastify integration** and **SQLite support** (via `better-sqlite3` or a Drizzle adapter).

- **Strong synergy with the roadmap**: it stores its tables in the same SQLite DB we're adding in
  [01](01-sqlite-migration.md), and its SQLite path uses **`better-sqlite3`** — the same driver family as
  the **SQLCipher** encryption decision. One DB, one driver story.
- **Features that map onto LOAM needs**: email/password, **passkeys** (great for a no-password local
  feel), social providers, and an **admin/roles/organization** plugin that gives `isAdmin` and moderation
  roles directly — folding into [03](03-admin-ui.md).
- **Integration sketch**: mount Better Auth's handler at `/api/auth/*` in Fastify; in `authenticated`
  mode, `getSessionUserId()` resolves the Better Auth session instead of the anonymous cookie and
  upserts a matching `User` row. Gate all of it behind `identity.mode === "authenticated"`.
- **Kill-switch note**: authenticated deployments add account/session tables — the [02](02-kill-switch.md)
  `wipeAll()` must clear those too.

## Option B — atproto / AT Protocol OAuth (later, website-only)

Let people sign in with their existing atproto identity (e.g. a Bluesky handle). OAuth is now the
[stable, dominant auth mechanism in atproto](https://docs.bsky.app/blog/oauth-atproto).

- **Philosophically aligned** (decentralized, portable identity; users bring their own PDS) — attractive
  for a federated/public LOAM.
- **But fundamentally online**: login requires internet to resolve the handle→DID→PDS network location,
  plus dynamic client registration and DPoP-bound tokens. **This cannot work in the off-grid modes** — it
  only makes sense for the internet-hosted `authenticated` deployment. Say so plainly so it's never
  mistaken for an off-grid feature.
- **More moving parts** than Better Auth (client metadata document, PDS discovery, token binding).

**Recommendation:** ship **Better Auth first** as the `authenticated` mode (self-contained, shares the
SQLite/SQLCipher DB, gives roles + passkeys). Add **atproto later as an optional provider** for public
website instances that want federated identity — either standalone or, if a suitable plugin exists, as a
provider within Better Auth. Keep both strictly opt-in and off in the off-grid defaults.

## Cross-cutting
- **Anonymity is the default and must stay effortless.** Never require accounts in `anonymous` mode; the
  protest threat model depends on no identifying data existing at all.
- **CORS/cookies**: website hosting is multi-origin (unlike the same-origin WebView case) — Better Auth's
  Fastify guide covers the CORS/cookie config; align with the existing `credentials: "include"` client.
- **Migration**: existing anonymous users are ephemeral; there's no account data to migrate. Optionally
  allow "claim this anonymous identity into an account" later.

## Open questions
- Is `authenticated` mode primarily for the website deployment only, or also an option on Pi (LAN with
  logins)? (Assumed website-first.)
- Passkeys vs email/password vs social as the default method for the website?
- atproto now or deferred? (Recommend deferred.)

## Sources
- [Better Auth — Fastify integration](https://better-auth.com/docs/integrations/fastify),
  [SQLite adapter](https://better-auth.com/docs/adapters/sqlite),
  [community `fastify-better-auth` plugin](https://github.com/flaviodelgrosso/fastify-better-auth)
- [OAuth for AT Protocol (Bluesky)](https://docs.bsky.app/blog/oauth-atproto),
  [atproto OAuth spec](https://atproto.com/specs/oauth)
