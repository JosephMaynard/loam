#!/usr/bin/env node
// Places the SQLite native modules into the nodejs-mobile project so the embedded server can open its
// SQLite DB on the device's Node 18 (which has no node:sqlite). Two drivers ship, and the DAL
// (apps/server/src/db.ts) lazy-`require`s whichever one it needs:
//   - PLAIN, UNENCRYPTED  better-sqlite3                    — the default on-device store.
//   - ENCRYPTED (SQLCipher) better-sqlite3-multiple-ciphers — used when security.dbEncryption is on
//     and a key is handed across the nodejs-mobile bridge (docs/01 "On-device key handoff").
// See docs/04 and docs/01.
//
// What it does, for each driver:
//   1. Materialises the JS wrapper (+ its runtime deps bindings, file-uri-to-path) at a pinned
//      version, WITHOUT running its native install script (we don't want a host build).
//   2. Places the matching ABI-108 android-arm64 native binary where the `bindings` module resolves it
//      (node_modules/<pkg>/build/Release/better_sqlite3.node), after verifying its sha256.
//
// Binary sources differ by driver:
//   - better-sqlite3 (plain): DOWNLOADED from digidem/better-sqlite3-nodejs-mobile (the CoMapeo-proven
//     upstream release), pinned by sha256.
//   - better-sqlite3-multiple-ciphers (encrypted): a SELF-BUILT prebuild VENDORED in the repo at
//     apps/app/native-prebuilds/multiple-ciphers/ (no upstream Android/ABI-108 release exists yet),
//     built from the reproducible recipe there and pinned by sha256. The encrypted driver now DOES
//     ship on-device, so security.dbEncryption modes take effect on a real device build (subject to
//     the remaining on-device PRAGMA-key runtime verification — docs/01). If digidem's release matrix
//     ever adds a MultipleCiphers Android prebuild upstream, switch this to a hosted download+pin like
//     the plain driver.
//
// The JS wrapper version and the .node source version MUST match per driver (ABI 108 only guarantees
// the binary loads into Node 18; the JS<->native API surface must also line up). Change both together.
//
// Usage: pnpm --filter app fetch:native

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ARCH = "android-arm64"; // matches the arm64-v8a APK we build (see plugins/with-loam-host.js)
const ABI = "108"; // Node 18 (embedded nodejs-mobile runtime)

// --- PLAIN driver: better-sqlite3, DOWNLOADED from digidem ------------------------------------------
// Pinned pair: the JS wrapper npm version and the digidem release tag (same number). android-arm64,
// Node ABI 108. Fallback if this fails to load on-device: 11.10.0 (the version CoMapeo ships).
const BETTER_SQLITE3_VERSION = "12.10.0";
const RELEASE_TAG = BETTER_SQLITE3_VERSION;
const ASSET = `better-sqlite3-${BETTER_SQLITE3_VERSION}-node-${ABI}-${ARCH}.tar.gz`;
const PREBUILD_URL = `https://github.com/digidem/better-sqlite3-nodejs-mobile/releases/download/${RELEASE_TAG}/${ASSET}`;
// Pinned sha256 of the tarball above — we refuse to install a native binary that doesn't match, so a
// compromised/replaced release or a MITM can't slip a different .node onto the device. Update this
// together with BETTER_SQLITE3_VERSION.
const PREBUILD_SHA256 = "00d84fcd41b80bbc910c0531320763f8f1a5c72a5638404ad9484f8805d70e9a";

// --- ENCRYPTED driver: better-sqlite3-multiple-ciphers, VENDORED in-repo -----------------------------
// No upstream Android/ABI-108 release exists; the prebuild is self-built (recipe + tarball vendored
// under apps/app/native-prebuilds/multiple-ciphers/). The JS wrapper is still installed from npm.
//
// RUNTIME-SUPPORT CAVEAT (release gate, not yet closed): this places a correct ABI-108 aarch64 binary
// that LOADS on nodejs-mobile's Node 18 — that's build evidence, not runtime proof. The MC JS wrapper's
// package.json declares `engines: node 20.x || 22.x || ...` (NOT Node 18), and ABI-108 symbol
// compatibility does not by itself prove the wrapper<->runtime path works on Node 18. Loading the
// wrapper + open/key + reopen(correct key)/reopen(wrong key) + rekey, under the EXACT embedded Node
// 18.20.4 on a physical arm64 device, is the explicit remaining RELEASE GATE (device-runtime
// verification — see the vendored README + docs/01). Desktop/CI covers the same ops but on host Node,
// a different runtime.
const MC_VERSION = "12.11.1";
const MC_ASSET = `better-sqlite3-multiple-ciphers-${MC_VERSION}-node-${ABI}-${ARCH}.tar.gz`;
// Pinned sha256 of the VENDORED tarball. Keep in lockstep with the README in that directory; update
// both if you rebuild the artifact from build-mc-android-arm64.sh.
const MC_PREBUILD_SHA256 = "40976b009278d0b1da04b8f6d34b0badf60469d7b26df68471ee08796f868ef4";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const projectDir = join(appDir, "nodejs-assets", "nodejs-project");
const nodeModulesDir = join(projectDir, "node_modules");
const vendoredMcTarball = join(
  appDir,
  "native-prebuilds",
  "multiple-ciphers",
  MC_ASSET,
);

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

