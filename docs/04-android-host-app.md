# 04 — Android host app (React Native)

## Goal

An Android app that turns a phone into a LOAM host: it brings up a local WiFi hotspot, shows QR codes
so nearby people can (a) join the hotspot and (b) open LOAM once connected, and presents all other UI by
loading the **existing LOAM web client in a WebView**. iOS is secondary (hotspot control is far more
restricted there).

## What already exists

The Expo app now lives **in this repo at `apps/app`** (commit `107acf5` — the old sibling
`../react-native-test-app` description is obsolete, and the monorepo question below is settled by
action). It is a stock Expo Router starter on **Expo SDK 57 / React Native 0.86.0 / React 19.2.3**,
with the **new architecture (Fabric) enabled** (mandatory on this RN). There is **no LOAM-specific
code, no hotspot/native module, no embedded server, and no `react-native-webview` dependency yet**
(add it for the host WebView). It is a **managed** Expo app (`expo-router/entry`, no `android/`
checked in) — prebuild is required for nodejs-mobile.

## The pivotal decision: where does the server run?

The LOAM server is Fastify + `@fastify/websocket` (Node). For the phone to be the host, that server has
to run somewhere on the phone. Options:

1. **Embedded Node via `nodejs-mobile-react-native`** — run the *existing* `apps/server` unchanged inside
   the app. Most code reuse. Cost: requires leaving pure-managed Expo (use **Expo prebuild + a config
   plugin / custom dev client**; nodejs-mobile ships native code). Also constrains the SQLite driver
   (initiative 1): nodejs-mobile's bundled Node may lag `node:sqlite` — **verify `node:sqlite` (or your
   chosen driver) actually runs under nodejs-mobile before committing.** Native `better-sqlite3` is hard
   to cross-compile here.
2. **Port the server to the RN JS runtime** — not viable as-is; Fastify + a real WS server don't run in
   RN's JS context without significant rework.
3. **Phone as thin host UI only** — the RN app just shows QRs + WebView, and the actual LOAM server runs
   on a *different* device on the network. Contradicts "join the Android phone's hotspot and access
   LOAM," so probably not the intent — but worth confirming.

