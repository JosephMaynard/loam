// Expo config plugin for the LOAM Android host (docs/04). Applied at `expo prebuild`. Its jobs:
//
//   1. Allow cleartext HTTP to loopback ONLY, through a res/xml/network_security_config.xml: the WebView
//      loads http://localhost:3000 and the launcher fetches it (the embedded server has no TLS; there's no
//      CA on a local hotspot), while everything else the app itself fetches (model downloads, the GitHub
//      update check) is HTTPS and stays refused in the clear. The embedded Node server's own sockets are
//      not subject to this config (it isn't the Android HTTP stack). Replaces the app-wide
//      android:usesCleartextTraffic="true" that Play's pre-launch report flagged.
//
//   2. Restrict native ABIs to arm64-v8a only. nodejs-mobile's x86/x86_64 CMake build is broken
//      upstream (#78/#88), and if the app leaves ndk.abiFilters unset the module defaults to a list
//      that INCLUDES x86_64 — so we must pin it explicitly (CoMapeo's `targetArmArchsOnly` pattern).
//      arm64-v8a matches the single android-arm64 better-sqlite3 prebuild we ship (see
//      scripts/fetch-native-modules.mjs) and covers the emulator + all modern phones. 32-bit
//      armeabi-v7a support needs its own prebuild and the per-ABI gradle path — a follow-up.
//
//   3. Declare the WiFi + location permissions the LocalOnlyHotspot native module needs (see
//      modules/loam-hotspot). LocalOnlyHotspot is location-gated below API 33, so ACCESS_FINE_LOCATION
//      is mandatory there, and ACCESS_COARSE_LOCATION is declared beside it because Android 12+ requires
//      a fine request to carry coarse in the same dialog (a fine-only request is ignored on some Android
//      12 releases, and a runtime request for an undeclared permission auto-denies). NEARBY_WIFI_DEVICES
//      gates the call on API 33+, and CHANGE/ACCESS_WIFI_STATE are needed to start and read the hotspot.
//      The runtime grant is requested from JS before starting (src/lib/hotspot-permissions.ts holds the
//      list + grant rule). ACCESS_FINE_LOCATION is declared on ALL supported API levels (no
//      `maxSdkVersion` cap); the "REGRESSION NOTE" comment below says why capping it at API 32
//      silently broke the hotspot on API 33+.
//
//   4. Keep the on-device data off every backup/transfer path (allowBackup=false + fullBackupContent=false
//      below API 31, and a data_extraction_rules.xml excluding every domain for BOTH cloud backup and
//      Android 12+ device-to-device transfer, which allowBackup=false alone does NOT stop at targetSdk 31+).
//
//   5. Declare the implied hardware features (Wi-Fi, location/GPS, Bluetooth, camera) as optional so Play
//      doesn't hide the listing from tablets/Chromebooks without them — the app degrades (no hotspot / no
//      mesh / no scanner) — and declare the touchscreen (and faketouch) optional too, or Play hides the app
//      from Android laptops with only a keyboard and trackpad. With it, `android:resizeableActivity="true"`
//      on the main activity: the host runs in any orientation and any window size (tablets, foldables,
//      laptops), which is what app.json `orientation: "default"` means and what Play's large-screen
//      guidelines ask for (docs/04 "Large screens", docs/30). Both screen orientations are declared optional
//      as well: Google's code scanner, merged in through expo-camera, brings a portrait-locked activity, and
//      Play would otherwise read the built APK as requiring a portrait screen.
//
//   6. Stamp the generated android/ project with a fingerprint of app.json + these plugins, and make the
//      Gradle build fail when they no longer match — so a direct `./gradlew` on a STALE prebuild (old
//      manifest, old permissions) can't ship. `expo prebuild` (and `pnpm --filter app apk`) refreshes it.

const { createHash } = require("node:crypto");
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
  AndroidConfig,
} = require("expo/config-plugins");

const ABIS = "arm64-v8a";
const MARKER = "// loam-host: arm-only ABIs";

