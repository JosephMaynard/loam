#!/usr/bin/env node
// Places the plain (UNENCRYPTED) better-sqlite3 native module into the nodejs-mobile project so the
// embedded server can open its SQLite DB on the device's Node 18 (which has no node:sqlite). See
// docs/04 and docs/01.
//
// What it does:
//   1. Materialises the better-sqlite3 JS wrapper (+ its runtime deps bindings, file-uri-to-path)
//      at a pinned version, WITHOUT running its native install script (we don't want a host build).
//   2. Downloads the matching ABI-108 android-arm64 prebuilt binary from
//      digidem/better-sqlite3-nodejs-mobile (the CoMapeo-proven prebuild) and drops it where the
//      `bindings` module resolves it: node_modules/better-sqlite3/build/Release/better_sqlite3.node.
//
// The JS wrapper version and the .node source version MUST match (ABI 108 only guarantees the binary
// loads into Node 18; the JS<->native API surface must also line up). Change both together.
//
// Encryption on device (better-sqlite3-multiple-ciphers) is a follow-up: it needs an equivalent
// ABI-108 android prebuild that does not exist yet (docs/01).
//
// Usage: pnpm --filter app fetch:native

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned pair: the JS wrapper npm version and the digidem release tag (same number). android-arm64,
// Node ABI 108. Fallback if this fails to load on-device: 11.10.0 (the version CoMapeo ships).
const BETTER_SQLITE3_VERSION = "12.10.0";
const ARCH = "android-arm64"; // matches the arm64-v8a APK we build (see plugins/with-loam-host.js)
const ABI = "108"; // Node 18 (embedded nodejs-mobile runtime)
const RELEASE_TAG = BETTER_SQLITE3_VERSION;
const ASSET = `better-sqlite3-${BETTER_SQLITE3_VERSION}-node-${ABI}-${ARCH}.tar.gz`;
const PREBUILD_URL = `https://github.com/digidem/better-sqlite3-nodejs-mobile/releases/download/${RELEASE_TAG}/${ASSET}`;
// Pinned sha256 of the tarball above — we refuse to install a native binary that doesn't match, so a
// compromised/replaced release or a MITM can't slip a different .node onto the device. Update this
// together with BETTER_SQLITE3_VERSION.
const PREBUILD_SHA256 = "00d84fcd41b80bbc910c0531320763f8f1a5c72a5638404ad9484f8805d70e9a";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const projectDir = join(appDir, "nodejs-assets", "nodejs-project");
const nodeModulesDir = join(projectDir, "node_modules");
const bsqRoot = join(nodeModulesDir, "better-sqlite3");
const releaseDir = join(bsqRoot, "build", "Release");

// Runtime deps of better-sqlite3's JS wrapper (prebuild-install is install-time only, not shipped).
const RUNTIME_PACKAGES = ["better-sqlite3", "bindings", "file-uri-to-path"];

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

mkdirSync(projectDir, { recursive: true });
mkdirSync(nodeModulesDir, { recursive: true });

// 1. Materialise the JS wrapper + runtime deps in a throwaway dir, skipping native install scripts
//    (we replace the binary ourselves). npm gives a real (non-symlinked) tree that's easy to copy.
const scratch = mkdtempSync(join(tmpdir(), "loam-bsq-"));
try {
  console.log(`Installing better-sqlite3@${BETTER_SQLITE3_VERSION} JS wrapper (no native build)…`);
  run("npm", ["init", "-y"], { cwd: scratch, stdio: "ignore" });
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      `better-sqlite3@${BETTER_SQLITE3_VERSION}`,
    ],
    { cwd: scratch },
  );

  for (const pkg of RUNTIME_PACKAGES) {
    const src = join(scratch, "node_modules", pkg);
    if (!existsSync(src)) {
      throw new Error(`Expected ${pkg} in the installed tree but it was missing.`);
    }
    rmSync(join(nodeModulesDir, pkg), { recursive: true, force: true });
    cpSync(src, join(nodeModulesDir, pkg), { recursive: true });
  }

  // Trim the ~10MB C amalgamation + build files: only lib/ (+ the prebuilt .node) run at runtime.
  // Removing the .gyp files also stops gradle's native-rebuild auto-detection from tripping (it
  // scans for *.gyp under nodejs-project) — belt-and-suspenders alongside BUILD_NATIVE_MODULES.txt=0.
  for (const cruft of ["deps", "src", "binding.gyp"]) {
    rmSync(join(bsqRoot, cruft), { recursive: true, force: true });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// 2. Download the android-arm64 ABI-108 prebuilt binary to a temp file, VERIFY its checksum, and
//    only then populate releaseDir — so a failed, truncated, or tampered download never leaves an
//    unverified (or missing) binary in the project. The tarball is flat: a single ./better_sqlite3.node.
const downloadDir = mkdtempSync(join(tmpdir(), "loam-bsq-dl-"));
try {
  const tarball = join(downloadDir, ASSET);
  console.log(`Downloading prebuilt native binary:\n  ${PREBUILD_URL}`);
  run("curl", ["--fail", "--location", "--silent", "--show-error", "-o", tarball, PREBUILD_URL]);

  const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (actual !== PREBUILD_SHA256) {
    throw new Error(
      `Checksum mismatch for ${ASSET}:\n  expected ${PREBUILD_SHA256}\n  got      ${actual}\n` +
        "Refusing to install an unverified native binary.",
    );
  }

  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });
  run("tar", ["xzf", tarball, "-C", releaseDir]);
} finally {
  rmSync(downloadDir, { recursive: true, force: true });
}

const binary = join(releaseDir, "better_sqlite3.node");
if (!existsSync(binary)) {
  throw new Error(`Extraction did not produce ${binary}. Check the tarball layout for ${ASSET}.`);
}

console.log(`\n✓ better-sqlite3@${BETTER_SQLITE3_VERSION} (${ARCH}, ABI ${ABI}) ready:`);
console.log(`  ${binary.replace(`${appDir}/`, "")}`);
console.log("  (unencrypted; on-device encryption is a follow-up — docs/01)");
