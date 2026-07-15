#!/usr/bin/env bash
# Reproducible cross-compile of better-sqlite3-multiple-ciphers for
# nodejs-mobile Node 18.20.4 / ABI 108, android-arm64.
#
# Replicates digidem/better-sqlite3-nodejs-mobile's recipe with the
# multiple-ciphers source swapped in. The custom CMakeLists.txt is
# digidem's, with MC's two extra SQLite defines added.
#
# Requirements: Node 20+ (host), Android NDK 27.x, cmake.
set -euo pipefail

MC_VERSION="12.11.1"
NODE_VERSION="18.20.4"   # nodejs-mobile embedded Node -> ABI 108
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/27.1.12297006}"

WORK="$(pwd)/mc-build"
rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

# 1. Fetch MC npm source
npm pack "better-sqlite3-multiple-ciphers@${MC_VERSION}"
tar -zxvf "better-sqlite3-multiple-ciphers-${MC_VERSION}.tgz"
cd package

# 2. Deps (no native build) + cmake tooling + patched cmake-napi (targets nodejs-mobile)
npm install --ignore-scripts --no-audit --no-fund
npm install -D --ignore-scripts cmake-bare cmake-fetch
npm install -D --ignore-scripts cmake-napi@github:digidem/cmake-napi-nodejs-mobile
npm install -g bare-make@latest

# 3. CMakeLists.txt: digidem's, plus MC's extra defines
#    (SQLITE_ENABLE_PERCENTILE, SQLITE_USER_AUTHENTICATION=0). Amalgamation
#    lives at the same deps/sqlite3/sqlite3.c path, src at src/better_sqlite3.cpp,
#    so digidem's CMakeLists is otherwise drop-in.
cp "$WORK/../CMakeLists.mc.txt" ./CMakeLists.txt   # provided alongside this script

# 4. Generate / build / install (android-24 pin avoids RELR SIGSEGV on Android <9;
#    16KB max-page-size for modern devices)
npx bare-make generate --platform android --arch arm64 \
  -D CMAKE_SHARED_LINKER_FLAGS="-Wl,-z,max-page-size=16384" \
  -D ANDROID_PLATFORM=android-24
npx bare-make build
npx bare-make install

# 5. Rename kebab -> snake for better-sqlite3's bindings loader
mv prebuilds/android-arm64/better-sqlite3-multiple-ciphers.node \
   prebuilds/android-arm64/better_sqlite3.node

file prebuilds/android-arm64/better_sqlite3.node
echo "OK -> $WORK/package/prebuilds/android-arm64/better_sqlite3.node"
