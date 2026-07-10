// Expo config plugin: sign the **release** APK with a real upload key instead of the debug keystore.
//
// Expo's generated `android/app/build.gradle` points the `release` build type at
// `signingConfigs.debug`, so `assembleRelease` (what scripts/build-apk.mjs runs) ships an APK signed
// with the throwaway debug key — fine for `adb install`, wrong for any durable distribution (every
// rebuild of the debug key is different, so updates can't verify against an install; docs/04).
//
// This plugin closes that gap **only when the operator has generated a keystore** — i.e. when
// `apps/app/keystore.properties` exists (create it with `pnpm --filter app keystore`). Without that
// file it is a strict no-op, so the default `pnpm --filter app apk` keeps working exactly as before
// (debug-signed). `android/`, `*.jks`, and `keystore.properties` are all gitignored, so no secret is
// ever committed; the injected values live only in the ephemeral generated project.
//
// keystore.properties format (key=value, one per line):
//   storeFile=release.jks              # relative to apps/app, or an absolute path
//   storePassword=…
//   keyAlias=loam
//   keyPassword=…

const { withAppBuildGradle } = require("expo/config-plugins");
const { existsSync, readFileSync } = require("node:fs");
const { isAbsolute, join, resolve } = require("node:path");

const MARKER = "// loam-host: release signing";
const APP_DIR = resolve(__dirname, "..");
const PROPS_PATH = join(APP_DIR, "keystore.properties");

/** Parse a `key=value` properties file into a plain object (blank lines and `#` comments ignored). */
function parseProperties(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) {
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Escape a value for embedding inside a Groovy single-quoted string (no `$` interpolation there). */
function groovyLiteral(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

module.exports = function withReleaseSigning(config) {
  // No keystore configured → leave the project untouched (release stays debug-signed, as today).
  if (!existsSync(PROPS_PATH)) {
    return config;
  }

  const props = parseProperties(readFileSync(PROPS_PATH, "utf8"));
  for (const key of ["storeFile", "storePassword", "keyAlias", "keyPassword"]) {
    if (!props[key]) {
      throw new Error(`with-release-signing: keystore.properties is missing "${key}".`);
    }
  }

  const storeFile = isAbsolute(props.storeFile) ? props.storeFile : join(APP_DIR, props.storeFile);
  if (!existsSync(storeFile)) {
    throw new Error(
      `with-release-signing: keystore not found at ${storeFile}. Run \`pnpm --filter app keystore\` first.`,
    );
  }

  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("with-release-signing expects a Groovy app/build.gradle");
    }

    let contents = cfg.modResults.contents;
    if (contents.includes(MARKER)) {
      return cfg;
    }

    // 1. Add a `release` signing config alongside the generated `debug` one.
    const block = [
      `        ${MARKER}`,
      "        release {",
      `            storeFile file(${groovyLiteral(storeFile)})`,
      `            storePassword ${groovyLiteral(props.storePassword)}`,
      `            keyAlias ${groovyLiteral(props.keyAlias)}`,
      `            keyPassword ${groovyLiteral(props.keyPassword)}`,
      "        }",
    ].join("\n");
    const withConfig = contents.replace(/signingConfigs\s*\{/, (match) => `${match}\n${block}`);
    if (withConfig === contents) {
      throw new Error("with-release-signing: could not find a `signingConfigs {` block in app/build.gradle.");
    }
    contents = withConfig;

    // 2. Point the *release* build type at it (only that occurrence — the release block references
    //    signingConfigs.debug before any nested `}`), leaving the debug build type alone.
    const withRelease = contents.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[^}]*?signingConfig\s+signingConfigs\.)debug/,
      "$1release",
    );
    if (withRelease === contents) {
      throw new Error(
        "with-release-signing: could not repoint the release build type to signingConfigs.release.",
      );
    }
    cfg.modResults.contents = withRelease;
    return cfg;
  });
};