// Manifest permissions the hotspot module requires (docs/04). ACCESS_FINE_LOCATION is mandatory for
// LocalOnlyHotspot below API 33, and ACCESS_COARSE_LOCATION must be declared with it: Android 12+ only
// honours a fine request that asks for coarse in the same dialog, and the JS side requests both on every
// API level (src/lib/hotspot-permissions.ts). NEARBY_WIFI_DEVICES is what gates the call on API 33+; the
// WIFI_STATE pair lets the app start and query the hotspot.
const HOTSPOT_PERMISSIONS = [
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.NEARBY_WIFI_DEVICES",
  "android.permission.CHANGE_WIFI_STATE",
  "android.permission.ACCESS_WIFI_STATE",
  // The hotspot's address is assigned at random per start, so the module finds it by telling the phone's
  // own networks (ConnectivityManager: home Wi-Fi, mobile data, VPN) apart from the SoftAP interface.
  // Normal-level, no runtime prompt.
  "android.permission.ACCESS_NETWORK_STATE",
  // Foreground service keeps the host alive while the screen is off (LoamHostService). WAKE_LOCK
  // holds the CPU; POST_NOTIFICATIONS (API 33+) lets its required notification show; the
  // CONNECTED_DEVICE type permission is mandatory to run a `connectedDevice` FGS on API 34+.
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
  "android.permission.WAKE_LOCK",
  "android.permission.POST_NOTIFICATIONS",
];

// Opportunistic-mesh transport permissions (docs/16 §5, docs/17 — modules/loam-mesh-transport).
// Android 12+ split Bluetooth into the ADVERTISE/SCAN/CONNECT trio (advertise a LOAM beacon, scan for
// peers, connect for the GATT control/fallback path). NEARBY_WIFI_DEVICES + ACCESS_FINE_LOCATION
// (already required by the hotspot) also gate Wi-Fi Aware and pre-12 BLE scanning. The `neverForLocation`
// usage flag on SCAN keeps us out of the location-permission story where the OS allows it. The runtime
// grant is requested from JS (src/mesh/mesh-transport.ts) before the radios start.
const MESH_PERMISSIONS = [
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_CONNECT",
  // The Wi-Fi Aware data path calls ConnectivityManager.requestNetwork(), which throws a
  // SecurityException without this (normal-level, no runtime prompt).
  "android.permission.CHANGE_NETWORK_STATE",
];

// Android 7–11 (API 24–30), which MeshBleController still supports, predates that trio: there the
// adapter, discovery and advertising calls need the legacy BLUETOOTH + BLUETOOTH_ADMIN pair instead (both
// normal-level, granted at install), and granting location alone authorises none of them. Declared with
// `maxSdkVersion="30"` so API 31+ never sees them (Android's prescribed split: developer.android.com/
// develop/connectivity/bluetooth/bt-permissions). Added as manifest entries with that attribute, not
// through withPermissions, which can only write plain uncapped names.
const LEGACY_BLUETOOTH_PERMISSIONS = ["android.permission.BLUETOOTH", "android.permission.BLUETOOTH_ADMIN"];
const LEGACY_BLUETOOTH_MAX_SDK = "30";

const HOST_SERVICE_NAME = "expo.modules.loamhotspot.LoamHostService";

/** Declare the foreground host service (LoamHostService) in the app manifest. */
function withHostService(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("with-loam-host: no <application> element to declare LoamHostService on.");
    }
    application.service = application.service ?? [];
    const already = application.service.some(
      (service) => service.$?.["android:name"] === HOST_SERVICE_NAME,
    );
    if (!already) {
      application.service.push({
        $: {
          "android:name": HOST_SERVICE_NAME,
          "android:exported": "false",
          "android:foregroundServiceType": "connectedDevice",
        },
      });
    }
    return cfg;
  });
}

