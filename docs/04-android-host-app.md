# 04 — Android host app (React Native)

> **Status: RUNS ON-DEVICE ✅ + HOTSPOT JOIN UI ✅.** Landed on `feat/android-host-runnable`: a
> release APK boots the **real embedded LOAM server** inside `@comapeo/nodejs-mobile-react-native`'s
> Node 18 and shows the **LOAM web client in a WebView** — verified on an arm64 API-35 emulator.
> On-device proof: `Server listening on 0.0.0.0:3000`, `GET /api/config` → 200 (session minted),
> `POST /api/messages` → 201 with read-back, and the client rendered live (channels, DMs, avatars,
> "live" WS badge). DB uses plain **better-sqlite3** (unencrypted) via the digidem ABI-108
> android-arm64 prebuild (now vendored in-repo; SQLCipher encryption at rest ships too — see below). Then on `feat/android-hotspot-join`: a **`LocalOnlyHotspot` native module**
> (`apps/app/modules/loam-hotspot`, Kotlin via the Expo Modules API) plus a **host menu** (Invite people, Encryption, AI assistant, rules, privacy, About, Emergency reset)
> above the WebView that opens a modal rendering the two-step QR join flow (`HostShareOverlay` →
> `HostPanel`). Emulator-verified (arm64 API-35): LOAM still loads, the bar's button opens the modal,
> tapping it prompts for `ACCESS_FINE_LOCATION` then `NEARBY_WIFI_DEVICES`, and `startHotspot()` runs.
> This emulator's virtual WiFi actually supported LocalOnlyHotspot, so the **happy path** rendered —
> "Host running", Step 1 with a real SSID/password (`AndroidShare_1065` / a generated passphrase) +
> WiFi QR, and Step 2's LOAM-URL QR (at the time a fixed `192.168.49.1` — wrong, see **The Step-2
> address** below); Done closes back to the WebView.
> Graceful degradation (permission denied / no SoftAP / a callback that never fires) is code-complete
> — `requireOptionalNativeModule` for unlinked runtimes, a native reject on `onFailed`/`SecurityException`,
> a 20s JS start-timeout, and an error message in Step 1 while Step 2's QR stays — but wasn't the path
> this emulator took. The full two-phone join (a second device scans Step 1, connects, scans Step 2) is
> the **physical-device** test. See
> **[Runnable build](#runnable-build)** below for exact commands. **Follow-ups:** on-device verification of
> encryption at rest (it ships, see docs/01); 32-bit `armeabi-v7a`; raising `@loam/qr` capacity for long creds.
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
- Node `24.15.0`, pnpm `10.30.2` (repo pins). A real JDK (Android Studio's JBR:
  `/Applications/Android Studio.app/Contents/jbr/Contents/Home` on macOS — a bare JRE fails "No Java
  compiler found"). Android SDK with platform-tools + NDK r27+ (16KB page alignment). `ANDROID_HOME`
  set; `adb`/`emulator` on `PATH`.

### Build the APK (reproducible)
**Shortcut:** `pnpm --filter app apk` runs every step below in one go (auto-detecting the Studio
JDK/SDK on macOS) and copies the result to `apps/app/loam-host.apk`. The manual steps:
```bash
pnpm install                                   # nodejs-mobile's postinstall is (correctly) blocked by pnpm
pnpm -r build                                  # builds packages + server + web client (client dist is bundled)
pnpm --filter app fetch:native                 # places BOTH SQLite android-arm64 prebuilds (vendored, sha256-checked)
pnpm --filter app bundle:server                # esbuild → nodejs-assets/nodejs-project/{loam-server.js,client,main.js,...}
cd apps/app
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
CI=1 npx expo prebuild --platform android --no-install --clean   # generates android/ (gitignored)
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
# → app/build/outputs/apk/release/app-release.apk (signed with the debug keystore unless you set up signing below)
```

Order matters: `fetch:native` must run before `bundle:server`, which **fails** if either SQLite prebuild
(plain or SQLCipher) is missing from the embedded project — an APK without the SQLCipher driver would
lock every encrypted node. `LOAM_ALLOW_MISSING_NATIVE=1` skips that check for a desktop-only smoke bundle
(never for an APK). `pnpm --filter app apk` also materialises llama.rn's prebuilt native libs, which a
plain `pnpm install` may skip.

**Stale-prebuild guard.** `android/` is generated and gitignored, so a direct `./gradlew` on an old one
would ship its old manifest. The config plugin stamps `android/loam-prebuild.sha256` (a hash of `app.json`
+ `plugins/*.js`) at prebuild and adds a Gradle check that fails `preBuild` when they no longer match.
A unit test parses the Groovy hashing back out and checks it against the JS; set
`LOAM_GRADLE_GUARD_TEST=1` (with `gradle` on PATH or `LOAM_GRADLE=<path>`) to also run the guard under a
real Gradle against a JS-written stamp (~15–30 s, so not in CI).
Regenerate with `CI=1 npx expo prebuild --platform android --clean` (the `apk` script always does);
`-PloamSkipPrebuildCheck` bypasses it for local native debugging only.

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
`apps/app/keystore.properties` exists** — with no keystore it's a no-op (and warns once), so the
debug-signed build above keeps working. The build script is stricter: `pnpm --filter app aab` **refuses**
to build without a keystore (Play rejects a debug-signed bundle, and it sets
`LOAM_REQUIRE_RELEASE_SIGNING=1` so the plugin fails prebuild too), and `pnpm --filter app apk` prints a
loud debug-signing banner unless acknowledged with `--debug-signed` or `LOAM_ALLOW_DEBUG_SIGNING=1`.
A debug-signed APK can't update a release-signed install, and each machine's debug key differs. The
tag-triggered `build-apk.yml` job fails outright without the keystore secret; it runs `aab`, attaches the
APK to the GitHub Release and uploads the bundle as the `loam-host-aab` workflow artifact. Tags are
`vX.Y.Z`, or `vX.Y.Z-rc.N` / `vX.Y.Z-beta.N` for a pre-release (same gates and AAB, published as a GitHub
pre-release); `versionCode` must beat every earlier release tag's, pre-releases included. `release.jks` and `keystore.properties` are gitignored; **back them
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
- **Keep the LOAM app in the foreground.** A `connectedDevice` foreground service (`LoamHostService`:
  a "LOAM is hosting" notification + a partial wake lock) keeps the host running with the screen off, but
  API 31+ refuses to *start* one from the background, and the ~80 s cold start makes that likely. So the
  app re-asserts it (`ensureHostService`, idempotent) on `ready`, whenever the app returns to the
  foreground, when the Share overlay opens and when the hotspot comes up. `POST_NOTIFICATIONS` is asked
  once, while the app is in the foreground and before the first start; denying it only hides the
  notification (the overlay says so) and never blocks hosting. Screen-on + app-open is still the most
  reliable state; the FGS path is not yet device-verified.
- **The Step-2 address.** Android assigns a LocalOnlyHotspot a **random** IPv4 address on every start —
  a /24 in 192.168.0.0/16, 172.16.0.0/12 or 10.0.0.0/8 (the /8 ~94% of the time since Android 16), host
  part never .0/.1/.255 (`packages/modules/Connectivity`, `PrivateAddressCoordinator`). There is no fixed
  gateway: `192.168.49.1`, which 0.4.0–0.5.0 hardcoded, is reserved for **Wi-Fi Direct** group owners, so a
  joiner got `ERR_ADDRESS_UNREACHABLE` (Galaxy S25 Ultra, 2026-09-28). No API hands an app the hotspot's
  address, so the native module **discovers** it: `hotspotAddressCandidates()` enumerates every
  (interface, IPv4) pair with two hints — `upstream` (the interface belongs to a network the phone is a
  *client* of, per `ConnectivityManager`, i.e. home Wi-Fi / mobile data / VPN, never the SoftAP) and
  `preexisting` (the address already existed just before `startLocalOnlyHotspot`) — and
  `src/lib/hotspot-address.ts` scores them (new-since-start +4, SoftAP-like name `swlan0`/`ap0`/`wlan1` +3,
  pre-existing −4, private ±1; ≥3 wins). Belt and braces, all automatic: (1) the Wi-Fi *client's* own
  address per `WifiManager` (DHCP/connection info) is ruled out independently of `ConnectivityManager`, and
  a failed native check reports `upstream: null`, never "cleared"; (2) the launcher's `loam-hostinfo`
  carries `interfaces: [{name,address,prefixLength}]` — a second enumeration path to the same kernel data
  (the embedded Node *can* see the AP interface; the older note that it couldn't was wrong) — merged in with
  its own pre-start snapshot (`mergeHotspotCandidates`); (3) a **connected joiner confirms** the interface:
  the launcher polls `GET /api/host/clients` (launcher-only: loopback + host token, like the mesh bridge,
  but not gated on mesh, and exempt from the `required`-mode session gate like the bridge) for the distinct
  peer addresses of admitted WebSockets that are neither loopback nor one of the host's own interface
  addresses (a browser on the host phone opening the hotspot URL is not a joiner), and a candidate whose
  subnet contains one wins outright — proof, not inference (only among *eligible*
  candidates: a laptop on the host's home Wi-Fi never promotes that upstream interface); Step 2 then shows
  **"N phones connected"**, the one signal that the whole path works; (4) when the native check positively
  ruled the phone's own networks out and exactly one private, not-pre-existing candidate is left, it is
  taken even under an unfamiliar interface name. Anything the launcher can't tell (`rndis`/`usb`/`ncm`
  USB tethering, `bt-pan`, `p2p*` Wi-Fi Direct, tunnels, cellular) is never a candidate. `use-hotspot.ts`
  probes on a burst (0 s … 20 s, the AP gets its address a moment after `onStarted`), then every 5 s for
  the first minute, then every 15 s, and re-decides at once when the launcher reports new interfaces or
  joiners; each decision change is one `[loam-hotspot]` line in logcat. Step 2 shows **"Finding the
  hotspot's address…"** until a pick exists, and if none does, the manual route: on the joining phone, the
  hotspot's Wi-Fi details → **Gateway**/Router address (the hotspot's DHCP advertises the host as the
  router) → `http://<gateway>:3000#k=…` (the key fragment is shown), plus a "this host's addresses" line
  (`interface address`).
- **Client isolation.** A few hotspot stacks isolate connected clients from the host; if every
  address fails despite a good WiFi connection, that's the likely cause (device-dependent).

### Hosting modes: hotspot or the phone's Wi-Fi
The Invite people overlay opens with a two-option control, **Hotspot** / **Wi-Fi**, that picks how people
join:

- **Hotspot** (the default) is everything described above: the phone brings up its own
  LocalOnlyHotspot, which needs no router and no internet. It is the default because LOAM is built for
  places without infrastructure.
- **Wi-Fi** hosts on the Wi-Fi network the phone has already joined (home, office, an event's router).
  No hotspot starts, and anyone on the same network scans a single URL QR ("Join on this Wi-Fi"); there
  is no Step 1.

The choice is persisted in `expo-secure-store` under `loam.hostMode` (`src/hooks/use-host-mode.ts` over
the pure, tested `src/lib/host-mode-store.ts`), beside the DB-encryption mode selection; a missing or
unknown value means Hotspot. Switching is live: choosing Wi-Fi releases a running hotspot
(`shutdownHotspot`), and choosing Hotspot starts one through the usual permission flow. Opening the
overlay starts the hotspot **only** when the persisted mode is Hotspot, and not before the stored value
has loaded, so a Wi-Fi host never flashes a hotspot or its permission prompt. The foreground host
service (`ensureHostService`) runs in both modes: in Wi-Fi mode it is asserted as soon as the overlay
opens or the mode switches, since there is no hotspot start to wait for.

**No location permission in Wi-Fi mode.** Nothing in this mode asks for one. The overlay reads the
phone's Wi-Fi state with a new native call, `wifiStationInfo()` → `{ connected, address, ssid }`
(`LoamHotspotModule.kt`; `readWifiStationInfo()` in `modules/loam-hotspot/index.ts` resolves
`{ connected: false }` on any failure and never rejects), on open and every 5 s while the overlay is
showing. `connected` is true when *any* network the phone holds has `TRANSPORT_WIFI` (not only the default
one: on a router with no uplink Android keeps mobile data as the default network while Wi-Fi stays up), or
WifiManager reports a DHCP address. The network name is best effort: Android redacts it to
`<unknown ssid>` unless location permission was already granted (say, by an earlier hotspot start), so
the panel shows "Network: <name>" only when it can, and otherwise says "the Wi-Fi network this phone is
on".

**The advertised address** comes from `pickWifiAddress` (`src/lib/host-mode.ts`, unit-tested), in order:

1. the native station address, the one the router's DHCP gave this phone (`WifiManager.dhcpInfo` /
   `connectionInfo`, the same `stationAddresses()` the hotspot picker uses to rule the station out);
2. else a launcher-reported `wlan<N>` interface with an RFC 1918 address (lowest N first), from
   `loam-hostinfo`'s `interfaces`;
3. else `preferredLanAddress` over the launcher's private addresses, skipping any on a cellular, tunnel or
   tethering interface (carriers hand out 10.x addresses too, so "private" alone isn't enough).

Steps 2 and 3 run only while Android reports a Wi-Fi network (or before the first native read): with Wi-Fi
off — even with a VPN tunnel (`ipsec<N>`, `tun*`…), the phone's own tethering hotspot or a stale AP
interface around — there is no URL and no QR: the card says "Connect this phone
to a Wi-Fi network first", plus any other addresses as "also at". "N phones connected" works in both modes
and remains the proof that the path works.

**Client isolation.** Guest, hotel, café and campus networks often stop devices from reaching each other,
so a joiner there gets a connection error even with a correct address. The Wi-Fi card says so in one
line and points to Hotspot, which doesn't depend on the network's policy.

**Verification status.** The Kotlin compiles (`:loam-hotspot:compileReleaseKotlin`), and the JS side's
parsing, address choice, panel projection and persistence are covered by `host-mode.test.ts` and
`host-mode-store.test.ts`. It has not yet been run on a physical phone: the station read, the SSID
redaction behaviour and the no-internet-router case all need a device test.

### Setup screens

The host app opens on its setup screens (`src/components/setup-wizard.tsx`) every launch, and the
embedded runtime only starts once they finish, so a new network's settings exist before the server first
reads its data folder.

- **First launch:** language (the app's own catalogs, `src/lib/i18n`; also the new node's `node.locale`),
  then the kind of network, its name, and Hotspot or Wi-Fi (the persisted host mode).
- **Later launches:** one screen. If the data folder holds a database that wasn't ephemeral, it offers
  **Continue** (one tap, nothing changes) or **Start a new network**, which takes a press-and-hold to
  erase the old one. If the last network was ephemeral (already unreadable), it offers to start a new one
  with the remembered answers, or to change them.

The three kinds (`src/lib/setup.ts`) are a named security profile (docs/09) plus the identity and
presence flags no profile covers, and a storage mode (docs/01):

| | Private and short-lived | Community | Choose every setting myself |
|---|---|---|---|
| `security.profile` | `hardened` (approval, 1 h messages, kill switch, `required`) | `standard` (open, kept, `optional`) | unchanged defaults |
| Names and photos | off | on | defaults |
| Presence | hidden | shown | default |
| DB encryption mode | `ephemeral` | `persistent` | unchanged |

After setup the host screen opens the share screen (the join codes), or the admin settings for the
third choice.

**Joining another network as a node.** The connection step's third choice, "Join another LOAM network",
makes this phone another node of a running network (docs/11 "Linking nodes"): connect to that network's
Wi-Fi in the phone's settings, then scan the **link code** its host shows (share screen → "Link another
LOAM node", `src/components/link-node.tsx`, which shows the hotspot's Wi-Fi code first) or its admin shows
in the web admin. `src/components/code-scanner.tsx` (expo-camera, QR only) accepts nothing else:
`src/lib/join-code.ts` recognises an ordinary join code ("that's for people; ask for the link code") and
a `WIFI:` code ("join that Wi-Fi first"), and refuses a link code without a key. There is no typed-address
fallback. The new node's config gets the scanned node as an enabled peer with its key pinned and the
code in `linkCode`; it hosts in Wi-Fi mode on the joined network, and its first sync round uses the code
to link both ways. The camera permission is only requested on this step; `RECORD_AUDIO` is blocked and the
camera hardware features are declared optional, so camera-less devices still install.

**How a new network starts.** `prepareNewNetwork` (`src/lib/new-network.ts`) sets the storage mode,
writes it into the launcher's mode hint (`.loam-db-mode-hint`, read back to verify), clears the stored
device keys (so anything of the old network left on flash stays unreadable, and a new passphrase network
gets a new key even from the same passphrase) and queues the starting configuration under a fresh
operation id. Both key items are read first (`snapshotStoredDbKeys`; no snapshot, no change), and the
clear goes last: if the hint or the clear fails (the clear may remove one item before failing on the
other), the keys, the mode and the hint are put back and verified, so a failed preparation leaves the
previous network openable. A rollback that doesn't fully land says so in the error. The hint matters on a fresh install: if the key handoff then fails (a
timeout, a Keystore error), the launcher sees an encrypted choice and locks instead of booting
unencrypted with no hint and no database. The operation rides every `loam-db-key-response` as
`newNetwork { id, config }` until the launcher acknowledges it (`loam-new-network-applied`), so a response
the launcher timed out on is simply resent. main.js applies it through `new-network.js`
`applyNewNetwork` before the boot decision reads the folder: durably write a `.loam-setup-pending` marker
naming the operation, empty the folder (keeping the marker and the mode hint, which already holds the
new network's mode), durably write `config.json`, then record the id in `.loam-setup-applied` and drop
the marker. The same id arriving again is a no-op, so a retry can never empty the network it already
created. If the folder can't be fully emptied or the configuration isn't durably written, the launcher
stays locked (Retry resends it) rather than booting under defaults, and while the marker names an
operation the folder doesn't record (`setupUnfinished`) every boot locks, even one whose key response
didn't bring the operation back: a half-erased folder must never read as a fresh install, which may
start unencrypted (review 2026-10-03 #2). Detecting a previous network errs towards keeping it: an unreadable database counts as
present and an unreadable ephemeral marker as absent. The remembered answers never keep a joining
node's link code (it is single-use), so "start a new one like last time" for a joining phone goes back to
the scan step.

### Native prebuild (SQLite drivers — plain + encrypted)
`fetch:native` (`apps/app/scripts/fetch-native-modules.mjs`) places **both** SQLite native modules
into the embedded project's `node_modules` (the DAL, `apps/server/src/db.ts`, lazy-`require`s whichever
one it needs, so both ship):

- **Plain `better-sqlite3`** (`@12.10.0`, the on-device default): the matching ABI-108 (Node 18)
  android-arm64 binary from `digidem/better-sqlite3-nodejs-mobile` (release `12.10.0`) is **VENDORED**
  at `apps/app/native-prebuilds/better-sqlite3/` and placed at `node_modules/better-sqlite3/build/Release/`.
  It used to be downloaded, but upstream re-generated that release's assets on 2026-08-17
  (non-reproducible build), so the pinned download stopped matching; the vendored file is the
  **original** binary earlier APKs shipped (see that directory's README). To move versions (e.g. back
  to `11.10.0`, the one CoMapeo ships), download and device-test the new asset, then replace the
  tarball and change the npm wrapper version and `PREBUILD_SHA256` together.
- **Encrypted `better-sqlite3-multiple-ciphers`** (`@12.11.1`, SQLCipher; used when
  `security.dbEncryption` is on and a key is handed across the bridge — docs/01): its android-arm64
  ABI-108 binary has no upstream release, so it's a **self-built prebuild VENDORED in the repo** at
  `apps/app/native-prebuilds/multiple-ciphers/` (tarball + reproducible build recipe + README, all
  committed). `fetch:native` extracts it into `node_modules/better-sqlite3-multiple-ciphers/build/Release/`.
  So the encrypted driver **now ships on-device** and `security.dbEncryption` modes take effect on a
  real device build (subject to on-device `PRAGMA key` runtime verification — docs/01). If it still
  won't load, the host screen locks (`db_encryption_driver_missing`: **Retry**, or a confirmed **Start
  without encryption**). The confirmation depends on the mode: in `ephemeral` the launcher has already
  deleted the old database, so it says so; in `persistent`/`passphrase` the encrypted file stays on disk
  and can be preserved (the actions live in `src/lib/driver-missing-recovery.ts`, with tests).

The `.node` binaries themselves are **not committed** in `nodejs-assets/` (gitignored build output) —
re-run `fetch:native` after a clean checkout. `fetch-native-modules.mjs` sha256-verifies **each**
vendored tarball before installing it. Each JS-wrapper npm version and its
`.node` source version must stay in lockstep (change both together).

### What's committed vs generated
- **Committed (source):** `apps/server/src/db.ts` (`driver` option), `embedded.ts`
  (`LOAM_DB_DRIVER`), `apps/app/scripts/{bundle-server.mjs,fetch-native-modules.mjs}`,
  `apps/app/nodejs-project-template/{main.js,package.json}` (the CJS launcher template),
  `apps/app/plugins/with-loam-host.js` (config plugin: cleartext localhost + arm64-only ABIs +
  hotspot/WiFi/FGS permissions + `data_extraction_rules.xml` + optional `uses-feature` + the
  stale-prebuild fingerprint), `apps/app/plugins/with-release-signing.js`, `apps/app/nodejs-assets/BUILD_NATIVE_MODULES.txt` (`0`),
  `apps/app/app.json` (package `com.loamnet.host`, `loam://` scheme, plugin), `apps/app/src/app/index.tsx` (host WebView
  screen + host menu + overlays), `apps/app/src/app/+native-intent.tsx` (incoming-URL policy), `apps/app/src/components/{host-panel,host-share-overlay,
  qr-code}.tsx`, `apps/app/src/hooks/use-hotspot.ts`, **`apps/app/modules/loam-hotspot/`** (the local
  Expo module: `expo-module.config.json`, `index.ts`, `src/*.ts`, `android/build.gradle` +
  `LoamHotspotModule.kt`, `LoamHostService.kt`), `package.json` deps, **`apps/app/native-prebuilds/multiple-ciphers/`** (the
  self-built encrypted-driver prebuild tarball + `build-mc-android-arm64.sh` + `CMakeLists.mc.txt` +
  `README.md` — vendored because no upstream Android/ABI-108 release exists) and
  **`apps/app/native-prebuilds/better-sqlite3/`** (the plain driver's original upstream binary,
  repackaged + README), both sha256-pinned in `fetch-native-modules.mjs`.
- **Generated at build time (gitignored):** `apps/app/android/` (prebuild — local modules are
  autolinked into it, not committed), `apps/app/nodejs-assets/nodejs-project/` (bundle output + web
  client + **both** SQLite native prebuilds, plain + encrypted), `android/loam-prebuild.sha256`, the
  APK/AAB.

### Manifest hardening (config plugin)
- **No backup or device transfer.** `allowBackup=false` + `fullBackupContent=false` cover API < 31, and
  `res/xml/data_extraction_rules.xml` excludes every domain from both `<cloud-backup>` and
  `<device-transfer>`. At targetSdk 31+ `allowBackup=false` alone does **not** stop Android 12+
  device-to-device transfer, which would otherwise copy `loam.db`, avatars, attachments and
  `config.json` to a new phone.
- **Optional hardware.** Wi-Fi, Wi-Fi Aware, location (+ GPS/network), Bluetooth/BLE and the portrait
  screen (implied by `orientation: "portrait"`) are declared `uses-feature required="false"`, so Play
  doesn't hide the listing from devices without them (Chromebooks included); the app degrades (no
  hotspot, no mesh, letterboxed on a landscape-only screen).
- **Unused template permissions blocked** (`SYSTEM_ALERT_WINDOW`, `READ/WRITE_EXTERNAL_STORAGE`, via
  `android.blockedPermissions`), and `CHANGE_NETWORK_STATE` declared for the Wi-Fi Aware data path.
- **Deep links ignored.** `app.json` keeps the `loam://` scheme (Expo Router resolves its root URL
  through it and throws in a release build without one), which also exports a `loam://` VIEW intent
  filter. `src/app/+native-intent.tsx` rewrites every incoming URL to the host screen on launch and
  ignores it afterwards.
- **Themed icon.** `android.adaptiveIcon.monochromeImage` (a white wordmark on transparent).

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

The actual `apps/server` (fastify 5 + @fastify/websocket; static files served by its own `static-files.ts`), esbuild-bundled to
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
permissions via one `PermissionsAndroid.requestMultiple` call **before** starting, tracks a module-scope
singleton state (Android allows one hotspot per process), and never throws: denial/failure lands in an
`error` phase. The request list and the grant rule are the pure, unit-tested
`src/lib/hotspot-permissions.ts`:

- `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` are requested **together on every API level**.
  Android 12+ requires a fine request to carry coarse in the same dialog, and on some Android 12 releases
  a fine-only request is ignored outright (no dialog, a logcat "ACCESS_FINE_LOCATION must be requested
  with ACCESS_COARSE_LOCATION"), which left a fresh install there unable to start the hotspot at all.
- `NEARBY_WIFI_DEVICES` is added from API 33.
- Below API 33 the start needs **fine** location (LocalOnlyHotspot is location-gated there): a user who
  picks "Approximate" on the dialog has denied the hotspot and sees the location message. From API 33
  `NEARBY_WIFI_DEVICES` is what gates `startLocalOnlyHotspot` (the manifest marks it `neverForLocation`),
  so its grant decides and the location answer is not consulted.

The permissions are declared in the manifest by the config plugin (`with-loam-host.js`), coarse beside
fine; a test checks the manifest list covers the runtime request on every API level, since a request for a
permission the manifest does not declare auto-denies with no dialog.

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
> quoted above. Since then the grant rule has moved to `src/lib/hotspot-permissions.ts` and, on API 33+,
> keys on `NEARBY_WIFI_DEVICES` alone (see the list above), so a denied location answer there no longer
> blocks the hotspot; the location request is still issued on every API level, which is why
> `ACCESS_FINE_LOCATION` stays uncapped. Requesting only `NEARBY_WIFI_DEVICES` on API 33+ (and letting
> the cap come back) remains the follow-up.

**Host UI:** `src/app/index.tsx` renders a compact host bar above the LOAM WebView with a **"Share ·
Host"** button (a top bar, not a floating overlay — an Android WebView swallows touches on any native
view layered over it, so an on-top button wouldn't register). It opens `HostShareOverlay` (a
full-screen modal). The overlay starts the hotspot on open and feeds
`{ssid,password}` + the derived Step-2 display (`src/lib/join-display.ts`) into the presentational
`HostPanel`, which shows **Step 1** (WiFi-join QR + SSID/password text) and **Step 2** (LOAM-URL QR +
address text). While the hotspot runs, the join URL is the hotspot's **own discovered address** (see "The
Step-2 address" above — Android assigns it at random per start, so there is nothing to show until it is
found; Step 2 says "Finding the hotspot's address…" meanwhile, and gives the manual Gateway route if it
never is). When the hotspot can't start, `HostPanel` shows the error in Step 1 while keeping Step 2 with
the launcher-reported LAN address (graceful degradation).

