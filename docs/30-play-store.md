# 30 — Google Play readiness

> **Status: current working checklist** (audited 25 September 2026; large-screen section added 9 October
> for 0.6.0). Nothing has been uploaded to Play yet. The in-repo blockers are closed; what remains is the
> owner's work in the Play Console (the first internal-testing upload, Play App Signing, the H1 and H2
> declarations, Data safety, the listing copy and the large-screen form factors) and the device run in
> [docs/21](21-device-verification-checklist.md).
> The 0.5.0 `versionCode` note below is history: 0.6.0 is `versionCode` 8.

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
- **Update notice, not self-updating.** The AAB (`-PloamDistribution=play`, `modules/loam-updates`) links
  Google's `app-update` library and, on the opening setup screen only, asks the Play Store app whether a newer
  version exists; "Update" opens the Play listing. The APK on GitHub Releases (`github`) contains no Play code
  and has a tap-only "Check for updates" (GitHub's latest-release API, version tag only; "Download" opens the
  releases page). Neither downloads or installs anything, so Play's rule against updating outside Play holds.
- **Member rules (UGC policy: "accept the terms before creating content").** A person's first view of a
  network is the client's Welcome screen (`components/WelcomeScreen.tsx`): their random name and avatar ("Try
  another name" until they first agree), the rules in one sentence, a link to `/rules` (served by the node,
  offline, in the network's language) and one button, "I'm 18 or over, and I agree". The server records
  `user.rulesVersion` (`POST /api/users/me/rules`, `MEMBER_RULES_VERSION`) and refuses posts, reactions,
  uploads, typed names and new channels without it (`rules_not_accepted`); reading, reporting and blocking stay
  open. The rules name the prohibited content (harassment, threats, hate, sexual content involving anyone
  under 18, non-consensual intimate images, private details, scams, malware, spam) without a blanket "obey
  local law".
- **Moderation that works.** A message report shows moderators the reported message (text, attachment names,
  author, where), read live so it never outlives the network's own deletion/retention; the report dialog says
  moderators will see it. "Escalate" keeps the report open for admins (`status: "escalated"`). Moderators and
  admins get a live count on People (`reportsChanged`).
- **Adults only + child safety standards.** LOAM targets 18+: block minors with the Play Console tools (the
  Anonymous/Random Chat policy), and members confirm 18+ on the Welcome screen (browser joiners never pass
  Play). Child Safety Standards (they apply regardless of age gating): published at
  `loamnet.com/child-safety` (`apps/site/child-safety.html`); in-app concern route = the Settings email line;
  point of contact = Joseph Maynard, opensource@magiczebra.co.uk; hosts are told once (Android setup, the
  `loamnet` terminal UI, every plain-mode start) that they're responsible for their network and must remove
  and report child abuse material. **Owner:** complete the Console declarations.
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
- Cleartext HTTP is allowed only to loopback (`localhost`, `127.0.0.1`: the host's own WebView and the
  launcher reaching the embedded server) through `res/xml/network_security_config.xml`, generated by the
  config plugin; the base config refuses cleartext, and the app's other connections (model downloads, the
  GitHub update check) are HTTPS. The embedded Node server's own sockets are not subject to that config.
  Joiners' phones reach the server from their own browsers, not through this app. Not debuggable; no `QUERY_ALL_PACKAGES` / battery-optimisation /
  background-location permissions. Only the launcher activity is exported; it carries the `loam://` VIEW
  filter Expo Router needs, and `src/app/+native-intent.tsx` sends every incoming URL to the host screen.
  Kiosk mode is plain `startLockTask()`, not device-owner. No accounts, so the account-deletion
  requirement doesn't apply.
