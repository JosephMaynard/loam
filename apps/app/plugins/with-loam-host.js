// Expo config plugin for the LOAM Android host (docs/04). Applied at `expo prebuild`. Three jobs:
//
//   1. Allow cleartext HTTP so the WebView can load http://localhost:3000 (the embedded server has
//      no TLS — there's no CA on a local hotspot). Sets android:usesCleartextTraffic="true".
//
//   2. Restrict native ABIs to arm64-v8a only. nodejs-mobile's x86/x86_64 CMake build is broken
//      upstream (#78/#88), and if the app leaves ndk.abiFilters unset the module defaults to a list
//      that INCLUDES x86_64 — so we must pin it explicitly (CoMapeo's `targetArmArchsOnly` pattern).
//      arm64-v8a matches the single android-arm64 better-sqlite3 prebuild we ship (see
//      scripts/fetch-native-modules.mjs) and covers the emulator + all modern phones. 32-bit
//      armeabi-v7a support needs its own prebuild and the per-ABI gradle path — a follow-up.
//
//   3. Declare the WiFi + location permissions the LocalOnlyHotspot native module needs (see
//      modules/loam-hotspot). LocalOnlyHotspot is location-gated, so ACCESS_FINE_LOCATION is
//      mandatory; NEARBY_WIFI_DEVICES covers API 33+, and CHANGE/ACCESS_WIFI_STATE are needed to
//      start and read the hotspot. The runtime grant is requested from JS before starting.
//      ACCESS_FINE_LOCATION is declared on ALL supported API levels (no `maxSdkVersion` cap) — see
//      the "REGRESSION NOTE" comment below for why capping it at API 32 silently breaks the hotspot
//      on API 33+.
//
//   4. Keep the on-device data off every backup/transfer path (allowBackup=false + fullBackupContent=false
//      below API 31, and a data_extraction_rules.xml excluding every domain for BOTH cloud backup and
//      Android 12+ device-to-device transfer, which allowBackup=false alone does NOT stop at targetSdk 31+).
//
//   5. Declare the implied hardware features (Wi-Fi, location/GPS, Bluetooth) as optional so Play doesn't
//      hide the listing from tablets/Chromebooks without them — the app degrades (no hotspot / no mesh).
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
// LocalOnlyHotspot; NEARBY_WIFI_DEVICES is the API 33+ companion; the WIFI_STATE pair lets the app
// start and query the hotspot.
const HOTSPOT_PERMISSIONS = [
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.NEARBY_WIFI_DEVICES",
  "android.permission.CHANGE_WIFI_STATE",
  "android.permission.ACCESS_WIFI_STATE",
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

/** Apply cleartext + the no-backup attributes to a parsed `<application>` element (pure, tested). */
function applyApplicationAttributes(application) {
  application.$["android:usesCleartextTraffic"] = "true";
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

/** Force cleartext + no-backup attributes on the <application> element. */
function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) {
      // Silently skipping would ship an APK whose WebView can't reach http://localhost:3000.
      throw new Error("with-loam-host: no <application> element in AndroidManifest.xml to set usesCleartextTraffic on.");
    }
    applyApplicationAttributes(application);
    return cfg;
  });
}