**Display mode** (one button on the share screen; it replaced the earlier separate "Keep screen on" and
"Kiosk mode" switches in 0.6.0): shows the join codes full screen, as large as the screen allows with no
scrolling (one code in Wi-Fi mode; two on a hotspot, side by side in landscape), holds an
`expo-keep-awake` lock so the screen stays on, and pins LOAM in front with Android **screen pinning**
(`Activity.startLockTask()`, exposed from `LoamHotspotModule` as `startKiosk`/`stopKiosk`). Leaving it
takes a press-and-hold; without device-owner provisioning Android also offers its own exit gesture
(**swipe up and hold** on gesture nav, or hold **Back + Recents** on 3-button nav), which asks for the
phone's screen-lock PIN when one is set, so a host left out in public should set a device PIN first. The
network keeps running with the screen off either way; the screen only stays on so the codes can be seen.
Both native calls are best-effort no-ops when unsupported and never throw; the pin is released on
unmount. The overlay also shows the app **version** (`Constants.expoConfig?.version`).

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
- **Emergency reset from the host app** (in the host menu on a private, `hardened` network; at the bottom
  of Encryption settings on every network) closes the app once everything is erased: the native
  `closeApp()` (loam-hotspot module) stops the host service, finishes the task and kills the process. A
  nodejs-mobile runtime can't be started twice in one process, and reattaching to the wiped server left the
  launcher stuck ("Couldn't finish starting LOAM"), so the next launch is a fresh process that opens on the
  setup screens. Setup never mentions the erased network, and doesn't highlight the last choice. Only then,
  though (`resetOutcome`, `src/lib/emergency-reset.ts`): an erase the server couldn't verify complete
  (`complete: false`, the node stays 503-locked) stays on screen saying so, with a Close button (reopening
  retries the erase); and on a fixed-key node the screen waits for the device-key clear the server handed
  off (`keyClearRequested`), which `attemptWipeKeyClear` closes the app after, or shows the failure of
  with a retry.
