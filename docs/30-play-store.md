# 30 — Google Play readiness

Status of publishing the Android host (`apps/app`, package `com.loamnet.host`) on Google Play. Audited
2026-09-19 against the release APK (`aapt2 dump badging`, `zipalign -c -P 16`, `llvm-readelf -lW` on every
native lib) and the generated manifest. Play's thresholds move — **confirm the current target-API level
and declaration forms in the Play Console before submitting.** The GitHub-Releases APK stays the sideload
channel; Play is an additional one.

## Verified fine

- **Target API.** `targetSdk 36 / compileSdk 36 / minSdk 24` (Expo SDK 57 defaults), confirmed in the APK.
- **16 KB page size.** Every `lib/arm64-v8a/*.so` (`libnode.so` from the @comapeo fork, all `librnllama*`,
  `libreactnative.so`) and both vendored `better_sqlite3.node` prebuilds report LOAD `p_align 0x4000`;
  `zipalign -c -P 16` passes. The only `0x1000` files are Hexagon **DSP** blobs under `assets/`, outside the
  check. **Re-verify after any llama.rn, nodejs-mobile or SQLite-prebuild bump.**
- **No dynamic code.** expo-updates absent; the server bundle is built at build time; no `eval`. The on-device
  model download is *data* (GGUF), which policy allows.
- **No telemetry** in the app or server (PostHog is marketing-site only). "No data collected" is defensible
  for Data safety — caveat: an operator can point `llm.ollama.baseUrl` or a sync peer off-LAN.
- Cleartext to loopback/LAN is allowed; `allowBackup=false`; not debuggable; only the launcher activity is
  exported; no `QUERY_ALL_PACKAGES` / battery-optimisation / background-location permissions. Kiosk mode is
  plain `startLockTask()`, not device-owner. No accounts, so the account-deletion requirement doesn't apply.

## Blockers

| | Item | State |
|---|---|---|
| B1 | **App Bundle.** Play only takes an `.aab` for new apps. | **Build path added:** `pnpm --filter app aab` runs `bundleRelease` after the APK → `apps/app/loam-host.aab`. *Not yet exercised end-to-end* — run it once and upload to an internal-testing track. **Owner:** enrol in Play App Signing; the repo keystore (`pnpm --filter app keystore`) becomes the **upload** key. Add the AAB to `build-apk.yml` once the local run is proven. |
| B2 | **Privacy policy.** Play needs a public URL (and the app should link it). `apps/site` has no `/privacy`. | **Open — owner text.** The honest content is short: no accounts, no analytics, nothing leaves the host device/LAN unless the operator configures a remote LLM or sync peer; what the host stores (messages, avatars, attachments) and how Emergency Reset / retention remove it. |
| B3 | **User blocking.** Play's user-generated-content policy expects in-app **block** as well as report. There is report + operator ban/shadow-ban/timeout, but a joiner cannot block another user. | **Open — next feature branch.** Minimum: per-user block list (server-side, per session user), the server refuses DMs from a blocked user, the client hides a blocked user's messages, a Block control beside Report in the DM header, and a list to unblock in Settings. |

## Declarations and high-risk items

| | Item | State |
|---|---|---|
| H1 | **Foreground service type.** `connectedDevice` FGS needs a Play Console declaration + a short demo video. A reviewer may argue "serving nearby phones over a hotspot" is `specialUse`; be ready to justify (`connectedDevice` covers the hotspot/Wi-Fi Aware/BLE links) or to switch type and add `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`. | Owner (Console). |
| H2 | **`ACCESS_FINE_LOCATION` uncapped** → location-permission declaration. It is only needed below API 33; on 33+ `NEARBY_WIFI_DEVICES` (`neverForLocation`) suffices. Capping it again needs `src/hooks/use-hotspot.ts` to request *only* `NEARBY_WIFI_DEVICES` on 33+ — the previous attempt capped the manifest without that and broke the hotspot on every API 33+ phone (see the regression note in `plugins/with-loam-host.js`). | Open — **needs a real device** to verify; until then, file the declaration ("create a local-only Wi-Fi hotspot"). |
| H3 | Unused template permissions (`SYSTEM_ALERT_WINDOW`, `READ/WRITE_EXTERNAL_STORAGE`). | **Fixed** — `android.blockedPermissions` in `app.json`. |
| H4 | **Model download size** (0.8–4.5 GB). Legal, but must not surprise: show size + a Wi-Fi/metered warning before download; mention it in the listing. | Open — small UI change. |
| H5 | **Report a user** was unreachable (server + dialog existed, nothing opened it). | **Fixed** — "Report this user" in the DM header. |
| H6 | **Listing framing.** Lead with operator-run moderation (report queue, ban/shadow-ban/timeout, join approval) and the emergency/community positioning in `MISSION.md`; "Emergency Reset", never anti-forensics language. | Owner (listing copy). |

## Should fix before a production track

- **Size headroom.** ~172 MB compressed against Play's 200 MB base-module limit: `libnode.so` ≈ 50 MB and
  ≈ 73 MB of `librnllama*` CPU variants; R8 is off (≈ 44 MB dex). Levers: prune llama.rn variants to the ones
  arm64-v8a phones actually select, enable R8 (`android.enableMinifyInReleaseBuilds`) and re-test.
- `CHANGE_NETWORK_STATE` was missing although the Wi-Fi Aware data path calls `requestNetwork()` — **fixed**
  in `plugins/with-loam-host.js` (still device-unverified, like the rest of Phase 3).
- **Themed icon.** Add a `monochromeImage` to `android.adaptiveIcon`, and a proper foreground layer (the
  same PNG currently serves icon, adaptive foreground and favicon).
- **Device filtering.** The permissions imply `android.hardware.location` / `wifi` as *required*; add
  `uses-feature … required="false"` if tablets/Chromebooks without them should see the listing.
- **`versionCode`** is hand-edited in `app.json`; Play rejects a reused code. Bump it from the tag workflow.
- Predictive back is opted out (`predictiveBackGestureEnabled: false`) — fine for now, revisit later.

## Submission order

1. Prove `pnpm --filter app aab` and upload to **internal testing** (this also reserves the package name —
   `com.loamnet.host` is permanent after the first upload; be sure the identity is the one you want).
2. B2 privacy policy page + link, B3 block feature, H4 download disclosure.
3. Console paperwork: Play App Signing, Data safety, content rating (user interaction + unmoderated chat →
   expect Teen/16+), FGS declaration + video (H1), location declaration or the device-verified cap (H2).
4. Closed testing, then production. (Newer *personal* developer accounts must run a closed test before
   production access; an organisation account is exempt — check which applies.)