// Every backup domain Android's data-extraction rules know. Excluding all of them (with no <include>)
// means NOTHING is copied — for cloud backup and for device-to-device transfer alike.
const BACKUP_DOMAINS = [
  "root",
  "file",
  "database",
  "sharedpref",
  "external",
  "device_root",
  "device_file",
  "device_database",
  "device_sharedpref",
];
const DATA_EXTRACTION_RULES_RESOURCE = "@xml/data_extraction_rules";

/** The res/xml/data_extraction_rules.xml body: every domain excluded under both sections. */
function dataExtractionRulesXml() {
  const excludes = BACKUP_DOMAINS.map((domain) => `    <exclude domain="${domain}" path="." />`).join("\n");
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!-- Generated by plugins/with-loam-host.js. LOAM's on-device data (loam.db, avatars, attachments,",
    "     config.json) must never leave the phone: no cloud backup, no Android 12+ device transfer. -->",
    "<data-extraction-rules>",
    "  <cloud-backup>",
    excludes,
    "  </cloud-backup>",
    "  <device-transfer>",
    excludes,
    "  </device-transfer>",
    "</data-extraction-rules>",
    "",
  ].join("\n");
}

// Cleartext HTTP is permitted to these hosts only (see networkSecurityConfigXml): the embedded server's
// loopback origin, which the host's own WebView loads and the launcher fetches. A LAN joiner's phone talks to
// the server from its own browser, not through this app, so the LAN never needs an exception here.
const CLEARTEXT_HOSTS = ["localhost", "127.0.0.1"];
const NETWORK_SECURITY_CONFIG_RESOURCE = "@xml/network_security_config";

/** The res/xml/network_security_config.xml body: cleartext refused everywhere except CLEARTEXT_HOSTS. */
function networkSecurityConfigXml() {
  const domains = CLEARTEXT_HOSTS.map((host) => `    <domain includeSubdomains="false">${host}</domain>`).join("\n");
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!-- Generated by plugins/with-loam-host.js. Cleartext HTTP only to the embedded server's loopback origin",
    "     (the host's own WebView and the launcher); every other connection the app makes must be HTTPS. -->",
    "<network-security-config>",
    '  <base-config cleartextTrafficPermitted="false" />',
    '  <domain-config cleartextTrafficPermitted="true">',
    domains,
    "  </domain-config>",
    "</network-security-config>",
    "",
  ].join("\n");
}

/** Apply the network security config + the no-backup attributes to a parsed `<application>` element (pure, tested). */
function applyApplicationAttributes(application) {
  // Loopback-only cleartext (networkSecurityConfigXml). `usesCleartextTraffic` is dropped rather than set to
  // false: when a networkSecurityConfig is present Android ignores that attribute, and leaving it behind
  // would keep the app-wide "true" a scanner reads.
  application.$["android:networkSecurityConfig"] = NETWORK_SECURITY_CONFIG_RESOURCE;
  delete application.$["android:usesCleartextTraffic"];
  // Disable OS backup: the on-device `.loam` dir holds the message history, avatars, attachments and
  // config (plaintext unless on-device encryption is on). Expo defaults allowBackup to true, which would
  // let Google Auto Backup and `adb backup` copy that off the device — wrong for a privacy app whose whole
  // point is that nothing leaves the local node. allowBackup/fullBackupContent cover API < 31; on API 31+
  // (targetSdk 36) allowBackup=false does NOT stop device-to-device transfer, so dataExtractionRules
  // (every domain excluded, see dataExtractionRulesXml) closes that path too.
  application.$["android:allowBackup"] = "false";
  application.$["android:fullBackupContent"] = "false";
  application.$["android:dataExtractionRules"] = DATA_EXTRACTION_RULES_RESOURCE;
  return application;
}

/** Force the network security config + no-backup attributes on the <application> element. */
function withApplicationAttributes(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) {
      // Silently skipping would ship an APK whose WebView can't reach http://localhost:3000.
      throw new Error("with-loam-host: no <application> element in AndroidManifest.xml to set networkSecurityConfig on.");
    }
    applyApplicationAttributes(application);
    return cfg;
  });
}

