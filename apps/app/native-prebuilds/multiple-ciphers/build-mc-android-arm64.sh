#!/usr/bin/env bash
# Reproducible cross-compile of better-sqlite3-multiple-ciphers for
# nodejs-mobile Node 18.20.4 / ABI 108, android-arm64.
#
# Replicates digidem/better-sqlite3-nodejs-mobile's recipe with the
# multiple-ciphers source swapped in. The CMakeLists.txt is digidem's, used
# AS-IS: it carries the stock better-sqlite3 SQLite defines and adds NO
# MultipleCiphers-specific SQL feature toggles (in particular it does NOT set
# SQLITE_ENABLE_PERCENTILE or SQLITE_USER_AUTHENTICATION — LOAM doesn't use
# them, and the vendored binary was built without them; see README.md).
#
# ── Reproducibility note ─────────────────────────────────────────────────────
# Every build input below is PINNED to an exact version (npm) or commit SHA
# (GitHub) so the toolchain is deterministic. The resulting raw .node is still
# NOT guaranteed byte-identical across machines: the linker embeds a build-id
# (and paths/timestamps can leak in), so two builds from identical pinned
# sources can differ in a few bytes. What IS reproducible and auditable:
#   • the source (MC amalgamation @ MC_VERSION + digidem CMakeLists) and
#   • the toolchain (NDK + the pinned cmake tooling + nodejs-mobile headers) and
#   • the resulting symbol/ABI shape (verify with `readelf`, see step 6).
# The committed tarball is therefore pinned by sha256 in fetch-native-modules.mjs
# (MC_PREBUILD_SHA256); that pin — not a bit-for-bit rebuild — is what authorises
# the vendored artifact. A rebuilder compares the ABI/symbol shape, not the hash.
#
# To bump any pin: change the exact version / SHA below, re-run, and update
# MC_PREBUILD_SHA256 (+ the README checksum) with the value this script prints.
#
# Requirements: Node 20+ (host), Android NDK 27.x, cmake, readelf (binutils).
set -euo pipefail

MC_VERSION="12.11.1"
NODE_VERSION="18.20.4"   # nodejs-mobile embedded Node -> ABI 108 (the target runtime)
ABI="108"
ARCH="android-arm64"

# --- Pinned build inputs (exact versions / commit SHAs; see reproducibility note) ---
CMAKE_BARE_VERSION="1.8.0"
CMAKE_FETCH_VERSION="1.5.2"
BARE_MAKE_VERSION="1.8.0"
# digidem's cmake-napi fork that targets nodejs-mobile headers. Pinned to an
# EXACT commit, not a branch — the target Node/ABI version lives in THIS commit
# (its download_node_headers defaults VERSION to NODE_VERSION), so pinning the
# SHA is what pins the nodejs-mobile runtime the binary is compiled against.
CMAKE_NAPI_REF="0e344601443a11c636c39d1e19a11d6e5f871a35"  # digidem/cmake-napi-nodejs-mobile @ main, 2026-04-22

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/27.1.12297006}"

WORK="$(pwd)/mc-build"
HERE="$(cd "$(dirname "$0")" && pwd)"   # dir holding this script + CMakeLists.mc.txt
rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

# 1. Fetch MC npm source (exact version)
npm pack "better-sqlite3-multiple-ciphers@${MC_VERSION}"
tar -zxvf "better-sqlite3-multiple-ciphers-${MC_VERSION}.tgz"
cd package

# 2. Deps (no native build) + PINNED cmake tooling + PINNED cmake-napi fork
#    (targets nodejs-mobile). Every tool is exact-pinned so the recipe can't
#    silently drift when npm/GitHub move.
npm install --ignore-scripts --no-audit --no-fund
npm install -D --ignore-scripts \
  "cmake-bare@${CMAKE_BARE_VERSION}" \
  "cmake-fetch@${CMAKE_FETCH_VERSION}"
npm install -D --ignore-scripts \
  "cmake-napi@github:digidem/cmake-napi-nodejs-mobile#${CMAKE_NAPI_REF}"
npm install -g "bare-make@${BARE_MAKE_VERSION}"

