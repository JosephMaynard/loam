# LOAM roadmap — planning notes for Fable

These docs are a **briefing pack**, not prescriptive specs. They capture the current state (grounded
in real files/functions), the goal, design options with a recommendation, a task breakdown, and open
questions. Fable decides how to execute. Read `CLAUDE.md` first for the architecture baseline.

## The four initiatives

| # | Initiative | One-line goal | Doc |
|---|-----------|----------------|-----|
| 1 | **SQLite migration** | Replace the flat-JSON store with SQLite behind a data-access layer. | [01-sqlite-migration.md](01-sqlite-migration.md) |
| 2 | **Kill switch** | Config-gated, admin-triggered fast wipe of all data (server + connected clients). | [02-kill-switch.md](02-kill-switch.md) |
| 3 | **Admin UI** | In-app, admin-only area to edit config and run admin actions (no more hand-editing text files). | [03-admin-ui.md](03-admin-ui.md) |
| 4 | **Android host app** | Expo/React-Native app that runs a hotspot, shows join QRs, and hosts the LOAM web client in a WebView. | [04-android-host-app.md](04-android-host-app.md) |

## Investigations (candidate initiatives, not yet sequenced)

Researched but not committed — briefings for Fable/owner to prioritize.

| Initiative | One-line goal | Doc |
|-----------|----------------|-----|
| **Optional authentication** | Add an opt-in `authenticated` deployment mode (Better Auth now; atproto later) without touching the anonymous off-grid default. | [05-authentication.md](05-authentication.md) |
| **LLM improvements** | Provider abstraction, fix the O(n²) streaming, bound context, channel/@mention, and local RAG. | [06-llm.md](06-llm.md) |
| **Other features** | Menu of candidates: attachments, E2EE, LoRa sync, presence, etc. (ephemeral messages, moderation, search, and RTL have since landed — see the doc's status notes). | [07-more-features.md](07-more-features.md) |
| **Maps & location sharing** | Offline map tiles + opt-in location sharing on the local node. | [10-maps-location-sharing.md](10-maps-location-sharing.md) |
| **Node-to-node sync** | Pull-based gossip of public data between nodes (the transport-agnostic layer LoRa will ride). **MVP landed.** | [11-node-sync.md](11-node-sync.md) |
| **Transport security (no HTTPS)** | QR-bootstrapped app-layer encryption so plain-HTTP LAN traffic is confidential + MITM-resistant without certs. | [08-transport-security.md](08-transport-security.md) |
| **Security profiles** | Make all security optional via a few named presets (open/standard/hardened), not a toggle matrix — spans disaster-relief to protest. | [09-security-profiles.md](09-security-profiles.md) |

## How they interlock

- **1 enables 2 and 3.** The kill switch and admin config editor both want a real storage layer with
  transactional writes and a config table. Do the SQLite migration first (or at least land the
  data-access abstraction) so 2 and 3 build on it instead of the JSON files.
- **2 and 3 share a surface.** The kill switch is *triggered from* the admin UI and *configured in* the
  admin config. Build the admin config plumbing once; both use it.
- **3 has a hard prerequisite: admin bootstrap.** *(Solved — landed with initiative 3 part A.)*
  Admin now comes from the pluggable `admin.bootstrap` strategies (`firstUser` default, `setupCode`,
  `passphrase`, `none`; `hostDevice` reserved for the Android host) via `POST /api/admin/claim`;
  the legacy admin seed ids were demoted. See `CLAUDE.md` and 03.
- **4 pulls on everything.** If the phone hosts the server, the storage/kill-switch/admin work must run
  under whatever Android runtime you choose, which constrains the SQLite driver (initiative 1). Decide
  the Android hosting model early even if you build it last.

## Recommended sequence

1. **Initiative 1** — SQLite migration + data-access layer + first server tests. Low user-visible risk,
   unblocks the rest.
2. **Initiative 3 (part A)** — admin bootstrap + admin config read/write API + minimal admin UI.
3. **Initiative 2** — kill switch (server wipe + client remote-wipe), wired into the admin UI and config.
4. **Initiative 3 (part B)** — flesh out the admin UI (wire the currently-hardcoded feature flags, user
   management, etc.).
5. **Initiative 4** — Android host app, once the server story is stable.

## Cross-cutting open decisions

These shape multiple initiatives. Captured with recommendations in [decisions.md](decisions.md); the
top few are worth confirming with the project owner before Fable commits.

1. **Encryption at rest?** Pairs with the kill switch for the protest threat model and *drives the
   SQLite driver choice* (`node:sqlite` has no encryption; SQLCipher/libsql do). See 01 and 02.
2. **Android hosting model** — does the phone run the Node server (via nodejs-mobile, needs bare/prebuild
   workflow) or is it a thin host UI? Biggest fork; see 04.
3. **Admin bootstrap mechanism** — first-user-claims-admin, console/QR setup code, or config passphrase?
   See 03.
4. **Monorepo the RN app?** *(Settled by action — it lives at `apps/app`.)* Co-located to share
   `packages/qr` + `packages/schema`. See 04.
5. **Kill-switch UX** — instant vs. confirmation vs. duress code; and whether it remote-wipes connected
   clients (strongly recommended: yes). See 02.