/**
 * Apply the large-screen attributes to a parsed main `<activity>` element (pure, tested): the host declares
 * itself resizable, so it fills a tablet in either orientation and runs in a freeform or split window on a
 * foldable or an Android laptop. Android 16 already ignores a fixed orientation and a non-resizable flag on
 * displays of 600dp and up for apps targeting API 36, so this only makes explicit what those devices do
 * anyway; Play's large-screen checks read the attribute. `configChanges` (orientation, screenSize,
 * screenLayout, smallestScreenSize…) is Expo's template value and is left as it is: the activity handles a
 * rotation or a resize without being recreated. `screenOrientation` is left to app.json (`"default"` →
 * `unspecified`), never forced here.
 */
function applyMainActivityAttributes(activity) {
  activity.$["android:resizeableActivity"] = "true";
  return activity;
}

/** Force the large-screen attributes on the main activity. */
function withMainActivityAttributes(config) {
  return withAndroidManifest(config, (cfg) => {
    applyMainActivityAttributes(AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults));
    return cfg;
  });
}

/** Write res/xml/network_security_config.xml + data_extraction_rules.xml into the generated project (both
 * referenced from the manifest attributes above). */
function withXmlResources(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const xmlDir = join(cfg.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
      mkdirSync(xmlDir, { recursive: true });
      writeFileSync(join(xmlDir, "network_security_config.xml"), networkSecurityConfigXml());
      writeFileSync(join(xmlDir, "data_extraction_rules.xml"), dataExtractionRulesXml());
      return cfg;
    },
  ]);
}

/** Pin the app module's ndk.abiFilters to arm64-v8a so nodejs-mobile never targets x86. */
function withArmOnlyAbiFilters(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("with-loam-host expects a Groovy app/build.gradle");
    }
    if (cfg.modResults.contents.includes(MARKER)) {
      return cfg;
    }
    // Inject an ndk { abiFilters } block as the first line inside `defaultConfig {`.
    const injected = cfg.modResults.contents.replace(
      /defaultConfig\s*\{/,
      (match) => `${match}\n            ${MARKER}\n            ndk { abiFilters "${ABIS}" }`,
    );
    if (!injected.includes(MARKER)) {
      // The regex found no `defaultConfig {` — a silent skip would let the module target x86 and
      // break the build. Fail at prebuild instead, where it's obvious.
      throw new Error("with-loam-host: could not find `defaultConfig {` in app/build.gradle to pin abiFilters.");
    }
    cfg.modResults.contents = injected;
    return cfg;
  });
}

/** Also set reactNativeArchitectures so RN packages only the arm64 jniLibs. */
function withArmOnlyReactNativeArchitectures(config) {
  return withGradleProperties(config, (cfg) => {
    const existing = cfg.modResults.find(
      (item) => item.type === "property" && item.key === "reactNativeArchitectures",
    );
    if (existing) {
      existing.value = ABIS;
    } else {
      cfg.modResults.push({ type: "property", key: "reactNativeArchitectures", value: ABIS });
    }
    return cfg;
  });
}

