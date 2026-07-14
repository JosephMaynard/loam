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

const { withAndroidManifest, withAppBuildGradle, withGradleProperties, AndroidConfig } = require("expo/config-plugins");

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

/** Force `android:usesCleartextTraffic="true"` on the <application> element. */
function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) {
      // Silently skipping would ship an APK whose WebView can't reach http://localhost:3000.
      throw new Error("with-loam-host: no <application> element in AndroidManifest.xml to set usesCleartextTraffic on.");
    }
    application.$["android:usesCleartextTraffic"] = "true";
    // Disable OS backup: the on-device `.loam` dir holds the (currently unencrypted) message
    // history, avatars, and sessions. Expo defaults allowBackup to true, which would let Google
    // Auto Backup and `adb backup` copy that data off the device — wrong for a privacy app whose
    // whole point is that nothing leaves the local node. (docs/04 — on-device encryption is the
    // deeper follow-up; this closes the extraction path meanwhile.)
    application.$["android:allowBackup"] = "false";
    application.$["android:fullBackupContent"] = "false";
    return cfg;
  });
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
    const features = [
      "android.hardware.bluetooth_le",
      "android.hardware.wifi.aware",
    ];
    for (const name of features) {
      const already = manifest["uses-feature"].some((feature) => feature.$?.["android:name"] === name);
      if (!already) {
        manifest["uses-feature"].push({ $: { "android:name": name, "android:required": "false" } });
      }
    }

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

module.exports = function withLoamHost(config) {
  config = withCleartextTraffic(config);
  config = withArmOnlyAbiFilters(config);
  config = withArmOnlyReactNativeArchitectures(config);
  // Merge (de-duped) the hotspot + foreground-service + mesh-transport permissions into the manifest.
  config = AndroidConfig.Permissions.withPermissions(config, [...HOTSPOT_PERMISSIONS, ...MESH_PERMISSIONS]);
  config = withMeshManifest(config);
  config = withHostService(config);
  return config;
};
