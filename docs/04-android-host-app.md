# 04 — Android host app (React Native)

> **Status: RUNS ON-DEVICE ✅ + HOTSPOT JOIN UI ✅.** Landed on `feat/android-host-runnable`: a
> release APK boots the **real embedded LOAM server** inside `@comapeo/nodejs-mobile-react-native`'s
> Node 18 and shows the **LOAM web client in a WebView** — verified on an arm64 API-35 emulator.
> On-device proof: `Server listening on 0.0.0.0:3000`, `GET /api/config` → 200 (session minted),
> `POST /api/messages` → 201 with read-back, and the client rendered live (channels, DMs, avatars,
> "live" WS badge). DB uses plain **better-sqlite3** (unencrypted) via the digidem ABI-108
> android-arm64 prebuild. Then on `feat/android-hotspot-join`: a **`LocalOnlyHotspot` native module**
> (`apps/app/modules/loam-hotspot`, Kotlin via the Expo Modules API) plus a **"Share · Host" host bar**
> above the WebView that opens a modal rendering the two-step QR join flow (`HostShareOverlay` →
> `HostPanel`). Emulator-verified (arm64 API-35): LOAM still loads, the bar's button opens the modal,
> tapping it prompts for `ACCESS_FINE_LOCATION` then `NEARBY_WIFI_DEVICES`, and `startHotspot()` runs.
> This emulator's virtual WiFi actually supported LocalOnlyHotspot, so the **happy path** rendered —
> "Host running", Step 1 with a real SSID/password (`AndroidShare_1065` / a generated passphrase) +
> WiFi QR, and Step 2's LOAM-URL QR (`http://192.168.49.1:3000`); Done closes back to the WebView.
> Graceful degradation (permission denied / no SoftAP / a callback that never fires) is code-complete
> — `requireOptionalNativeModule` for unlinked runtimes, a native reject on `onFailed`/`SecurityException`,
> a 20s JS start-timeout, and an error message in Step 1 while Step 2's QR stays — but wasn't the path
> this emulator took. The full two-phone join (a second device scans Step 1, connects, scans Step 2) is
> the **physical-device** test. See
> **[Runnable build](#runnable-build)** below for exact commands. **Follow-ups:** encryption at rest
> on-device; 32-bit `armeabi-v7a`; raising `@loam/qr` capacity for long creds.
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
**Shortcut:** `pnpm --filter app apk` runs every step below in one go (auto-detecting the Studio
JDK/SDK on macOS) and copies the result to `apps/app/loam-host.apk`. The manual steps:
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

### Signing the release APK

By default `assembleRelease` signs with Android's **debug** keystore — fine for `adb install`, but
that key is regenerated per machine, so it can't sign durable updates (Android requires every update
to be signed with the same key). To sign with a real, stable key:

```bash
pnpm --filter app keystore     # creates apps/app/release.jks + keystore.properties (both gitignored)
pnpm --filter app apk          # now signs the release APK with that key
```

`plugins/with-release-signing.js` injects the release `signingConfig` at prebuild **only when
`apps/app/keystore.properties` exists** — with no keystore it's a no-op, so the debug-signed build
above keeps working unchanged. `release.jks` and `keystore.properties` are gitignored; **back them
up** (losing the key means users must uninstall before they can update). For Play Store distribution,
enable Play App Signing and treat this key as the upload key. See `keystore.properties.example` for
the file format if you'd rather supply your own key than generate one.

> **Installing to a phone (not the emulator):** `adb` must list the phone. Enable **Developer
> options** (Settings → About → tap Build number 7×) → **USB debugging**, accept the *"Allow USB
> debugging?"* prompt, and use a **data** cable set to *File transfer*. If both a phone and the
> emulator are connected, target the phone: `adb -s <serial> install -r …` (serials from `adb devices`).

### Hosting from a phone — the two-step join & its gotchas
The host runs a `WifiManager.LocalOnlyHotspot`. Joiners **Step 1** scan the WiFi QR to connect, then
**Step 2** scan the URL QR to open LOAM. Real-world gotchas:

- **Don't turn on the phone's own WiFi hotspot / tethering.** Android allows a device to run *either*
  its personal hotspot *or* a LocalOnlyHotspot, not both — enabling the system hotspot tears LOAM's
  down. The host may stay **connected to a WiFi network** (station mode) while hosting; that's fine.
- **Keep the LOAM app in the foreground.** Backgrounding can suspend the hotspot and the embedded
  server. (Screen-on + app-open is the reliable state.)
- **The Step-2 address.** LocalOnlyHotspot puts the host at `192.168.49.1` on **stock** Android, but
  this isn't guaranteed. The launcher (`main.js`) reports the host's real IPv4 addresses over the
  `loam-hostinfo` channel and the host screen builds the Step-2 QR from the `192.168.49.x` one when
  present, listing the others underneath. **If Step 2 won't load, try one of the listed addresses**
  (`http://<addr>:3000`) — and tell us which one worked so we can harden the picker.
- **Client isolation.** A few hotspot stacks isolate connected clients from the host; if every
  address fails despite a good WiFi connection, that's the likely cause (device-dependent).

### Native prebuild (SQLite drivers — plain + encrypted)
`fetch:native` (`apps/app/scripts/fetch-native-modules.mjs`) places **both** SQLite native modules
into the embedded project's `node_modules` (the DAL, `apps/server/src/db.ts`, lazy-`require`s whichever
one it needs, so both ship):

- **Plain `better-sqlite3`** (`@12.10.0`, the on-device default): the matching ABI-108 (Node 18)
  android-arm64 binary is **downloaded** from `digidem/better-sqlite3-nodejs-mobile` (tag `12.10.0`,
  asset `better-sqlite3-12.10.0-node-108-android-arm64.tar.gz`) and placed at
  `node_modules/better-sqlite3/build/Release/`. If it ever fails to load, fall back to `11.10.0` (the
  version CoMapeo ships) by changing **both** the npm wrapper version and the digidem release tag
  together (and update `PREBUILD_SHA256`).
- **Encrypted `better-sqlite3-multiple-ciphers`** (`@12.11.1`, SQLCipher; used when
  `security.dbEncryption` is on and a key is handed across the bridge — docs/01): its android-arm64
  ABI-108 binary has no upstream release, so it's a **self-built prebuild VENDORED in the repo** at
  `apps/app/native-prebuilds/multiple-ciphers/` (tarball + reproducible build recipe + README, all
  committed). `fetch:native` extracts it into `node_modules/better-sqlite3-multiple-ciphers/build/Release/`.
  So the encrypted driver **now ships on-device** and `security.dbEncryption` modes take effect on a
  real device build (subject to on-device `PRAGMA key` runtime verification — docs/01).

The `.node` binaries themselves are **not committed** in `nodejs-assets/` (gitignored build output) —
re-run `fetch:native` after a clean checkout. `fetch-native-modules.mjs` sha256-verifies **each**
tarball (downloaded and vendored alike) before installing it. Each JS-wrapper npm version and its
`.node` source version must stay in lockstep (change both together).

### What's committed vs generated
- **Committed (source):** `apps/server/src/db.ts` (`driver` option), `embedded.ts`
  (`LOAM_DB_DRIVER`), `apps/app/scripts/{bundle-server.mjs,fetch-native-modules.mjs}`,
  `apps/app/nodejs-project-template/{main.js,package.json}` (the CJS launcher template),
  `apps/app/plugins/with-loam-host.js` (config plugin: cleartext localhost + arm64-only ABIs +
  hotspot/WiFi permissions), `apps/app/nodejs-assets/BUILD_NATIVE_MODULES.txt` (`0`),
  `apps/app/app.json` (package `com.loamnet.host`, `loam://` scheme, plugin), `apps/app/src/app/index.tsx` (host WebView
  screen + "Share · Host" button + overlay), `apps/app/src/components/{host-panel,host-share-overlay,
  qr-code}.tsx`, `apps/app/src/hooks/use-hotspot.ts`, **`apps/app/modules/loam-hotspot/`** (the local
  Expo module: `expo-module.config.json`, `index.ts`, `src/*.ts`, `android/build.gradle` +
  `LoamHotspotModule.kt`), `package.json` deps, **`apps/app/native-prebuilds/multiple-ciphers/`** (the
  self-built encrypted-driver prebuild tarball + `build-mc-android-arm64.sh` + `CMakeLists.mc.txt` +
  `README.md` — vendored because no upstream Android/ABI-108 release exists; sha256-pinned in
  `fetch-native-modules.mjs`).