# 2b. USE NODE_VERSION: the nodejs-mobile Node version the headers/libnode are
#     fetched for is decided by cmake-napi's download_node_headers default, NOT
#     by anything this script passes to cmake. Assert the pinned fork's default
#     matches our declared NODE_VERSION, so bumping CMAKE_NAPI_REF to a commit
#     that retargets a different Node/ABI fails loudly HERE instead of silently
#     producing a binary for the wrong runtime.
CMAKE_NAPI_NODE_DEFAULT="$(grep -oE 'ARGV_VERSION "[0-9]+\.[0-9]+\.[0-9]+"' \
  node_modules/cmake-napi/cmake-napi.cmake | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [ "$CMAKE_NAPI_NODE_DEFAULT" != "$NODE_VERSION" ]; then
  echo "ERROR: pinned cmake-napi (${CMAKE_NAPI_REF}) targets nodejs-mobile Node" \
       "${CMAKE_NAPI_NODE_DEFAULT}, but this recipe declares NODE_VERSION=${NODE_VERSION}." >&2
  echo "Reconcile NODE_VERSION with the cmake-napi pin (and re-check ABI=${ABI}) before building." >&2
  exit 1
fi
echo "OK: nodejs-mobile headers/libnode target Node ${NODE_VERSION} (ABI ${ABI}), driven by the pinned cmake-napi."

# 3. CMakeLists.txt: digidem's, used as-is (stock better-sqlite3 defines; no
#    MC-specific SQL toggles). Amalgamation lives at deps/sqlite3/sqlite3.c,
#    src at src/better_sqlite3.cpp, so digidem's CMakeLists is drop-in.
cp "$HERE/CMakeLists.mc.txt" ./CMakeLists.txt   # provided alongside this script

# 4. Generate / build / install (android-24 pin avoids RELR SIGSEGV on Android <9;
#    16KB max-page-size for modern devices)
npx bare-make generate --platform android --arch arm64 \
  -D CMAKE_SHARED_LINKER_FLAGS="-Wl,-z,max-page-size=16384" \
  -D ANDROID_PLATFORM=android-24
npx bare-make build
npx bare-make install

# 5. Rename kebab -> snake for better-sqlite3's bindings loader, then PACKAGE the
#    exact tarball fetch-native-modules.mjs expects (flat: a single
#    better_sqlite3.node at the tarball root) and compute its sha256 so a
#    rebuilder can compare against the pin.
mv prebuilds/android-arm64/better-sqlite3-multiple-ciphers.node \
   prebuilds/android-arm64/better_sqlite3.node

ASSET="better-sqlite3-multiple-ciphers-${MC_VERSION}-node-${ABI}-${ARCH}.tar.gz"
( cd prebuilds/android-arm64 && tar -czf "$WORK/$ASSET" better_sqlite3.node )

echo
file "prebuilds/android-arm64/better_sqlite3.node"

# 6. Verify the ABI/symbol shape (what IS reproducible — see the note up top),
#    then print the checksum to compare against MC_PREBUILD_SHA256.
echo
echo "== readelf: ELF header (expect ELF64 / AArch64 / DYN) =="
readelf -h "prebuilds/android-arm64/better_sqlite3.node" | \
  grep -E "Class|Machine|Type" || true
echo "== readelf: N-API entry symbol (expect napi_register_module_v1) =="
readelf -Ws "prebuilds/android-arm64/better_sqlite3.node" 2>/dev/null | \
  grep -i "napi_register_module_v1" || echo "(none listed — symbol may be local; inspect the full -Ws output)"

echo
echo "== Built artifact =="
echo "  tarball: $WORK/$ASSET"
echo "  sha256 (compare against MC_PREBUILD_SHA256 in apps/app/scripts/fetch-native-modules.mjs):"
shasum -a 256 "$WORK/$ASSET"
echo
echo "NOTE: the raw .node is not guaranteed byte-identical across builds (embedded"
echo "build-id); the sha256 above only authorises the artifact if it matches the"
echo "committed tarball. If you intentionally rebuilt, update MC_PREBUILD_SHA256 +"
echo "README to this value. Otherwise compare the ABI/symbol shape above instead."
echo "OK -> $WORK/package/prebuilds/android-arm64/better_sqlite3.node"