// Hardware the declared permissions IMPLY as required (CHANGE_WIFI_STATE → wifi, ACCESS_FINE_LOCATION →
// location + location.gps, ACCESS_COARSE_LOCATION → location + location.network, BLUETOOTH_* →
// bluetooth), plus the mesh radios. All optional: without Wi-Fi the
// hotspot just can't start (the LAN join path remains), without BLE/Aware there is no mesh. The touchscreen
// is the one Play assumes REQUIRED unless told otherwise (every app implies `android.hardware.touchscreen`),
// which hides the listing from Android laptops and desktops that have only a keyboard and trackpad; declared
// optional (with `faketouch`, the pointer-only form) because every native control here is a Pressable or a
// TextInput, which take mouse clicks and keyboard focus, and the WebView handles both itself.
// Both screen orientations, because a library activity locks one even though app.json locks none
// (`orientation: "default"`, MainActivity `screenOrientation="unspecified"`): Google's code scanner
// (play-services-code-scanner, a dependency of expo-camera's barcode scanner) merges in
// `com.google.mlkit.vision.codescanner.internal.GmsBarcodeScanningDelegateActivity` with
// `android:screenOrientation="portrait"` (an invisible delegate that starts Google's scanner UI). One
// portrait-locked activity makes the APK imply `android.hardware.screen.portrait` as REQUIRED, which lets
// Play exclude devices with a landscape-only screen, Android laptops among them. The host runs in either
// orientation, so both are declared optional (landscape too, so a library locking that one can't do the
// same).
const OPTIONAL_FEATURES = [
  "android.hardware.touchscreen",
  "android.hardware.faketouch",
  "android.hardware.screen.portrait",
  "android.hardware.screen.landscape",
  "android.hardware.bluetooth",
  "android.hardware.bluetooth_le",
  "android.hardware.wifi",
  "android.hardware.wifi.aware",
  "android.hardware.location",
  "android.hardware.location.gps",
  "android.hardware.location.network",
  // CAMERA (expo-camera, for scanning another network's join code in setup) implies these.
  "android.hardware.camera",
  "android.hardware.camera.autofocus",
];

/** Declare every OPTIONAL_FEATURES entry `required="false"` on a parsed manifest (pure, tested). An existing
 * declaration is forced optional rather than duplicated. */
function addOptionalFeatures(manifest) {
  manifest["uses-feature"] = manifest["uses-feature"] ?? [];
  for (const name of OPTIONAL_FEATURES) {
    const existing = manifest["uses-feature"].find((feature) => feature.$?.["android:name"] === name);
    if (existing) {
      existing.$["android:required"] = "false";
    } else {
      manifest["uses-feature"].push({ $: { "android:name": name, "android:required": "false" } });
    }
  }
  return manifest;
}

/** Declare each LEGACY_BLUETOOTH_PERMISSIONS entry capped at API 30 on a parsed manifest (pure, tested). An
 * existing declaration is capped rather than duplicated. */
function addLegacyBluetoothPermissions(manifest) {
  manifest["uses-permission"] = manifest["uses-permission"] ?? [];
  for (const name of LEGACY_BLUETOOTH_PERMISSIONS) {
    const existing = manifest["uses-permission"].find((permission) => permission.$?.["android:name"] === name);
    if (existing) {
      existing.$["android:maxSdkVersion"] = LEGACY_BLUETOOTH_MAX_SDK;
    } else {
      manifest["uses-permission"].push({
        $: { "android:name": name, "android:maxSdkVersion": LEGACY_BLUETOOTH_MAX_SDK },
      });
    }
  }
  return manifest;
}

/**
 * Declare the mesh-transport hardware (BLE + Wi-Fi Aware) as OPTIONAL features so Google Play does not
 * filter out devices that lack them (many phones have no Wi-Fi Aware) — the app degrades gracefully
 * (BLE-only, or no mesh at all). Also stamp `usesPermissionFlags="neverForLocation"` on BLUETOOTH_SCAN
 * and NEARBY_WIFI_DEVICES so BLE-beacon scanning + Wi-Fi Aware discovery don't drag in the location-
 * permission story (we never derive location from either) — required for a mesh-only startup on API 33+.
 * And declare the pre-12 BLUETOOTH + BLUETOOTH_ADMIN pair, capped at API 30.
 */
function withMeshManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest["uses-feature"] = manifest["uses-feature"] ?? [];
    addOptionalFeatures(manifest);
    addLegacyBluetoothPermissions(manifest);

    // Stamp `neverForLocation` on BOTH BLUETOOTH_SCAN and NEARBY_WIFI_DEVICES — we never derive physical
    // location from BLE scanning or Wi-Fi Aware. Critically for NEARBY_WIFI_DEVICES (API 33+): without this
    // flag Android *also* requires ACCESS_FINE_LOCATION to be granted, so a fresh MESH-ONLY startup (which
    // requests only NEARBY_WIFI_DEVICES) would fail unless the hotspot flow had separately granted location
    // first. The hotspot keeps its own ACCESS_FINE_LOCATION declaration, so this is additive.
    const perms = manifest["uses-permission"] ?? [];
    for (const name of ["android.permission.BLUETOOTH_SCAN", "android.permission.NEARBY_WIFI_DEVICES"]) {
      const entry = perms.find((permission) => permission.$?.["android:name"] === name);
      if (entry) {
        entry.$["android:usesPermissionFlags"] = "neverForLocation";
      }
    }
    return cfg;
  });
}

