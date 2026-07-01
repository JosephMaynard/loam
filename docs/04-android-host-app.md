# 04 — Android host app (React Native)

## Goal

An Android app that turns a phone into a LOAM host: it brings up a local WiFi hotspot, shows QR codes
so nearby people can (a) join the hotspot and (b) open LOAM once connected, and presents all other UI by
loading the **existing LOAM web client in a WebView**. iOS is secondary (hotspot control is far more
restricted there).

## What already exists

A sibling Expo project at `../react-native-test-app` (separate git repo, single "Initial commit"). It is
the **stock Expo Router tabs starter** — Expo SDK **52**, React Native **0.76.6** — and already includes
the two dependencies that matter here: **`react-native-webview` 13.12.5** and `expo-web-browser`. There
is **no LOAM-specific code, no hotspot/native module, and no embedded server** yet. It is currently a
**managed** Expo app (`expo-router/entry`, no `android/` project checked in).

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
Expo (prebuild) is accepted (see [decisions.md](decisions.md) #2). The compounding risk to spike first:
**encryption at rest is also required (decision #1), so an encrypted SQLite driver must build under
nodejs-mobile** — the hardest single unknown in the whole roadmap. If SQLCipher/libsql won't compile
there, fall back to application-level encryption over `node:sqlite` (see 01). Verify this before building
any host UI.

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

## Suggested first spikes (de-risk before building UI)
1. **Encrypted SQLite under nodejs-mobile** — Expo prebuild + `nodejs-mobile-react-native` running the
   current `apps/server` on-device, with a SQLCipher/libsql (or app-level-encrypted) DB. This is the
   highest-risk unknown (decisions #1 + #2 combined); prove it before anything else.
2. `LocalOnlyHotspot` native module returning SSID/password.
3. WebView loading the served client over the hotspot, with cookies + WebSocket working end to end.

Only after those three pass is the QR/host UI mostly glue over `packages/qr`.

## Open questions
- Server hosting model (option 1 vs 3) and OK to leave managed Expo? — see [decisions.md](decisions.md).
- What exactly are the "two hotspot QR codes"?
- Co-locate the RN app in this monorepo, or keep separate?
- iOS in scope at all for v1? (Recommend no.)