- **Generated at build time (gitignored):** `apps/app/android/` (prebuild — local modules are
  autolinked into it, not committed), `apps/app/nodejs-assets/nodejs-project/` (bundle output + web
  client + **both** SQLite native prebuilds, plain + encrypted), the APK.

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

**Implemented (`feat/android-hotspot-join`):** `apps/app/modules/loam-hotspot` is a local **Expo
Module** (Kotlin, `LoamHotspotModule.kt`) exposing `startHotspot(): Promise<{ssid,password}>` and
`stopHotspot(): void`. `startHotspot` calls `WifiManager.startLocalOnlyHotspot(callback, handler)` and,
on `onStarted`, resolves with the reservation's credentials — `SoftApConfiguration.getSsid()`/
`getPassphrase()` on API 30+, falling back to `WifiConfiguration.SSID`/`preSharedKey` on older. It holds
the single reservation, resolves each promise exactly once, and rejects (code `ERR_HOTSPOT`) with a
readable reason on `onFailed`, a `SecurityException` (missing permission), or any other failure — so the
emulator's no-WiFi failure surfaces cleanly instead of hanging. The JS wrapper
(`modules/loam-hotspot/index.ts`) loads the module with `requireOptionalNativeModule`, so importing it
off-Android yields `null` rather than a crash. `src/hooks/use-hotspot.ts` requests the runtime
permissions (`ACCESS_FINE_LOCATION`, plus `NEARBY_WIFI_DEVICES` on API 33+) via
`PermissionsAndroid.requestMultiple` **before** starting, tracks a module-scope singleton state
(Android allows one hotspot per process), and never throws — denial/failure lands in an `error` phase.
The permissions are declared in the manifest by the config plugin (`with-loam-host.js`).