- **The host token and key reach the WebView only by injection** (`injectedJavaScriptBeforeContentLoaded`),
  never in the start URL: the client trusts those globals over a pin, and a URL is something anyone can
  craft (review 2026-10-03 #1).
- **After an Emergency Reset** the node rotates its transport key. The host screen re-fetches
  `/api/bootstrap` for the new `#k=` and remounts the WebView when the client reports the `wipe` event
  (which also clears its old pin). The WebView is also handed the node's key directly: alongside the
  per-boot host token (`window.__loamHostDeviceToken`), `injectedJavaScriptBeforeContentLoaded` sets
  `window.__loamHostTransportKey` to the key from the loopback `/api/bootstrap`, and the client adopts it
  over any stale or broken pin without asking. That covers a WebView that **missed** the wipe event, and
  a node with an ephemeral DB key, which mints a new transport key on **every boot** — without it the host's
  own screen would hit the rescan gate and a "different key" prompt on each launch. The injection only
  happens in the host's own WebView, pinned to the loopback origin (`originWhitelist` +
  `onShouldStartLoadWithRequest`), so a LAN browser never gets it; LAN joiners of an ephemeral-key node
  rescan the QR after each host restart (docs/08). The client also purges its cached data when its
  server-confirmed identity changes, so a missed wipe doesn't leave old messages on screen.

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
   **needs a physical device** (a second phone joins the hotspot and opens the Step-2 URL).

