// Build a release APK for the LOAM Android host end-to-end, then copy it somewhere obvious.
//
// One command instead of the six-step dance in docs/04: builds the workspace, fetches the
// better-sqlite3 native prebuild, bundles the embedded server, regenerates the native project with
// Expo prebuild, and runs `gradlew assembleRelease` (arm64). The finished APK is copied to
// `apps/app/loam-host.apk` (gitignored) and its path printed, ready for `adb install -r`.
//
// Usage:  pnpm --filter app apk                 → writes apps/app/loam-host.apk
//         pnpm --filter app apk -- --out ~/x.apk → also copies to the given path
//
// Prereqbs (see docs/04): a real JDK (Android Studio's JBR, not a bare JRE) and the Android SDK with
// platform-tools + NDK r27+. JAVA_HOME / ANDROID_HOME are auto-detected on macOS if unset; otherwise
// set them yourself. This script only builds — install with `adb install -r <printed path>`.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "..", "..");
const androidDir = join(appDir, "android");
const gradlewApk = join(androidDir, "app", "build", "outputs", "apk", "release", "app-release.apk");
const defaultOut = join(appDir, "loam-host.apk");

/** Parse `--out <path>` from argv; everything after `--` is ours (pnpm forwards it). */
function parseOut() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out");
  if (i < 0) {
    return defaultOut;
  }
  const value = args[i + 1];
  if (!value) {
    console.error("--out was given without a path. Usage: pnpm --filter app apk -- --out <path>");
    process.exit(1);
  }
  return resolve(value);
}

/** Find a usable JDK/SDK, preferring an existing env var, then the common macOS locations. */
function resolveEnv() {
  const env = { ...process.env };
  // A stale JAVA_HOME/ANDROID_HOME pointing at a deleted SDK would otherwise fail deep inside Gradle
  // with a confusing error; treat a non-existent pre-set path as absent so the fallbacks and the
  // required-env checks below get a chance to apply instead.
  for (const key of ["JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    if (env[key] && !existsSync(env[key])) {
      delete env[key];
    }
  }
  if (!env.JAVA_HOME && platform() === "darwin") {
    const jbr = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
    if (existsSync(jbr)) env.JAVA_HOME = jbr;
  }
  if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
    const sdk =
      platform() === "darwin"
        ? join(homedir(), "Library", "Android", "sdk")
        : join(homedir(), "Android", "Sdk");
    if (existsSync(sdk)) env.ANDROID_HOME = sdk;
  }
  if (env.JAVA_HOME) env.PATH = `${join(env.JAVA_HOME, "bin")}:${env.PATH ?? ""}`;
  return env;
}

/** Run a command, inheriting stdio, and abort the whole build on a non-zero exit. */
function run(command, args, options) {
  const label = [command, ...args].join(" ");
  console.log(`\n[36m$ ${label}[0m`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) {
    console.error(`\nFailed to run: ${label}\n${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nStep failed (exit ${result.status}): ${label}`);
    process.exit(result.status ?? 1);
  }
}

const env = resolveEnv();
if (!env.JAVA_HOME) {
  console.error(
    "JAVA_HOME is not set and no Android Studio JBR was found. Point it at a real JDK (see docs/04).",
  );
  process.exit(1);
}
if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
  console.error("ANDROID_HOME is not set and no Android SDK was found. Install the SDK (see docs/04).");
  process.exit(1);
}

const out = parseOut();
const pnpm = { cwd: repoRoot, env };

console.log("Building the LOAM Android host APK — this takes a few minutes on a cold cache.");

// 1. Workspace build (packages + server + web client — the client dist gets bundled into the server).
run("pnpm", ["-r", "build"], pnpm);
// 2. Native prebuild (better-sqlite3 android-arm64) + 3. bundle the embedded server for nodejs-mobile.
run("pnpm", ["--filter", "app", "fetch:native"], pnpm);
run("pnpm", ["--filter", "app", "bundle:server"], pnpm);
// 4. Regenerate the native android/ project (gitignored) so app.json changes propagate. --clean is
//    what makes the build reproducible from a checkout.
run("npx", ["expo", "prebuild", "--platform", "android", "--no-install", "--clean"], {
  cwd: appDir,
  env: { ...env, CI: "1" },
});
// 5. Assemble the release APK for arm64 (the only ABI the bundled native prebuild ships).
run("./gradlew", ["assembleRelease", "-PreactNativeArchitectures=arm64-v8a"], {
  cwd: androidDir,
  env,
});

if (!existsSync(gradlewApk)) {
  console.error(`\nBuild finished but no APK was found at ${gradlewApk}`);
  process.exit(1);
}
copyFileSync(gradlewApk, out);
const sizeMb = (statSync(out).size / 1024 / 1024).toFixed(0);
console.log(`\n[32m✓ APK ready (${sizeMb} MB):[0m ${out}`);
console.log(`Install it on a connected phone/emulator with:\n  adb install -r ${out}`);
