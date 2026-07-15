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
# ── Reproducibility note — what IS and ISN'T pinned (honest accounting) ───────
# The DIRECT build inputs below are pinned to an exact version (npm) or commit
# SHA (GitHub): the MC source, the cmake tooling (cmake-bare/cmake-fetch),
# `bare-make` (installed LOCALLY, exact-pinned, invoked by local path — not a
# global `@latest`), and the cmake-napi fork (which fixes the nodejs-mobile
# Node/ABI target). What is NOT fully pinned, stated plainly:
#   • TRANSITIVE deps — the `npm install` of the MC package's own deps and of
#     the cmake tooling resolve their transitive graph fresh; there is no
#     committed lockfile in this dir, so those CAN drift within semver. A
#     committed package-lock.json consumed via `npm ci` is the robust
#     follow-up (see the "residual" note in README.md). This is the documented
#     residual, not an oversight.
#   • The HOST toolchain — cmake / binutils / bash are the caller's, EXCEPT the
#     NDK revision and a cmake minimum, which this script now ASSERTS up front
#     (version-gate block below) and aborts on mismatch, so a wrong
#     caller-supplied NDK/CMake is caught rather than silently used.
#   • The raw .node is NOT byte-identical across machines regardless: the linker
#     embeds a build-id (and paths/timestamps can leak in), so two builds from
#     identical pinned sources can differ in a handful of bytes.
# Because bit-for-bit reproducibility is neither achievable nor the goal, the
# AUTHORITY lives elsewhere and does not depend on perfect pinning:
#   (1) the committed tarball is pinned by sha256 in fetch-native-modules.mjs
#       (MC_PREBUILD_SHA256), and
#   (2) step 6 runs a HARD ABI/symbol gate (readelf) that a wrong/incompatible
#       binary CANNOT pass (no `|| true`, no print-and-succeed; exits non-zero
#       on any failure). A rebuilder compares the ABI/symbol shape (step 6), not
#       the hash — transitive drift that changed the binary's shape is caught there.
#
# To bump any pin: change the exact version / SHA below, re-run, and update
# MC_PREBUILD_SHA256 (+ the README checksum) with the value this script prints.
#
# Requirements: Node 20+ (host), Android NDK 27.1.12297006 (asserted), cmake
# >= 3.25 (asserted), and llvm-readelf (ships inside the NDK toolchain; the
# step-6 gate prefers it, then falls back to a PATH llvm-readelf/readelf).
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

# --- Host/NDK version gate (pinned; asserts a caller-supplied wrong NDK/CMake) ---
# ANDROID_NDK_HOME may be ANY NDK the caller has installed/exported — it is NOT
# pinned by this script. Assert the revision so the binary is built against the
# toolchain LOAM validated, not silently against whatever happens to be present.
REQUIRED_NDK_REVISION="27.1.12297006"     # exact pin; patch-compatible range = 27.1.*
MIN_CMAKE_VERSION="3.25"                   # documented minimum for the bare-make/cmake recipe

# assert_ndk_revision: read $ANDROID_NDK_HOME/source.properties (Pkg.Revision) and
# require the pinned 27.1.* line; abort on a wrong/missing NDK.
assert_ndk_revision() {
  local props="$ANDROID_NDK_HOME/source.properties" rev
  if [ ! -f "$props" ]; then
    echo "ERROR: ANDROID_NDK_HOME='$ANDROID_NDK_HOME' has no source.properties — not a valid NDK." >&2
    exit 1
  fi
  rev="$(sed -n 's/^Pkg\.Revision[[:space:]]*=[[:space:]]*//p' "$props" | head -1)"
  if [ "$rev" = "$REQUIRED_NDK_REVISION" ]; then
    echo "OK: Android NDK revision ${rev} (pinned)."
  elif printf '%s' "$rev" | grep -qE '^27\.1\.'; then
    echo "WARN: Android NDK revision ${rev} differs from the pin ${REQUIRED_NDK_REVISION}" \
         "but is within the documented-compatible 27.1.* range — proceeding." >&2
  else
    echo "ERROR: Android NDK revision ${rev} is not the pinned ${REQUIRED_NDK_REVISION}" \
         "(nor a 27.1.* patch). Point ANDROID_NDK_HOME at the pinned NDK before building." >&2
    exit 1
  fi
}