- **No backup or device transfer.** `allowBackup=false` + `fullBackupContent=false` (API < 31) and a
  `dataExtractionRules` resource that excludes every domain from cloud backup **and** Android 12+
  device-to-device transfer (which `allowBackup=false` alone doesn't stop at targetSdk 36). Verified in
  the generated manifest; the transfer exclusion itself hasn't been exercised on a phone.
- **No payments in the app.** No in-app purchases and no donation link (Play's Payments policy forbids
  pointing to outside payment from inside an app). Donations go through Ko-fi
  (`ko-fi.com/magiczebra`), linked only from the website, the README and `.github/FUNDING.yml`; the app's
  About screen and Settings link to loamnet.com, never to Ko-fi.

## Blockers

| | Item | State |
|---|---|---|
| B1 | **App Bundle.** Play only takes an `.aab` for new apps. | **Built in CI:** `pnpm --filter app aab` runs `bundleRelease` after the APK → `apps/app/loam-host.aab`, and refuses to build without `keystore.properties` (no debug-signed bundle). `build-apk.yml` runs it on every `v*` tag and uploads the bundle as the `loam-host-aab` workflow artifact (not attached to the GitHub Release, which still carries only the APK). **Remaining:** one end-to-end upload of that bundle to an internal-testing track. **Owner:** enrol in Play App Signing; the repo keystore (`pnpm --filter app keystore`) becomes the **upload** key. |
| B2 | **Privacy policy.** Play **requires** a public privacy-policy URL in the listing **and** a link inside the app. | **Done:** `apps/site/privacy.html`, served at `/privacy` and linked from the landing-page footer; it covers the app (no accounts or analytics; data stays on the host device unless the operator enables sync, a remote assistant or mesh; retention; Emergency Reset; Android permissions) and the website separately. In-app: the node serves the app section of the policy itself at `/privacy` (the client's `views/PrivacyView.tsx`, text in `lib/privacy-policy.ts`, kept in step with the website), linked from the client's Settings and opened by the Android host menu in its own WebView, so it reads offline and never sends anyone to another website. **Owner:** put the URL in the listing. |
| B3 | **User blocking.** Play's user-generated-content policy expects in-app **block** as well as report. | **Fixed.** Each member has a private server-side block list (`user_blocks`; `GET /api/users/me/blocks`, `PUT`/`DELETE /api/users/me/blocks/:userId`), never broadcast or synced, cleared by Emergency Reset. The server refuses DMs, DM reactions, edits of older DMs and DM typing across a block in both directions; the blocked sender gets a generic "not available" answer that doesn't state the reason, and private-channel invites and ownership transfers across a block are refused the same way. The client puts **Block** beside **Report this user** in the DM header, shows a blocked DM read-only with Unblock, collapses a blocked person's channel posts and replies to a placeholder (Show reveals one), drops their reactions, typing, toasts and unread counts, and lists blocked people in Settings to unblock. Limits are in docs/12 §5 (mesh senders can't be blocked; the blocked person can infer it). |

## Declarations and high-risk items

| | Item | State |
|---|---|---|
| H1 | **Foreground service type.** `connectedDevice` FGS needs a Play Console declaration + a short demo video. A reviewer may argue "serving nearby phones over a hotspot" is `specialUse`; be ready to justify (`connectedDevice` covers the hotspot/Wi-Fi Aware/BLE links) or to switch type and add `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`. | **Open — owner (Console).** The service itself is now re-asserted whenever the app is in the foreground (API 31+ refuses a start from the background) and `POST_NOTIFICATIONS` is requested once; both still need a device run (docs/21 §3). |
| H2 | **Location permission** → location-permission declaration. Location is only needed below API 33; on 33+ `NEARBY_WIFI_DEVICES` (`neverForLocation`) suffices. The hotspot now requests *only* `NEARBY_WIFI_DEVICES` on 33+ (`src/lib/hotspot-permissions.ts`), and the plugin caps `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` at `maxSdkVersion="32"` (docs/04, LocalOnlyHotspot permissions). | **Built, emulator-checked; needs a real device** (API 33+ and Android 12) to verify. The manifest still lists location for API 32 and below, so keep the declaration filed ("create a local-only Wi-Fi hotspot on Android 12 and older") unless Play stops asking for it. |
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
- **Device filtering — fixed.** Wi-Fi, Wi-Fi Aware, location (+ GPS/network), Bluetooth/BLE, the camera
  and the touchscreen (`touchscreen` + `faketouch`) are declared `uses-feature … required="false"`, so
  tablets, Chromebooks and Android laptops without them see the listing (no hotspot / no mesh / no scanner
  there). Both screen orientations are declared optional as well: LOAM locks none, but Google's code
  scanner (through expo-camera) merges in a portrait-locked activity, which on its own would make the APK
  require a portrait screen (see "Large screens and Android laptops" below).
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
  action SHAs weekly (`github-actions` ecosystem). The release also carries `loam-host.apk.sha256`, and a
  separate `attest` job (the only one with `id-token: write` and `attestations: write`) records signed
  build provenance for the APK and the AAB; check either with
  `gh attestation verify <file> --repo MagicZebraLtd/loam` before installing or uploading it.
- Predictive back is opted out (`predictiveBackGestureEnabled: false`) — fine for now, revisit later.

## Large screens and Android laptops

What the build declares (read it back in the generated `apps/app/android/app/src/main/AndroidManifest.xml`
after a prebuild):

- **No orientation lock.** `app.json` `orientation: "default"` → `android:screenOrientation="unspecified"`,
  so the host runs in portrait and landscape. Play ranks and badges apps that resize well, aren't
  letterboxed and support both orientations, and warns on listings that lock one; Android 16 ignores an
  orientation lock, `resizeableActivity` and aspect-ratio limits on displays of 600dp and up for apps
  targeting API 36 (LOAM does), so the old portrait lock was already a no-op on tablets and laptops.
- **`android:resizeableActivity="true"`** on `MainActivity` (`plugins/with-loam-host.js`), Expo's
  `configChanges` kept, so split-screen, freeform and desktop windows resize the app without recreating it.
- **`android.hardware.touchscreen` and `android.hardware.faketouch` `required="false"`**, as Google's
  Chromebook/laptop guidance asks: every app implies a required touchscreen otherwise, which hides it from
  devices with only a keyboard and trackpad. Every native control is a `Pressable`/`TextInput` with a role
  (mouse clicks, keyboard focus, Enter on the text fields); the WebView handles both itself.
- **`android.hardware.screen.portrait` and `screen.landscape` `required="false"`.** The main activity
  locks no orientation, but Google's code scanner, merged in through expo-camera, ships
  `GmsBarcodeScanningDelegateActivity` with `android:screenOrientation="portrait"`, which makes the built
  APK imply a required portrait screen. Read the merged manifest
  (`apps/app/android/app/build/intermediates/merged_manifests/release/`) to see it; the generated source
  manifest doesn't contain library activities.
- **Nothing else that would exclude a laptop or tablet**: no `supports-screens`, no `telephony`, no
  required radio or camera (all optional, above).
- A LocalOnlyHotspot on a laptop depends on its Wi-Fi hardware, so **Wi-Fi mode is the expected path
  there**; with no Wi-Fi it hosts on the laptop's wired network (docs/04 "Hosting modes").

**Owner (Play Console):**

1. In the app's form factors, declare **Tablet** and **Chromebook** support beside Phone (Android laptops
   fall under the same large-screen program).
