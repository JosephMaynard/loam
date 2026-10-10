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
//      version from the npm tarballs VENDORED at apps/app/native-prebuilds/npm/, each verified against a
//      sha256 pin before it is unpacked. Nothing comes from the npm registry at build time, and no
//      install script runs (we don't want a host build).
//   2. Places the matching ABI-108 android-arm64 native binary where the `bindings` module resolves it
//      (node_modules/<pkg>/build/Release/better_sqlite3.node), after verifying its sha256.
//
// Binary sources differ by driver:
//   - better-sqlite3 (plain): digidem/better-sqlite3-nodejs-mobile's (CoMapeo-proven) 12.10.0 binary,
//     VENDORED in the repo at apps/app/native-prebuilds/better-sqlite3/ and pinned by sha256. It used to
//     be downloaded, but upstream re-generated that release's assets on 2026-08-17 (a maintainer-run
//     prebuild workflow, non-reproducible), so the pinned download stopped matching. The vendored file
//     is the binary from the ORIGINAL release that previous LOAM APKs shipped — see its README.
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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ARCH = "android-arm64"; // matches the arm64-v8a APK we build (see plugins/with-loam-host.js)
const ABI = "108"; // Node 18 (embedded nodejs-mobile runtime)

// --- PLAIN driver: better-sqlite3, digidem's prebuild VENDORED in-repo ---------------------------------
// Pinned pair: the JS wrapper npm version and the digidem release tag (same number). android-arm64,
// Node ABI 108. Fallback if this fails to load on-device: 11.10.0 (the version CoMapeo ships).
const BETTER_SQLITE3_VERSION = "12.10.0";
const RELEASE_TAG = BETTER_SQLITE3_VERSION;
const ASSET = `better-sqlite3-${BETTER_SQLITE3_VERSION}-node-${ABI}-${ARCH}.tar.gz`;
// Upstream provenance (not fetched any more): the original asset at this URL had sha256
// 00d84fcd41b80bbc910c0531320763f8f1a5c72a5638404ad9484f8805d70e9a; the vendored tarball repackages the
// .node extracted from it (the .node's own sha256 is a338a11b261c3db217cddf3b7597ce265ae02780bf55c55cbb677c940dc7a9a7).
const PREBUILD_URL = `https://github.com/digidem/better-sqlite3-nodejs-mobile/releases/download/${RELEASE_TAG}/${ASSET}`;
// Pinned sha256 of the VENDORED tarball — we refuse to install a native binary that doesn't match. Keep
// in lockstep with apps/app/native-prebuilds/better-sqlite3/README.md.
const PREBUILD_SHA256 = "c454974e7194fb078830e9c7c494477cfd41cd963c125225d995f128749b7241";

// --- ENCRYPTED driver: better-sqlite3-multiple-ciphers, VENDORED in-repo -----------------------------
// No upstream Android/ABI-108 release exists; the prebuild is self-built (recipe + tarball vendored
// under apps/app/native-prebuilds/multiple-ciphers/). The JS wrapper is vendored too (NPM_TARBALLS below).
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