# assert_cmake_version: require host cmake >= $MIN_CMAKE_VERSION (major.minor compare).
assert_cmake_version() {
  if ! command -v cmake >/dev/null 2>&1; then
    echo "ERROR: cmake not found on PATH (need >= ${MIN_CMAKE_VERSION})." >&2
    exit 1
  fi
  local ver ma mi rmin_ma rmin_mi
  ver="$(cmake --version 2>/dev/null | sed -n 's/^cmake version[[:space:]]*//p' | head -1)"
  ma="${ver%%.*}"; mi="${ver#*.}"; mi="${mi%%.*}"
  rmin_ma="${MIN_CMAKE_VERSION%%.*}"; rmin_mi="${MIN_CMAKE_VERSION#*.}"
  if [ -z "${ma:-}" ] || [ -z "${mi:-}" ] || ! [ "$ma" -eq "$ma" ] 2>/dev/null; then
    echo "ERROR: could not parse cmake version from '${ver}'." >&2
    exit 1
  fi
  if [ "$ma" -lt "$rmin_ma" ] || { [ "$ma" -eq "$rmin_ma" ] && [ "$mi" -lt "$rmin_mi" ]; }; then
    echo "ERROR: cmake ${ver} is older than the required minimum ${MIN_CMAKE_VERSION}." >&2
    exit 1
  fi
  echo "OK: host cmake ${ver} (>= ${MIN_CMAKE_VERSION})."
}

# resolve_readelf: prefer the NDK toolchain's llvm-readelf (portable, ships with
# the NDK we build against), then any llvm-readelf/readelf on PATH.
resolve_readelf() {
  local ndk_re=""
  if [ -n "${ANDROID_NDK_HOME:-}" ]; then
    ndk_re="$(ls "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-readelf 2>/dev/null | head -1)"
  fi
  if [ -n "$ndk_re" ] && [ -x "$ndk_re" ]; then printf '%s\n' "$ndk_re"; return 0; fi
  if command -v llvm-readelf >/dev/null 2>&1; then command -v llvm-readelf; return 0; fi
  if command -v readelf     >/dev/null 2>&1; then command -v readelf;     return 0; fi
  return 1
}

# sym_defined <binary> <readelf> <name> -> exit 0 iff <name> is a DEFINED dynamic
# symbol (present AND its Ndx column is not "UND"). Robust to column alignment:
# matches the last field (Name) and inspects the second-to-last (Ndx).
sym_defined() {
  "$2" --dyn-syms "$1" 2>/dev/null | awk -v s="$3" '
    $NF == s && $(NF-1) != "UND" { found = 1 }
    END { exit(found ? 0 : 1) }'
}

# verify_node_abi <binary> <readelf> -> exit 0 iff ALL checks pass; else non-zero.
# HARD GATE: prints PASS/FAIL per check and fails closed on any mismatch. This is
# the ABI-108/Node-18 lock — it asserts node_register_module_v108 (NOT N-API),
# the MultipleCiphers encryption exports, and a minimal NEEDED set (no external
# crypto lib). A wrong/incompatible .node cannot pass.
verify_node_abi() {
  local bin="$1" re="$2" fails=0 s lib needed hdr class machine etype
  # ABI-108 Node module entry (Node/V8 ABI addon, NOT N-API) + MC encryption exports.
  local REQ_SYMS="node_register_module_v108 sqlite3_key sqlite3_rekey sqlite3mc_config"
  local OPT_SYMS="sqlite3_key_v2 sqlite3mc_config_cipher"
  local NEEDED_ALLOW="libnode.so libm.so libdl.so libc.so"

  echo "== ABI/symbol verification (HARD GATE): $bin =="
  if [ ! -f "$bin" ]; then echo "  FAIL: file not found"; return 1; fi

  hdr="$("$re" -h "$bin" 2>/dev/null || true)"
  class="$(printf '%s\n'   "$hdr" | sed -n 's/.*Class:[[:space:]]*//p'   | head -1)"
  machine="$(printf '%s\n' "$hdr" | sed -n 's/.*Machine:[[:space:]]*//p' | head -1)"
  etype="$(printf '%s\n'   "$hdr" | sed -n 's/.*Type:[[:space:]]*//p'    | head -1)"
  if printf '%s' "$class"   | grep -qiw 'ELF64'  ; then echo "  PASS: ELF class ELF64 ($class)"; else echo "  FAIL: ELF class not ELF64 (got '$class')"; fails=$((fails+1)); fi
  if printf '%s' "$machine" | grep -qi  'AArch64'; then echo "  PASS: machine AArch64 ($machine)"; else echo "  FAIL: machine not AArch64 (got '$machine')"; fails=$((fails+1)); fi
  if printf '%s' "$etype"   | grep -qi  'DYN'    ; then echo "  PASS: ELF type DYN/shared ($etype)"; else echo "  FAIL: ELF type not DYN (got '$etype')"; fails=$((fails+1)); fi

  for s in $REQ_SYMS; do
    if sym_defined "$bin" "$re" "$s"; then echo "  PASS: symbol DEFINED: $s"; else echo "  FAIL: required symbol NOT defined: $s"; fails=$((fails+1)); fi
  done
  for s in $OPT_SYMS; do
    if sym_defined "$bin" "$re" "$s"; then echo "  PASS: optional symbol DEFINED: $s"; else echo "  note: optional symbol absent (ok): $s"; fi
  done

  needed="$("$re" -d "$bin" 2>/dev/null | awk -F'[][]' '/\(NEEDED\)/{print $2}')"
  if printf '%s\n' "$needed" | grep -qx 'libnode.so'; then echo "  PASS: links nodejs-mobile runtime (libnode.so NEEDED)"; else echo "  FAIL: libnode.so not in NEEDED (not linked against the embedded runtime)"; fails=$((fails+1)); fi
  for lib in $needed; do
    case " $NEEDED_ALLOW " in
      *" $lib "*) : ;;
      *) echo "  FAIL: unexpected NEEDED dependency: $lib"; fails=$((fails+1)) ;;
    esac
  done
  if printf '%s\n' "$needed" | grep -qiE 'libssl|libcrypto|libgnutls|libmbedtls|libnss'; then
    echo "  FAIL: links an external crypto library (MC uses its bundled cipher; none expected)"; fails=$((fails+1))
  else
    echo "  PASS: no external crypto library in NEEDED (bundled cipher only)"
  fi
  echo "  NEEDED set: $(printf '%s ' $needed)"

  if [ "$fails" -ne 0 ]; then echo "== ABI/symbol verification FAILED ($fails check(s)) =="; return 1; fi
  echo "== ABI/symbol verification PASSED =="
  return 0
}