Only after those pass is the QR/host UI mostly glue over `packages/qr`.

### Physical-device test (owner)
The emulator can't create a real hotspot (no WiFi radio), so the end-to-end join is a two-phone test:
1. Install + launch the APK; wait for LOAM to load, open the host menu, tap **Invite people**, and grant the permission
   prompt(s): location always (choose **Precise** below Android 13, where the hotspot needs it), plus a
   nearby-WiFi-devices prompt on Android 13+ (API 33+), which is the one that counts there.
2. Confirm **Step 1** shows a real SSID + password. On a second phone, scan the Step-1 WiFi QR (or type
   the creds) to join the hotspot.
3. Wait for Step 2 to show a QR (it reads "Finding the hotspot's address…" for a few seconds), then
   scan it → LOAM opens over the hotspot. If Step 2 instead says the address couldn't be worked out, note
   the "this host's addresses" line and the joining phone's Wi-Fi **Gateway** — that's the bug report.
4. Post a message from the second phone; confirm it appears on the host (proves the WS/LAN path).

## Open questions
- ~~Server hosting model~~ — settled: embedded Node (spike-verified twice, incl. the real server).
- ~~Co-locate the RN app in this monorepo?~~ — settled by action: `apps/app`.
- ~~The "two hotspot QR codes"~~ — settled: WiFi-join QR + LOAM-URL QR, shown sequentially.
- ~~Fastify 5 vs pin fastify@4~~ — settled: Fastify 5 works on the embedded Node 18.
- iOS in scope at all for v1? (Recommend no.)