// The JS packages the embedded server loads at runtime: both drivers' wrappers and the two dependencies
// they share (wrapper → bindings → file-uri-to-path). Each is an `npm pack` tarball VENDORED at
// apps/app/native-prebuilds/npm/ and pinned by sha256 here: this code runs inside the process that holds
// the DB key, so a build must not take whatever the registry serves that day (a version pin alone doesn't
// fix the bytes; the vendored tarball does). The wrappers' other dependency, prebuild-install, only runs at
// install time and isn't needed. Keep in lockstep with apps/app/native-prebuilds/npm/README.md, and bump
// deliberately, together with the driver versions above.
const NPM_TARBALLS = {
  "better-sqlite3": {
    version: BETTER_SQLITE3_VERSION,
    sha256: "842b5442b62913e6b9378394ade4e80d5d2e4bbb537e0c20b11bc4cf58313d3f",
  },
  "better-sqlite3-multiple-ciphers": {
    version: MC_VERSION,
    sha256: "01388c78f46ce63c6aec021f67b364cc67bd637edba64f7add0c0230ce5f777a",
  },
  bindings: { version: "1.5.0", sha256: "d77781178c5bd89a91b1f6c5556acd511b1b5927eb13e2ad8189cac29eeb0907" },
  "file-uri-to-path": {
    version: "1.0.0",
    sha256: "5440cdf67e75ab96f36a6be63c1d4c3d54255b1d0970273710fecfebfab06fb3",
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const projectDir = join(appDir, "nodejs-assets", "nodejs-project");
const nodeModulesDir = join(projectDir, "node_modules");
const vendoredPlainTarball = join(appDir, "native-prebuilds", "better-sqlite3", ASSET);
const vendoredMcTarball = join(
  appDir,
  "native-prebuilds",
  "multiple-ciphers",
  MC_ASSET,
);
const vendoredNpmDir = join(appDir, "native-prebuilds", "npm");

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

/**
 * Materialise a driver's JS wrapper (+ runtime deps) into the embedded project's node_modules from the
 * vendored, sha256-verified npm tarballs (no registry, no install scripts; we replace the binary
 * ourselves), then trim the ~10MB C amalgamation + build files that only matter at native-build time.
 * Returns the driver's package root.
 */
function materialiseWrapper(pkgName, runtimePackages) {
  if (!NPM_TARBALLS[pkgName] || !runtimePackages.includes(pkgName)) {
    throw new Error(`No vendored tarball is pinned and listed for the ${pkgName} wrapper.`);
  }
  console.log(`Installing ${pkgName}@${NPM_TARBALLS[pkgName].version} JS wrapper from the vendored tarball…`);
  for (const pkg of runtimePackages) {
    const pin = NPM_TARBALLS[pkg];
    if (!pin) {
      throw new Error(`No vendored tarball is pinned for ${pkg}.`);
    }
    const fileName = `${pkg}-${pin.version}.tgz`;
    const tarball = join(vendoredNpmDir, fileName);
    if (!existsSync(tarball)) {
      throw new Error(
        `Vendored npm tarball missing: ${tarball}\n` +
          "Expected it to be committed under apps/app/native-prebuilds/npm/ (see its README).",
      );
    }
    verifySha256(tarball, pin.sha256, fileName);
    // An `npm pack` tarball keeps everything under `package/`; unpack it as node_modules/<pkg>.
    const dest = join(nodeModulesDir, pkg);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    try {
      run("tar", ["xzf", tarball, "-C", dest, "--strip-components=1"]);
      const manifestPath = join(dest, "package.json");
      const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
      if (manifest.name !== pkg || manifest.version !== pin.version) {
        throw new Error(
          `${fileName} unpacked as ${manifest.name ?? "?"}@${manifest.version ?? "?"}, expected ${pkg}@${pin.version}.`,
        );
      }
    } catch (error) {
      // Never leave a partial or wrong package behind for a later step to pick up.
      rmSync(dest, { recursive: true, force: true });
      throw error;
    }
  }

  // Trim the C amalgamation + build files: only lib/ (+ the prebuilt .node) run at runtime.
  // Removing the .gyp files also stops gradle's native-rebuild auto-detection from tripping (it
  // scans for *.gyp under nodejs-project) — belt-and-suspenders alongside BUILD_NATIVE_MODULES.txt=0.
  const pkgRoot = join(nodeModulesDir, pkgName);
  for (const cruft of ["deps", "src", "binding.gyp"]) {
    rmSync(join(pkgRoot, cruft), { recursive: true, force: true });
  }
  return pkgRoot;
}

/** Refuse to install a tarball (native binary or JS package) whose sha256 doesn't match the pin. */
function verifySha256(tarballPath, expected, assetName) {
  const actual = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${assetName}:\n  expected ${expected}\n  got      ${actual}\n` +
        "Refusing to install an unverified tarball.",
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
// 1. PLAIN better-sqlite3: wrapper from its VENDORED npm tarball, binary from the VENDORED digidem
//    prebuild (both sha256-verified).
// ====================================================================================================
const bsqRoot = materialiseWrapper("better-sqlite3", ["better-sqlite3", "bindings", "file-uri-to-path"]);

{
  if (!existsSync(vendoredPlainTarball)) {
    throw new Error(
      `Vendored prebuild missing: ${vendoredPlainTarball}\n` +
        "Expected digidem's better-sqlite3 android-arm64 tarball to be committed under " +
        `apps/app/native-prebuilds/better-sqlite3/ (see its README; upstream: ${PREBUILD_URL}).`,
    );
  }
  verifySha256(vendoredPlainTarball, PREBUILD_SHA256, ASSET);
  const binary = extractBinary(vendoredPlainTarball, bsqRoot, ASSET);
  console.log(`\n✓ better-sqlite3@${BETTER_SQLITE3_VERSION} (${ARCH}, ABI ${ABI}) ready:`);
  console.log(`  ${binary.replace(`${appDir}/`, "")}`);
}

// ====================================================================================================
// 2. ENCRYPTED better-sqlite3-multiple-ciphers: wrapper from its VENDORED npm tarball, binary from the
//    VENDORED prebuild
//    (verify sha256 against the pin BEFORE extracting, exactly like the plain path). Both drivers ship
//    so encrypted deployments (security.dbEncryption) work on-device without touching the plain flow.
// ====================================================================================================
const mcRoot = materialiseWrapper("better-sqlite3-multiple-ciphers", [
  "better-sqlite3-multiple-ciphers",
  "bindings",
  "file-uri-to-path",
]);

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
