// Expo config plugin for the LOAM Android host (docs/04). Applied at `expo prebuild`. Two jobs:
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

const { withAndroidManifest, withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

const ABIS = "arm64-v8a";
const MARKER = "// loam-host: arm-only ABIs";

/** Force `android:usesCleartextTraffic="true"` on the <application> element. */
function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) {
      // Silently skipping would ship an APK whose WebView can't reach http://localhost:3000.
      throw new Error("with-loam-host: no <application> element in AndroidManifest.xml to set usesCleartextTraffic on.");
    }
    application.$["android:usesCleartextTraffic"] = "true";
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

module.exports = function withLoamHost(config) {
  config = withCleartextTraffic(config);
  config = withArmOnlyAbiFilters(config);
  config = withArmOnlyReactNativeArchitectures(config);
  return config;
};