# Run the version gates now, before any build work.
assert_ndk_revision
assert_cmake_version

WORK="$(pwd)/mc-build"
HERE="$(cd "$(dirname "$0")" && pwd)"   # dir holding this script + CMakeLists.mc.txt
rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

# 1. Fetch MC npm source (exact version)
npm pack "better-sqlite3-multiple-ciphers@${MC_VERSION}"
tar -zxvf "better-sqlite3-multiple-ciphers-${MC_VERSION}.tgz"
cd package

# 2. Deps (no native build) + PINNED cmake tooling + PINNED cmake-napi fork
#    (targets nodejs-mobile). Every DIRECT tool is exact-pinned and installed
#    LOCALLY (into package/node_modules) so nothing depends on a global/`@latest`
#    install. `--save-exact` writes exact specs (no `^`/`~`) for any package.json
#    churn. RESIDUAL (documented, see README): the transitive graph of these
#    installs is not lockfile-pinned — a committed package-lock.json consumed via
#    `npm ci` is the robust follow-up; the step-6 ABI/symbol gate is the
#    compensating control that catches drift which changed the binary's shape.
npm install --ignore-scripts --no-audit --no-fund
npm install -D --ignore-scripts --save-exact \
  "cmake-bare@${CMAKE_BARE_VERSION}" \
  "cmake-fetch@${CMAKE_FETCH_VERSION}"
npm install -D --ignore-scripts --save-exact \
  "cmake-napi@github:digidem/cmake-napi-nodejs-mobile#${CMAKE_NAPI_REF}"
# bare-make: LOCAL exact-pinned install (was a global `@latest`). Invoked below
# by its resolved local path — never a bare `npx bare-make` (which could fetch a
# different version if the local one were absent).
npm install -D --ignore-scripts --save-exact "bare-make@${BARE_MAKE_VERSION}"
BARE_MAKE="$(pwd)/node_modules/.bin/bare-make"
if [ ! -x "$BARE_MAKE" ]; then
  echo "ERROR: local bare-make@${BARE_MAKE_VERSION} not found at $BARE_MAKE after install." >&2
  exit 1
fi

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
"$BARE_MAKE" generate --platform android --arch arm64 \
  -D CMAKE_SHARED_LINKER_FLAGS="-Wl,-z,max-page-size=16384" \
  -D ANDROID_PLATFORM=android-24
"$BARE_MAKE" build
"$BARE_MAKE" install

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

# 6. HARD ABI/symbol gate (what IS reproducible — see the note up top). This is
#    a fail-closed verification: it exits non-zero unless the freshly built .node
#    is exactly an ABI-108 aarch64 MultipleCiphers module with the right exports
#    and a minimal NEEDED set. No `|| true`, no print-and-succeed. (Round-8 P2-2:
#    the old check advertised the WRONG symbol — napi_register_module_v1 — and
#    could not fail; a wrong binary passed. This asserts node_register_module_v108
#    and the MC encryption exports instead.)
echo
READELF="$(resolve_readelf)" || {
  echo "ERROR: no readelf/llvm-readelf available for the ABI gate (expected inside \$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/*/bin)." >&2
  exit 1
}
echo "Using readelf: $READELF"
if ! verify_node_abi "prebuilds/android-arm64/better_sqlite3.node" "$READELF"; then
  echo "ERROR: ABI/symbol gate FAILED — refusing to publish this binary." >&2
  exit 1
fi

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