// --- Why ACCESS_FINE_LOCATION has no maxSdkVersion cap -------------------------------------------
// `WifiManager.startLocalOnlyHotspot()` accepts NEARBY_WIFI_DEVICES instead of ACCESS_FINE_LOCATION on
// API 33+ (developer.android.com/develop/connectivity/wifi/wifi-permissions,
// developer.android.com/develop/connectivity/wifi/localonlyhotspot), so a `maxSdkVersion="32"` cap on
// ACCESS_FINE_LOCATION looks safe. It isn't while the runtime request still asks for location there: the
// JS side (src/lib/hotspot-permissions.ts, used by use-hotspot.ts) requests ACCESS_FINE_LOCATION and
// ACCESS_COARSE_LOCATION on every API level (plus NEARBY_WIFI_DEVICES on 33+), and
// `PermissionsAndroid.requestMultiple` silently auto-denies a permission the manifest doesn't declare for
// the running API level (no dialog). A capped manifest once made the hotspot impossible to start on every
// API 33+ device ("Host stopped / location permission is needed"). The coarse entry in HOTSPOT_PERMISSIONS
// above exists for the same reason: Android 12+ ignores a fine-only request on some releases.
//
// On API 33+ the JS side gates the start on NEARBY_WIFI_DEVICES alone, as Android does, so a denied
// location answer there doesn't block the hotspot. Dropping the location request on 33+ (and then
// letting the cap come back) is the follow-up noted in docs/04.
// -------------------------------------------------------------------------------------------------

// --- Stale-prebuild guard ------------------------------------------------------------------------
// The generated android/ is gitignored and only refreshed by `expo prebuild`. Running `./gradlew` on an
// old one silently ships its old manifest (e.g. template permissions a later app.json blocks, or a missing
// permission a plugin now adds). The fingerprint covers exactly what shapes the generated native project
// from this repo: app.json and every config plugin. The Groovy check below recomputes it the same way, from
// the same constants; src/__tests__/with-loam-host.test.ts parses the Groovy's algorithm back out and
// checks it against this function, and (opt-in, LOAM_GRADLE_GUARD_TEST=1) runs it under a real Gradle.
const FINGERPRINT_FILE = "loam-prebuild.sha256";
const FINGERPRINT_MANIFEST = "app.json";
const FINGERPRINT_PLUGIN_DIR = "plugins";
const FINGERPRINT_PLUGIN_EXT = ".js";
const STALE_GUARD_MARKER = "// loam-host: stale-prebuild guard";

