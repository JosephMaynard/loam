# 04 — Android host app (React Native)

> **Status: RUNS ON-DEVICE ✅ (headline goal met).** Landed on `feat/android-host-runnable`: a
> release APK boots the **real embedded LOAM server** inside `@comapeo/nodejs-mobile-react-native`'s
> Node 18 and shows the **LOAM web client in a WebView** — verified on an arm64 API-35 emulator.
> On-device proof: `Server listening on 0.0.0.0:3000`, `GET /api/config` → 200 (session minted),
> `POST /api/messages` → 201 with read-back, and the client rendered live (channels, DMs, avatars,
> "live" WS badge). DB uses plain **better-sqlite3** (unencrypted) via the digidem ABI-108
> android-arm64 prebuild. See **[Runnable build](#runnable-build)** below for exact commands. Prior
> desktop-verifiable work (bundler, host UI QR flow) still stands. **Follow-ups:** encryption at rest
> on-device, the `LocalOnlyHotspot` native module, and wiring the two-step QR join UI over the
> WebView host.
>
> Earlier status (kept for context): `apps/app/scripts/bundle-server.mjs` esbuild-bundles the real
> server (`apps/server/src/embedded.ts`, a TLA-free, env-driven CJS entry) →
> `nodejs-assets/nodejs-project/loam-server.js` + a copy of the built web client. Plus a
> dependency-free `QRCode` and a `HostPanel` implementing the two-step join flow (now unused by the
> home screen, which shows the WebView; kept for the hotspot UI follow-up). Caveat: `@loam/qr` tops
> out at version 6-H (~58 bytes) — fine for real LocalOnlyHotspot creds but a long SSID+password can
> overflow; raising QR capacity is a `packages/qr` follow-up.

## Runnable build

The `apps/app` Expo app builds an installable Android APK that runs the embedded server + WebView.

### Prerequisites
- Node `24.13.1`, pnpm `10.30.2` (repo pins). A real JDK (Android Studio's JBR:
  `/Applications/Android Studio.app/Contents/jbr/Contents/Home` on macOS — a bare JRE fails "No Java
  compiler found"). Android SDK with platform-tools + NDK r27+ (16KB page alignment). `ANDROID_HOME`
  set; `adb`/`emulator` on `PATH`.

### Build the APK (reproducible)
```bash
pnpm install                                   # nodejs-mobile's postinstall is (correctly) blocked by pnpm
pnpm -r build                                  # builds packages + server + web client (client dist is bundled)
pnpm --filter app fetch:native                 # downloads + places the better-sqlite3 android-arm64 prebuild
pnpm --filter app bundle:server                # esbuild → nodejs-assets/nodejs-project/{loam-server.js,client,main.js,...}
cd apps/app
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
CI=1 npx expo prebuild --platform android --no-install     # generates android/ (gitignored)
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
# → app/build/outputs/apk/release/app-release.apk (~91 MB; signed with the debug keystore, installable)
```

Install on a device/emulator: `adb install -r app/build/outputs/apk/release/app-release.apk`, then
launch it. First cold start takes ~1 minute (asset copy + first `require`); the screen shows
"Starting host…" until the server answers, then swaps to the WebView.

### Native prebuild (better-sqlite3)
`fetch:native` (`apps/app/scripts/fetch-native-modules.mjs`) pins `better-sqlite3@12.10.0` and downloads
the matching ABI-108 (Node 18) android-arm64 binary from
`digidem/better-sqlite3-nodejs-mobile` (tag `12.10.0`, asset
`better-sqlite3-12.10.0-node-108-android-arm64.tar.gz`), placing `better_sqlite3.node` at
`node_modules/better-sqlite3/build/Release/` where `bindings` resolves it. **Not committed** (native
binary) — re-run `fetch:native` after a clean checkout. `fetch-native-modules.mjs` verifies the
tarball against a pinned sha256 before installing it. The JS-wrapper npm version and the `.node`
release must stay in lockstep — if it ever fails to load, fall back to `11.10.0` (the version CoMapeo
ships) by changing **both** the npm wrapper version and the digidem release tag together (and update
the pinned `PREBUILD_SHA256`).

### What's committed vs generated
- **Committed (source):** `apps/server/src/db.ts` (`driver` option), `embedded.ts`
  (`LOAM_DB_DRIVER`), `apps/app/scripts/{bundle-server.mjs,fetch-native-modules.mjs}`,
  `apps/app/nodejs-project-template/{main.js,package.json}` (the CJS launcher template),
  `apps/app/plugins/with-loam-host.js` (config plugin: cleartext localhost + arm64-only ABIs),
  `apps/app/nodejs-assets/BUILD_NATIVE_MODULES.txt` (`0`), `apps/app/app.json` (package
  `app.loam.host`, plugin), `apps/app/src/app/index.tsx` (host WebView screen), `package.json` deps.
- **Generated at build time (gitignored):** `apps/app/android/` (prebuild),
  `apps/app/nodejs-assets/nodejs-project/` (bundle output + web client + native prebuild), the APK.

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
- ~~Top remaining unknown: Fastify 5 on Node 18~~ — **closed by the phase-2 spike: works.** See below.
- **Production precedent:** `digidem/comapeo-mobile` (Expo 54, the @comapeo fork, better-sqlite3 +
  drizzle inside the embedded Node) is in production and actively developed.

### Phase-2 spike verdict (2026-07-01): the real server runs on-device ✅

The actual `apps/server` (fastify 5.8.5 + @fastify/websocket + @fastify/static), esbuild-bundled to
a single CJS file, booted inside the @comapeo fork's Node 18.20.4 on an arm64 API-35 emulator and
passed a full protocol test via `adb forward`: `GET /api/config` (session cookie minted),
`POST /api/messages` → 201, static client + SPA fallback served, and a `messageCreated` WebSocket
broadcast received. **No fastify@4 pin needed.** Stretch goal also passed: the
`digidem/better-sqlite3-nodejs-mobile` ABI-108 android-arm64 prebuild loaded on-device and ran
CREATE/INSERT/SELECT — the encrypted-driver path (01) stands on proven ground.

Embedding recipe (validated; the bundle step should live in `apps/app`, e.g.
`scripts/bundle-server.mjs`, run before prebuild/EAS):
- esbuild: `bundle, platform node, target node18, format cjs`, entry the server, output
  `nodejs-assets/nodejs-project/loam-server.js` (~2.5 MB, zero native modules); alias `./db.js` to
  the platform driver implementation (the DAL seam); ship `apps/client/dist` inside
  `nodejs-assets/nodejs-project/` and point `LOAM_CLIENT_DIST` + `LOAM_DATA_DIR` at app-writable
  paths from the CJS launcher (`main.js`), which `require`s the bundle.
- After the upstream fixes landed with 03 part A + this spike (exported `buildApp()`, no bare
  `crypto.randomUUID()`, `LOAM_CLIENT_DIST` env), the embedded entry can call `buildApp()` directly
  — no top-level-await wrap, no `import.meta.url` shim.
- Android specifics: `app.json` needs `android.package`; `nodejs-assets/BUILD_NATIVE_MODULES.txt`
  containing `0` is **mandatory** once native-module prebuilds ship (else gradle tries host
  rebuilds); build with `expo prebuild` + `gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`.
- Cold start on the emulator was ~80 s (asset copy + first `require`), ~10 s after; plan a
  "starting host…" UI state. Verify with `adb forward` + host-side undici WebSocket
  (`new WebSocket(url, { headers: { cookie } })`).
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

## Monorepo question — settled

The RN app lives in this repo at **`apps/app`**, sharing `@loam/qr` and `@loam/schema` directly (one
source of truth for the wire contract and QR helpers) and CI. The accepted tradeoff is a heavier
workspace install (Expo/RN toolchain); gating its install remains an open nicety. See
[decisions.md](decisions.md) #4.

## Suggested next spikes (de-risk before building UI)
1. ~~nodejs-mobile viability~~ — **done, passed** (phase 1).
2. ~~Real server on-device (Fastify 5 / bundling / static / WS)~~ — **done, passed** (phase 2).
3. **Encrypted driver prebuilds**: fork `digidem/better-sqlite3-nodejs-mobile` CI, swap in the
   better-sqlite3-multiple-ciphers amalgamation, produce ABI-108 android-arm64 prebuilds, verify
   `PRAGMA key`/rekey on-device (see [01](01-sqlite-migration.md)). The plain-prebuild half is
   already proven on-device (phase 2 stretch goal).
4. `LocalOnlyHotspot` native module returning SSID/password.
5. WebView loading the served client over the hotspot, with cookies + WebSocket working end to end.

Only after those pass is the QR/host UI mostly glue over `packages/qr`.

## Open questions
- ~~Server hosting model~~ — settled: embedded Node (spike-verified twice, incl. the real server).
- ~~Co-locate the RN app in this monorepo?~~ — settled by action: `apps/app`.
- ~~The "two hotspot QR codes"~~ — settled: WiFi-join QR + LOAM-URL QR, shown sequentially.
- ~~Fastify 5 vs pin fastify@4~~ — settled: Fastify 5 works on the embedded Node 18.
- iOS in scope at all for v1? (Recommend no.)