2. Upload at least **four tablet** screenshots (the 7-inch and 10-inch sets) and at least **four
   Chromebook** screenshots, each **16:9**, of the host in landscape with the WebView showing the client's
   desktop layout (the join screen, display mode, a channel, the admin area), beside the phone set.
3. After uploading the bundle, read the **pre-launch report**'s large-screen quality section
   (letterboxing, orientation, resizing, keyboard and mouse) and the large-screen warnings on the listing
   dashboard, and fix what it flags before promoting.
4. Add a tablet and a Chromebook or Android laptop (or the emulator's tablet and desktop profiles) to the
   device run (docs/21): rotate while hosting, resize with display mode on, open the menu and the recovery
   screens in a short window, and host from a wired-only laptop in Wi-Fi mode.

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
2. Console paperwork: Play App Signing, Data safety, **Target audience = 18 and over only** (LOAM is
   adults-only: the Welcome screen's "I'm 18 or over" and ACCEPTABLE_USE.md), content rating (users
   interact, unmoderated chat), the **Child Safety Standards** declaration (the published standards page
   `loamnet.com/child-safety` and its point of contact), FGS declaration + video (H1), location
   declaration or the device-verified cap (H2).
3. Closed testing, then production. Magic Zebra Ltd's developer account (set up 2026-10-08) is an
   **organisation** account, so the 12-tester / 14-day closed test that newer personal accounts need doesn't
   apply: internal testing can go straight to production once the device run passes.