/** sha256 over app.json then plugins/*.js (sorted by name); each file contributes its name, then bytes. */
function prebuildFingerprint(appDir) {
  const hash = createHash("sha256");
  const pluginDir = join(appDir, FINGERPRINT_PLUGIN_DIR);
  // Default sort = UTF-16 code-unit order, the same as Groovy's `sort { it.name }` (String.compareTo).
  const plugins = readdirSync(pluginDir)
    .filter((name) => name.endsWith(FINGERPRINT_PLUGIN_EXT))
    .sort();
  const files = [
    [FINGERPRINT_MANIFEST, join(appDir, FINGERPRINT_MANIFEST)],
    ...plugins.map((name) => [name, join(pluginDir, name)]),
  ];
  for (const [name, file] of files) {
    hash.update(Buffer.from(name, "utf8"));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

/** The Groovy appended to app/build.gradle: recompute the fingerprint and fail preBuild on a mismatch. */
const STALE_GUARD_GRADLE = `
${STALE_GUARD_MARKER}
// Fails the build when app.json or apps/app/plugins/*.js changed since \`expo prebuild\` generated this
// project (see plugins/with-loam-host.js). Re-run prebuild (\`pnpm --filter app apk\` does). Escape hatch
// for local native debugging only: -PloamSkipPrebuildCheck.
def loamPrebuildFingerprint = {
    def appDir = new File(rootDir, "..")
    def md = java.security.MessageDigest.getInstance("SHA-256")
    def files = [new File(appDir, "${FINGERPRINT_MANIFEST}")]
    files += (new File(appDir, "${FINGERPRINT_PLUGIN_DIR}").listFiles().findAll { it.name.endsWith("${FINGERPRINT_PLUGIN_EXT}") }.sort { it.name })
    files.each { f ->
        md.update(f.name.getBytes("UTF-8"))
        md.update(f.bytes)
    }
    return md.digest().encodeHex().toString()
}
def loamCheckPrebuildFresh = tasks.register("loamCheckPrebuildFresh") {
    doLast {
        if (project.hasProperty("loamSkipPrebuildCheck")) {
            logger.warn("LOAM: stale-prebuild check SKIPPED (-PloamSkipPrebuildCheck) — do not ship this build.")
            return
        }
        def stamp = new File(rootDir, "${FINGERPRINT_FILE}")
        def expected = stamp.exists() ? stamp.text.trim() : ""
        if (expected != loamPrebuildFingerprint()) {
            throw new GradleException("LOAM: this android/ project is STALE — app.json or a config plugin changed since " +
                "expo prebuild generated it. Regenerate it: \`CI=1 npx expo prebuild --platform android --clean\` " +
                "(or \`pnpm --filter app apk\`).")
        }
    }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(loamCheckPrebuildFresh) }
`;

/** Append the stale-prebuild check to app/build.gradle (once). */
function withStalePrebuildGuard(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("with-loam-host expects a Groovy app/build.gradle");
    }
    if (!cfg.modResults.contents.includes(STALE_GUARD_MARKER)) {
      cfg.modResults.contents += STALE_GUARD_GRADLE;
    }
    return cfg;
  });
}

/** Write the fingerprint stamp next to the generated project's settings.gradle. */
function withPrebuildFingerprint(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const stamp = join(cfg.modRequest.platformProjectRoot, FINGERPRINT_FILE);
      writeFileSync(stamp, `${prebuildFingerprint(cfg.modRequest.projectRoot)}\n`);
      return cfg;
    },
  ]);
}

module.exports = function withLoamHost(config) {
  config = withApplicationAttributes(config);
  config = withMainActivityAttributes(config);
  config = withXmlResources(config);
  config = withArmOnlyAbiFilters(config);
  config = withArmOnlyReactNativeArchitectures(config);
  // Merge (de-duped) the hotspot + foreground-service + mesh-transport permissions into the manifest.
  // ACCESS_FINE_LOCATION is declared plainly (no maxSdkVersion cap) — see the regression note above.
  config = AndroidConfig.Permissions.withPermissions(config, [...HOTSPOT_PERMISSIONS, ...MESH_PERMISSIONS]);
  config = withMeshManifest(config);
  config = withHostService(config);
  config = withStalePrebuildGuard(config);
  config = withPrebuildFingerprint(config);
  return config;
};

// Pure helpers, exported for the unit tests in src/__tests__/with-loam-host.test.ts.
module.exports._internal = {
  BACKUP_DOMAINS,
  CLEARTEXT_HOSTS,
  FINGERPRINT_FILE,
  HOTSPOT_PERMISSIONS,
  LEGACY_BLUETOOTH_PERMISSIONS,
  NETWORK_SECURITY_CONFIG_RESOURCE,
  OPTIONAL_FEATURES,
  STALE_GUARD_GRADLE,
  addLegacyBluetoothPermissions,
  addOptionalFeatures,
  applyApplicationAttributes,
  applyMainActivityAttributes,
  dataExtractionRulesXml,
  networkSecurityConfigXml,
  prebuildFingerprint,
};