/**
 * Materialise a driver's JS wrapper (+ runtime deps) into the embedded project's node_modules,
 * skipping native install scripts (we replace the binary ourselves), then trim the ~10MB C
 * amalgamation + build files that only matter at native-build time. Returns the driver's package root.
 */
function materialiseWrapper(pkgName, version, runtimePackages) {
  const scratch = mkdtempSync(join(tmpdir(), "loam-bsq-"));
  const pkgRoot = join(nodeModulesDir, pkgName);
  try {
    console.log(`Installing ${pkgName}@${version} JS wrapper (no native build)…`);
    run("npm", ["init", "-y"], { cwd: scratch, stdio: "ignore" });
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        `${pkgName}@${version}`,
      ],
      { cwd: scratch },
    );

    for (const pkg of runtimePackages) {
      const src = join(scratch, "node_modules", pkg);
      if (!existsSync(src)) {
        throw new Error(`Expected ${pkg} in the installed tree but it was missing.`);
      }
      rmSync(join(nodeModulesDir, pkg), { recursive: true, force: true });
      cpSync(src, join(nodeModulesDir, pkg), { recursive: true });
    }

    // Trim the C amalgamation + build files: only lib/ (+ the prebuilt .node) run at runtime.
    // Removing the .gyp files also stops gradle's native-rebuild auto-detection from tripping (it
    // scans for *.gyp under nodejs-project) — belt-and-suspenders alongside BUILD_NATIVE_MODULES.txt=0.
    for (const cruft of ["deps", "src", "binding.gyp"]) {
      rmSync(join(pkgRoot, cruft), { recursive: true, force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return pkgRoot;
}

/** Refuse to install a native binary whose sha256 doesn't match the pin (tamper/MITM/corruption). */
function verifySha256(tarballPath, expected, assetName) {
  const actual = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${assetName}:\n  expected ${expected}\n  got      ${actual}\n` +
        "Refusing to install an unverified native binary.",
    );
  }
}

/**
 * Extract the flat tarball's single ./better_sqlite3.node into <pkgRoot>/build/Release/, replacing
 * whatever was there. Asserts the binary landed. Caller must have verified the tarball first.
 */
function extractBinary(tarballPath, pkgRoot, assetName) {
  const releaseDir = join(pkgRoot, "build", "Release");
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });
  run("tar", ["xzf", tarballPath, "-C", releaseDir]);

  const binary = join(releaseDir, "better_sqlite3.node");
  if (!existsSync(binary)) {
    throw new Error(`Extraction did not produce ${binary}. Check the tarball layout for ${assetName}.`);
  }
  return binary;
}

mkdirSync(projectDir, { recursive: true });
mkdirSync(nodeModulesDir, { recursive: true });

// ====================================================================================================
// 1. PLAIN better-sqlite3 — wrapper from npm, binary downloaded from digidem (verified by sha256).
// ====================================================================================================
const bsqRoot = materialiseWrapper(
  "better-sqlite3",
  BETTER_SQLITE3_VERSION,
  ["better-sqlite3", "bindings", "file-uri-to-path"],
);

{
  const downloadDir = mkdtempSync(join(tmpdir(), "loam-bsq-dl-"));
  try {
    const tarball = join(downloadDir, ASSET);
    console.log(`Downloading prebuilt native binary:\n  ${PREBUILD_URL}`);
    run("curl", ["--fail", "--location", "--silent", "--show-error", "-o", tarball, PREBUILD_URL]);
    verifySha256(tarball, PREBUILD_SHA256, ASSET);
    const binary = extractBinary(tarball, bsqRoot, ASSET);
    console.log(`\n✓ better-sqlite3@${BETTER_SQLITE3_VERSION} (${ARCH}, ABI ${ABI}) ready:`);
    console.log(`  ${binary.replace(`${appDir}/`, "")}`);
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

// ====================================================================================================
// 2. ENCRYPTED better-sqlite3-multiple-ciphers — wrapper from npm, binary from the VENDORED prebuild
//    (verify sha256 against the pin BEFORE extracting, exactly like the plain path). Both drivers ship
//    so encrypted deployments (security.dbEncryption) work on-device without touching the plain flow.
// ====================================================================================================
const mcRoot = materialiseWrapper(
  "better-sqlite3-multiple-ciphers",
  MC_VERSION,
  ["better-sqlite3-multiple-ciphers", "bindings", "file-uri-to-path"],
);

{
  if (!existsSync(vendoredMcTarball)) {
    throw new Error(
      `Vendored prebuild missing: ${vendoredMcTarball}\n` +
        "Expected the self-built better-sqlite3-multiple-ciphers android-arm64 tarball to be committed " +
        "under apps/app/native-prebuilds/multiple-ciphers/ (see its README).",
    );
  }
  verifySha256(vendoredMcTarball, MC_PREBUILD_SHA256, MC_ASSET);
  const binary = extractBinary(vendoredMcTarball, mcRoot, MC_ASSET);
  console.log(`\n✓ better-sqlite3-multiple-ciphers@${MC_VERSION} (${ARCH}, ABI ${ABI}) ready:`);
  console.log(`  ${binary.replace(`${appDir}/`, "")}`);
  console.log("  (SQLCipher/encrypted driver, from the vendored prebuild — sha256 verified)");
}

console.log(
  "\n✓ Both SQLite drivers placed (plain + SQLCipher). security.dbEncryption modes are wired " +
    "on-device, pending on-device PRAGMA-key runtime verification (docs/01).",
);