/** Write res/xml/data_extraction_rules.xml into the generated project (referenced by the manifest above). */
function withDataExtractionRules(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const xmlDir = join(cfg.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
      mkdirSync(xmlDir, { recursive: true });
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
// location + location.gps, BLUETOOTH_* → bluetooth), plus the mesh radios. All optional: without Wi-Fi the
// hotspot just can't start (the LAN join path remains), without BLE/Aware there is no mesh.
const OPTIONAL_FEATURES = [
  "android.hardware.bluetooth",
  "android.hardware.bluetooth_le",
  "android.hardware.wifi",
  "android.hardware.wifi.aware",
  "android.hardware.location",
  "android.hardware.location.gps",
  "android.hardware.location.network",
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

/**
 * Declare the mesh-transport hardware (BLE + Wi-Fi Aware) as OPTIONAL features so Google Play does not
 * filter out devices that lack them (many phones have no Wi-Fi Aware) — the app degrades gracefully
 * (BLE-only, or no mesh at all). Also stamp `usesPermissionFlags="neverForLocation"` on BLUETOOTH_SCAN
 * and NEARBY_WIFI_DEVICES so BLE-beacon scanning + Wi-Fi Aware discovery don't drag in the location-
 * permission story (we never derive location from either) — required for a mesh-only startup on API 33+.
 */
function withMeshManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest["uses-feature"] = manifest["uses-feature"] ?? [];
    addOptionalFeatures(manifest);

    // Stamp `neverForLocation` on BOTH BLUETOOTH_SCAN and NEARBY_WIFI_DEVICES — we never derive physical
    // location from BLE scanning or Wi-Fi Aware. Critically for NEARBY_WIFI_DEVICES (API 33+): without this
    // flag Android *also* requires ACCESS_FINE_LOCATION to be granted, so a fresh MESH-ONLY startup (which
    // requests only NEARBY_WIFI_DEVICES) would fail unless the hotspot flow had separately granted location
    // first (P1). The hotspot keeps its own ACCESS_FINE_LOCATION declaration, so this is additive.
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

// --- REGRESSION NOTE (fix/device-feedback-round1) ---------------------------------------------
// A prior change ("A10") added a `withFineLocationMaxSdk` step here that stamped
// `android:maxSdkVersion="32"` onto ACCESS_FINE_LOCATION, reasoning that NEARBY_WIFI_DEVICES
// (declared `neverForLocation` by withMeshManifest below) would cover the hotspot on API 33+ same
// as it does Wi-Fi Aware/BLE scanning. That capped the permission clean off the merged manifest on
// API 33+ devices (Android 13/14/15) — including the Galaxy S25 Ultra (API 35).
//
// The bug: `WifiManager.startLocalOnlyHotspot()` DOES accept NEARBY_WIFI_DEVICES as an alternative
// to ACCESS_FINE_LOCATION on API 33+ per Android's own docs (developer.android.com/develop/
// connectivity/wifi/wifi-permissions, developer.android.com/develop/connectivity/wifi/
// localonlyhotspot) — but only if the app's *runtime permission request* is updated to ask for
// NEARBY_WIFI_DEVICES instead of ACCESS_FINE_LOCATION on those API levels. `src/hooks/use-hotspot.ts`
// (apps/app/src, outside this module's scope) was never updated to do that split: it still requests
// ACCESS_FINE_LOCATION unconditionally on every API level, *plus* NEARBY_WIFI_DEVICES on 33+, and
// requires every requested permission to be granted. Once the manifest capped ACCESS_FINE_LOCATION
// off API 33+, `PermissionsAndroid.requestMultiple` silently auto-denies that request (a runtime
// request for a permission the manifest doesn't declare for the running API level shows no dialog
// and comes back denied) — so the combined grant check always failed on API 33+, regardless of what
// the user tapped on the NEARBY_WIFI_DEVICES prompt. The hotspot could never start on any API 33+
// device, which matches the reported "Host stopped / location permission is needed" failure.
//
// Fix: declare ACCESS_FINE_LOCATION on ALL supported API levels (no cap), so the JS side's existing
// (unconditional) request is satisfiable again. This restores the exact configuration that was
// verified working on an arm64 API-35 emulator (docs/04, "Emulator-verified... tapping it prompts
// for ACCESS_FINE_LOCATION then NEARBY_WIFI_DEVICES, and startHotspot() runs"). The cleaner long-term
// fix — matching what NEARBY_WIFI_DEVICES's `neverForLocation` flag is actually for — is to update
// `use-hotspot.ts` to request ONLY NEARBY_WIFI_DEVICES on API 33+ and drop ACCESS_FINE_LOCATION
// there, which would let this manifest cap come back. That's a JS-side change outside this module's
// scope for this fix; left as a follow-up (see docs/04).
// -------------------------------------------------------------------------------------------------

// --- Stale-prebuild guard ------------------------------------------------------------------------
// The generated android/ is gitignored and only refreshed by `expo prebuild`. Running `./gradlew` on an
// old one silently ships its old manifest (e.g. template permissions a later app.json blocks, or a missing
// permission a plugin now adds). The fingerprint covers exactly what shapes the generated native project
// from this repo: app.json and every config plugin. The Groovy check below recomputes it the same way.
const FINGERPRINT_FILE = "loam-prebuild.sha256";
const STALE_GUARD_MARKER = "// loam-host: stale-prebuild guard";

/** sha256 over app.json then plugins/*.js (sorted by name); each file contributes its name, then bytes. */
function prebuildFingerprint(appDir) {
  const hash = createHash("sha256");
  const pluginDir = join(appDir, "plugins");
  const plugins = readdirSync(pluginDir)
    .filter((name) => name.endsWith(".js"))
    .sort();
  const files = [["app.json", join(appDir, "app.json")], ...plugins.map((name) => [name, join(pluginDir, name)])];
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
    def files = [new File(appDir, "app.json")]
    files += (new File(appDir, "plugins").listFiles().findAll { it.name.endsWith(".js") }.sort { it.name })
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
  config = withCleartextTraffic(config);
  config = withDataExtractionRules(config);
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
  OPTIONAL_FEATURES,
  STALE_GUARD_GRADLE,
  addOptionalFeatures,
  applyApplicationAttributes,
  dataExtractionRulesXml,
  prebuildFingerprint,
};
