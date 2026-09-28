# 30 — Google Play readiness

Status of publishing the Android host (`apps/app`, package `com.loamnet.host`) on Google Play. Audited
2026-09-19 (updated 2026-09-25 after the pre-release fixes) against the release APK (`aapt2 dump badging`, `zipalign -c -P 16`, `llvm-readelf -lW` on every
native lib) and the generated manifest. Play's thresholds move — **confirm the current target-API level
and declaration forms in the Play Console before submitting.** The GitHub-Releases APK stays the sideload
channel; Play is an additional one.

**Where it stands (2026-09-25).** The in-repo blockers are closed: blocking (B3) and the in-app privacy links
(B2) shipped, and tag builds produce the Play bundle (B1). What's left is outside the code: one upload of
that bundle to internal testing, the Console declarations and listing copy (H1, H2, H6, Data safety), the
device checks below, and size headroom before a production track.

## Verified fine

- **Target API.** `targetSdk 36 / compileSdk 36 / minSdk 24` (Expo SDK 57 defaults), confirmed in the APK.
- **16 KB page size.** Every `lib/arm64-v8a/*.so` (`libnode.so` from the @comapeo fork, all `librnllama*`,
  `libreactnative.so`) and both vendored `better_sqlite3.node` prebuilds report LOAD `p_align 0x4000`;
  `zipalign -c -P 16` passes. The only `0x1000` files are Hexagon **DSP** blobs under `assets/`, outside the
  check. **Re-verify after any llama.rn, nodejs-mobile or SQLite-prebuild bump.**
- **No dynamic code.** expo-updates absent; the server bundle is built at build time; no `eval`. The on-device
  model download is *data* (GGUF), which policy allows.
- **No telemetry** in the app or server (PostHog is marketing-site only). For Data safety, "No data
  collected" holds **only while no path sends user data off the host device**: the default build keeps
  messages, avatars and attachments on the phone and its hotspot LAN, and the on-device LLM runs locally.
  It stops holding once the operator configures a path off the device — `llm.ollama.baseUrl` pointed at
  another machine (DM text to the assistant goes there) or a sync peer (public-channel posts, their attachments and
  their authors' display names and avatar settings are copied to that node). If the listing should cover those configurations, declare the
  transmitted types (messages, user-generated content, name/avatar) as **collected**, and as **optional**
  only if every user can use the app without them. Sync is operator-initiated, not a per-user action, so the
  "user-initiated transfer" exemption doesn't obviously apply; the service-provider exemption needs a
  developer-instructed processor, which an operator's own peer isn't. Loopback traffic between the launcher
  and the embedded server stays inside the app and isn't sharing.
- Cleartext to loopback/LAN is allowed; not debuggable; no `QUERY_ALL_PACKAGES` / battery-optimisation /
  background-location permissions. Only the launcher activity is exported; it carries the `loam://` VIEW
  filter Expo Router needs, and `src/app/+native-intent.tsx` sends every incoming URL to the host screen.
  Kiosk mode is plain `startLockTask()`, not device-owner. No accounts, so the account-deletion
  requirement doesn't apply.
- **No backup or device transfer.** `allowBackup=false` + `fullBackupContent=false` (API < 31) and a
  `dataExtractionRules` resource that excludes every domain from cloud backup **and** Android 12+
  device-to-device transfer (which `allowBackup=false` alone doesn't stop at targetSdk 36). Verified in
  the generated manifest; the transfer exclusion itself hasn't been exercised on a phone.

## Blockers

| | Item | State |
|---|---|---|
| B1 | **App Bundle.** Play only takes an `.aab` for new apps. | **Built in CI:** `pnpm --filter app aab` runs `bundleRelease` after the APK → `apps/app/loam-host.aab`, and refuses to build without `keystore.properties` (no debug-signed bundle). `build-apk.yml` runs it on every `v*` tag and uploads the bundle as the `loam-host-aab` workflow artifact (not attached to the GitHub Release, which still carries only the APK). **Remaining:** one end-to-end upload of that bundle to an internal-testing track. **Owner:** enrol in Play App Signing; the repo keystore (`pnpm --filter app keystore`) becomes the **upload** key. |
| B2 | **Privacy policy.** Play **requires** a public privacy-policy URL in the listing **and** a link inside the app. | **Done:** `apps/site/privacy.html`, served at `/privacy` and linked from the landing-page footer; it covers the app (no accounts or analytics; data stays on the host device unless the operator enables sync, a remote assistant or mesh; retention; Emergency Reset; Android permissions) and the website separately. In-app links: **Privacy policy** in the client's Settings and in the Android host menu (`src/constants/links.ts`), both opening `https://loamnet.com/privacy` in the browser (it won't load while the phone is offline). **Owner:** put the URL in the listing. |
| B3 | **User blocking.** Play's user-generated-content policy expects in-app **block** as well as report. | **Fixed.** Each member has a private server-side block list (`user_blocks`; `GET /api/users/me/blocks`, `PUT`/`DELETE /api/users/me/blocks/:userId`), never broadcast or synced, cleared by Emergency Reset. The server refuses DMs, DM reactions, edits of older DMs and DM typing across a block in both directions; the blocked sender gets a generic "not available" answer that doesn't state the reason, and private-channel invites and ownership transfers across a block are refused the same way. The client puts **Block** beside **Report this user** in the DM header, shows a blocked DM read-only with Unblock, collapses a blocked person's channel posts and replies to a placeholder (Show reveals one), drops their reactions, typing, toasts and unread counts, and lists blocked people in Settings to unblock. Limits are in docs/12 §5 (mesh senders can't be blocked; the blocked person can infer it). |