**Decision (settled): option 1 — the phone runs the server** via nodejs-mobile, and leaving pure-managed
Expo (prebuild) is accepted (see [decisions.md](decisions.md) #2).

### Spike verdict (2026-07-01): viable-as-is ✅

The de-risking spike **built and ran** `nodejs-mobile-react-native@18.20.4` under Expo SDK 57 /
RN 0.86 / new architecture (legacy-module interop layer) on an arm64 API-35 emulator — embedded Node
HTTP server answering requests. Findings that bind future work:

- **Use the maintained fork `@comapeo/nodejs-mobile-react-native@18.20.4-2`** — upstream works, but
  the fork adds the **16KB page-size alignment** Google Play requires (Nov 2025) which upstream's
  released binaries lack, and it is actively maintained (upstream is dormant since Oct 2024).
- **Embedded Node is 18.20.4 (ABI 108, EOL)** — the Node 22 upgrade upstream is stalled. Plan for
  Node 18 indefinitely. `node:sqlite` is absent on-device; the encrypted-driver verdict
  (better-sqlite3-multiple-ciphers) lives in [01](01-sqlite-migration.md).
- **ARM ABIs only** (`arm64-v8a`/`armeabi-v7a`): the x86 CMake build is broken upstream (#78/#88).
  Irrelevant in practice — devices and Apple-silicon emulators are arm64.
- **Ship native-module prebuilds; never rebuild npm modules on-device** — CoMapeo's
  `download-prebuilds` + patch-package pattern is the model.
- **`apps/server` is ESM; nodejs-mobile boots a CJS `main.js`** — a bundle step (esbuild/rollup →
  single CJS file) is needed, which also inlines the workspace packages (`@loam/schema` etc.).
- **Top remaining unknown: Fastify 5 on Node 18.** Fastify v5's support policy is Node 20+ (though
  `fastify@5.6.2` declares no `engines` field, so it installs fine). Phase-2 spike answers it
  empirically; the fallback is pinning `fastify@4` for the embedded build.
- **Production precedent:** `digidem/comapeo-mobile` (Expo 54, the @comapeo fork, better-sqlite3 +
  drizzle inside the embedded Node) is in production and actively developed.
- Build-env notes: needs a real JDK (Android Studio's JBR 17 — a bare JRE fails with "No Java
  compiler found"); pnpm blocks the package's postinstall (scaffold `nodejs-assets/` manually); the
  module is CJS with no `.default` export; an Expo 53/Gradle strict-validation failure (#95) exists
  that the fork fixes — watch for it in EAS builds.

## Hotspot

Modern Android blocks silent programmatic tethering, but **`WifiManager.LocalOnlyHotspot`** is a strong
fit for LOAM: an app can start a **local-only** hotspot (no internet sharing — exactly LOAM's off-grid
model) and receives the generated **SSID + password** in a callback, which you render as the join QR. No
system-settings trip, no root. Caveats: needs location permission, one local hotspot at a time, and a
**native module** (no managed-Expo API) — reinforcing the prebuild/bare direction above. iOS has no
equivalent public API (Personal Hotspot is user-driven), so iOS hosting is out of scope for v1.

## QR codes (mostly already solved)

`packages/qr` already has what's needed:
- **`wifiPayload(ssid, password, auth)`** → the standard cross-platform `WIFI:T:WPA;S:…;P:…;;` string
  that Android/iOS cameras understand for one-tap joining. Feed it the LocalOnlyHotspot SSID/password.
- **`encodeQR()` + `renderQRToSvg()`** → the LOAM access URL QR (the phone's hotspot IP + client port).
  The server already computes its LAN address in `localIPv4()`.

So the RN app can render QRs by sharing `@loam/qr` (if the app joins the monorepo) or by having the
embedded server produce the SVGs.

**Settled QR scheme** (decision #6): a **two-step flow** —
1. **WiFi-join QR** from `wifiPayload(ssid, password)` (LocalOnlyHotspot credentials). Scanning it with
   the OS camera connects the device to the hotspot in one tap.
2. **LOAM-URL QR** from `encodeQR(http://<hotspot-ip>:<clientPort>)`. Once connected, scanning it (or
   tapping through) opens the client.

Suggested refinements (owner is open to better ideas): show them **sequentially** ("Step 1: connect →
Step 2: open LOAM") rather than side by side, since a camera can't act on both at once; and offer a
**manual fallback** (plain SSID + password text, and the URL) for cameras that don't parse `WIFI:`
strings. The standard `WIFI:` payload is the most cross-platform option (both Android and iOS cameras
support it); avoid Android-only Easy Connect for v1.

## WebView integration

- The embedded server serves the built client from `apps/client/dist` with an SPA fallback (already
  implemented in `registerStaticFiles()` / `setNotFoundHandler`). The host phone's WebView loads
  `http://localhost:<clientPort>`; remote joiners load `http://<hotspot-ip>:<clientPort>`.
- WebView needs: `credentials`/cookies enabled (the app relies on the `loam_session` cookie —
  `thirdPartyCookiesEnabled`, `sharedCookiesEnabled`), WebSocket allowed (works over `ws://` on the LAN;
  fine in a WebView), and cleartext HTTP permitted for the LAN origin (Android `usesCleartextTraffic` /
  network-security-config, since there's no TLS on a local hotspot).
- The client already supports a configurable server origin (`loam.serverUrl` in localStorage) and uses
  `credentials: "include"` — but same-origin (WebView → localhost) is simplest; prefer that.

## Monorepo question

Bringing the RN app into this repo as **`apps/mobile`** lets it share `@loam/qr` and `@loam/schema`
directly (one source of truth for the wire contract and QR helpers) and share CI. The tradeoff is a
heavier install (Expo/RN toolchain) in the workspace. Alternatively keep it separate and copy/publish the
contract. **Recommendation:** co-locate as `apps/mobile` for the shared packages, but gate its install so
the existing web/server workflow stays light. See [decisions.md](decisions.md).

## Suggested next spikes (de-risk before building UI)
1. ~~nodejs-mobile viability~~ — **done, passed** (verdict above). Remaining phase 2: switch to the
   @comapeo fork, **bundle the real `apps/server` (esbuild → single CJS) into
   `nodejs-assets/nodejs-project` and boot it on-device**, serving `apps/client/dist`. This answers
   the Fastify-5-on-Node-18 question empirically.
2. **Encrypted driver prebuilds**: fork `digidem/better-sqlite3-nodejs-mobile` CI, swap in the
   better-sqlite3-multiple-ciphers amalgamation, produce ABI-108 android-arm64 prebuilds, verify
   `PRAGMA key`/rekey on-device (see [01](01-sqlite-migration.md)).
3. `LocalOnlyHotspot` native module returning SSID/password.
4. WebView loading the served client over the hotspot, with cookies + WebSocket working end to end.

Only after those pass is the QR/host UI mostly glue over `packages/qr`.

## Open questions
- ~~Server hosting model~~ — settled: embedded Node (spike-verified).
- ~~Co-locate the RN app in this monorepo?~~ — settled by action: `apps/app`.
- ~~The "two hotspot QR codes"~~ — settled: WiFi-join QR + LOAM-URL QR, shown sequentially.
- iOS in scope at all for v1? (Recommend no.)
- Fastify 5 vs pin fastify@4 for the embedded Node 18 (phase-2 spike decides).