> **Correction (fix/device-feedback-round1):** an earlier hardening pass ("A10") capped
> `ACCESS_FINE_LOCATION` with `android:maxSdkVersion="32"` in the plugin, reasoning that
> `NEARBY_WIFI_DEVICES` (API 33+, `neverForLocation`) would cover `startLocalOnlyHotspot` the same
> way it covers Wi-Fi Aware/BLE scanning. Per Android's own docs that's true *only if the runtime
> request is updated to ask for `NEARBY_WIFI_DEVICES` instead of `ACCESS_FINE_LOCATION` on API 33+*;
> `use-hotspot.ts` was never changed to do that split (it still requests `ACCESS_FINE_LOCATION`
> unconditionally, in addition to `NEARBY_WIFI_DEVICES` on 33+, and needs every requested permission
> granted). With the manifest cap in place, the `ACCESS_FINE_LOCATION` request on any API 33+ device
> auto-denies (a request for a permission the manifest doesn't declare shows no dialog), so the
> hotspot could never start on **any** device running API 33+ — confirmed as the cause of a "Host
> stopped / location permission is needed" regression on a Galaxy S25 Ultra (API 35). Fixed by
> removing the `maxSdkVersion` cap, restoring the exact configuration verified in the emulator run
> quoted above. A cleaner long-term fix is updating `use-hotspot.ts` to request only
> `NEARBY_WIFI_DEVICES` on API 33+ — left as a follow-up, since the emulator behaviour above shows the
> current unconditional-`ACCESS_FINE_LOCATION` request is at least a working baseline.

**Host UI:** `src/app/index.tsx` renders a compact host bar above the LOAM WebView with a **"Share ·
Host"** button (a top bar, not a floating overlay — an Android WebView swallows touches on any native
view layered over it, so an on-top button wouldn't register). It opens `HostShareOverlay` (a
full-screen modal). The overlay starts the hotspot on open and feeds
`{ssid,password}` + the fixed gateway `serverUrl` into the presentational `HostPanel`, which shows
**Step 1** (WiFi-join QR + SSID/password text) and **Step 2** (LOAM-URL QR + address text). The LOAM
access URL for joiners is the LocalOnlyHotspot **gateway `http://192.168.49.1:3000`** (the AOSP
default for local-only hotspots, hardcoded in Android's tethering config), known before the hotspot
starts — so **Step 2 always renders**, and when the hotspot can't start, `HostPanel` shows the error
in Step 1 while keeping Step 2 (graceful degradation). A rare OEM could assign a different gateway;
detecting the AP interface address at runtime is a fragile, hard-to-test follow-up, so we ship the
AOSP-standard address (correct on the overwhelming majority of devices).

**Left-on-display controls** (both optional, both in the overlay): **Keep screen on** holds an
`expo-keep-awake` lock while enabled — for a host taped to a wall showing the join QRs. **Kiosk mode**
enters Android **screen pinning** (`Activity.startLockTask()`, exposed from `LoamHotspotModule` as
`startKiosk`/`stopKiosk` and driven by an effect in `index.tsx`) so a passer-by can't wander into
other apps. Without device-owner provisioning, leaving a pinned app uses the system exit gesture
(**swipe up and hold** on gesture nav, or hold **Back + Recents** on 3-button nav), which demands the
phone's own screen-lock PIN when one is set — so the host must set a device PIN first. Both native calls are best-effort no-ops when unsupported and never throw; the pin is
released on unmount. The overlay also shows the app **version** (`Constants.expoConfig?.version`).

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
3. **Encrypted driver prebuilds** — **build DONE, on-device verify pending.** The
   `better-sqlite3-multiple-ciphers` ABI-108 android-arm64 prebuild has been cross-compiled (fork of
   `digidem/better-sqlite3-nodejs-mobile`'s recipe with the MultipleCiphers amalgamation swapped in),
   vendored at `apps/app/native-prebuilds/multiple-ciphers/`, and wired into `fetch:native` so both
   drivers ship — the APK carries the exact vendored binary with the right symbols (build evidence,
   `readelf`-verified). What's left is a **release gate**: the MC JS wrapper's declared `engines` are
   Node 20.x/22.x (not the embedded Node 18), so ABI-108 load alone isn't proof — load the wrapper +
   open/key + reopen (correct **and** wrong key) + `PRAGMA rekey` must be exercised **on physical
   hardware** under the embedded Node 18.20.4 (see [01](01-sqlite-migration.md)). The plain-prebuild
   half is already proven on-device (phase 2 stretch goal).
4. ~~`LocalOnlyHotspot` native module returning SSID/password~~ — **done** (`apps/app/modules/loam-hotspot`);
   emulator-verified end to end (the API-35 emulator's virtual WiFi returned a real SSID/passphrase).
   Physical-device SoftAP behaviour may differ, so the two-phone join below remains the owner's test.
5. WebView loading the served client over the hotspot, with cookies + WebSocket working end to end —
   **needs a physical device** (a second phone joins the hotspot and opens `http://192.168.49.1:3000`).

Only after those pass is the QR/host UI mostly glue over `packages/qr`.

### Physical-device test (owner)
The emulator can't create a real hotspot (no WiFi radio), so the end-to-end join is a two-phone test:
1. Install + launch the APK; wait for LOAM to load, tap **Share · Host**, and grant the permission
   prompt(s) — location always, plus a nearby-WiFi-devices prompt on Android 13+ (API 33+).
2. Confirm **Step 1** shows a real SSID + password. On a second phone, scan the Step-1 WiFi QR (or type
   the creds) to join the hotspot.
3. Once connected, scan the **Step-2** QR (`http://192.168.49.1:3000`) → LOAM opens over the hotspot.
4. Post a message from the second phone; confirm it appears on the host (proves the WS/LAN path).

## Open questions
- ~~Server hosting model~~ — settled: embedded Node (spike-verified twice, incl. the real server).
- ~~Co-locate the RN app in this monorepo?~~ — settled by action: `apps/app`.
- ~~The "two hotspot QR codes"~~ — settled: WiFi-join QR + LOAM-URL QR, shown sequentially.
- ~~Fastify 5 vs pin fastify@4~~ — settled: Fastify 5 works on the embedded Node 18.
- iOS in scope at all for v1? (Recommend no.)