## Declarations and high-risk items

| | Item | State |
|---|---|---|
| H1 | **Foreground service type.** `connectedDevice` FGS needs a Play Console declaration + a short demo video. A reviewer may argue "serving nearby phones over a hotspot" is `specialUse`; be ready to justify (`connectedDevice` covers the hotspot/Wi-Fi Aware/BLE links) or to switch type and add `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`. | **Open — owner (Console).** The service itself is now re-asserted whenever the app is in the foreground (API 31+ refuses a start from the background) and `POST_NOTIFICATIONS` is requested once; both still need a device run (docs/21 §3). |
| H2 | **`ACCESS_FINE_LOCATION` uncapped** → location-permission declaration. It is only needed below API 33; on 33+ `NEARBY_WIFI_DEVICES` (`neverForLocation`) suffices. Capping it again needs `src/hooks/use-hotspot.ts` to request *only* `NEARBY_WIFI_DEVICES` on 33+ — the previous attempt capped the manifest without that and broke the hotspot on every API 33+ phone (see the regression note in `plugins/with-loam-host.js`). | Open — **needs a real device** to verify; until then, file the declaration ("create a local-only Wi-Fi hotspot"). |
| H3 | Unused template permissions (`SYSTEM_ALERT_WINDOW`, `READ/WRITE_EXTERNAL_STORAGE`). | **Fixed** — `android.blockedPermissions` in `app.json`. |
| H4 | **Model download size** (0.8–4.5 GB). Legal, but must not surprise: show size + a Wi-Fi/metered warning before download; mention it in the listing. | **Fixed** — every catalog or custom-URL download asks first, stating the size (or that a custom model's is unknown) and warning about mobile/metered data (unconditionally: the app has no network-type API); the catalog shows the size range up front. Mentioning it in the listing is owner copy (H6). |
| H5 | **Report a user** was unreachable (server + dialog existed, nothing opened it). | **Fixed** — "Report this user" in the DM header. |
| H6 | **Listing framing.** Lead with operator-run moderation (report queue, ban/shadow-ban/timeout, join approval) and the emergency/community positioning in `MISSION.md`; "Emergency Reset", never anti-forensics language. | Owner (listing copy). |

## Should fix before a production track

- **Size headroom (open).** ~172 MB compressed against Play's 200 MB base-module limit: `libnode.so` ≈ 50 MB
  and ≈ 73 MB of `librnllama*` CPU variants; R8 is off (≈ 44 MB dex). Levers:
  - **llama.rn variants.** llama.rn picks its library from the CPU flags (dotprod+i8mm(+Hexagon/Adreno) →
    dotprod → i8mm → fp16 → v8), so all but one variant can be selected on some phone. The exception is
    `librnllama_v8_2_i8mm.so` (≈ 9.4 MB: i8mm without dotprod, which shipping arm64 cores don't have), so
    pruning buys little.
  - **R8** (`android.enableMinifyInReleaseBuilds`) needs keep rules first for the JNI/reflection entry
    points it can't see: nodejs-mobile (`com.janeasystems.rn_nodejs_mobile`), llama.rn (`com.rnllama`) and
    the two local Expo modules (`expo.modules.loamhotspot`, `expo.modules.loammeshtransport`). Then a full
    device run (boot, hotspot, model load, mesh) before it can ship.
- `CHANGE_NETWORK_STATE` was missing although the Wi-Fi Aware data path calls `requestNetwork()` — **fixed**
  in `plugins/with-loam-host.js` (still device-unverified, like the rest of Phase 3).
- **Themed icon.** `monochromeImage` **added** (a white wordmark on transparent). Still open: a proper
  adaptive foreground layer (the same PNG serves icon, adaptive foreground and favicon).
- **Device filtering — fixed.** Wi-Fi, Wi-Fi Aware, location (+ GPS/network), Bluetooth/BLE and the
  portrait screen (implied by `orientation: "portrait"`) are declared `uses-feature … required="false"`, so
  tablets/Chromebooks without them see the listing (no hotspot / no mesh there).
- **`versionCode` — checked in CI.** Still hand-edited in `app.json`, but `scripts/check-versions.mjs
  --release-tag` fails a tag build unless the tag's `X.Y.Z` equals the manifest version and `versionCode`
  is greater than that of **every** earlier release tag (read from each tag's `app.json`); `ci.yml` checks
  on every push/PR that all manifest versions agree. Tests: `scripts/check-versions.test.mjs`.
  **Release candidates:** tag `vX.Y.Z-rc.N` (or `-beta.N`) with the manifests still at `X.Y.Z`. It gets the
  same keystore/test gates and the AAB for internal testing, and is published as a GitHub **pre-release**.
  Play never takes a `versionCode` twice, so each RC needs its own and the final `vX.Y.Z` a higher one.
  **For 0.5.0:** v0.4.0 shipped `versionCode` 6, so the first 0.5.0 tag needs **≥ 7** (bumped to 7 on this
  branch), and if an RC is tagged first, the final v0.5.0 needs more than that RC's.
- **Release workflow hardened.** Every action in `build-apk.yml`/`ci.yml` is pinned to a commit SHA,
  checkouts don't persist the token, the build job is read-only, and a separate release job (`contents:
  write`, runs no repo code) attaches the APK. Keystore secrets reach only the signing step; a tag build
  fails without them and runs `pnpm test` + the app typecheck before building. Dependabot bumps the pinned
  action SHAs weekly (`github-actions` ecosystem).
- Predictive back is opted out (`predictiveBackGestureEnabled: false`) — fine for now, revisit later.

## Still needs a physical device

Several shipped features are verified only in code and CI; running them on a phone is the remaining release
gate (checklist: [docs/21](21-device-verification-checklist.md)): the SQLCipher driver's load and
`PRAGMA key`/rekey under the embedded Node 18 (docs/01), the foreground service and notification prompt
(H1), the location-permission cap (H2), the Wi-Fi Aware/BLE mesh transport (docs/17), and an R8-minified
build if that lands.

## Submission order

1. Take the `loam-host-aab` artifact from a tag build (or run `pnpm --filter app aab` locally) and upload
   it to **internal testing** (this also reserves the package name — `com.loamnet.host` is permanent after
   the first upload; be sure the identity is the one you want).
2. Console paperwork: Play App Signing, Data safety, content rating (user interaction + unmoderated chat →
   expect Teen/16+), FGS declaration + video (H1), location declaration or the device-verified cap (H2).
3. Closed testing, then production. (Newer *personal* developer accounts must run a closed test before
   production access; an organisation account is exempt — check which applies.)
