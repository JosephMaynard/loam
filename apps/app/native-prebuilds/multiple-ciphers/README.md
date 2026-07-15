# Vendored prebuild: `better-sqlite3-multiple-ciphers` (android-arm64, ABI 108)

This directory holds a **self-built** native prebuild of
[`better-sqlite3-multiple-ciphers`](https://www.npmjs.com/package/better-sqlite3-multiple-ciphers)
— the SQLite3MultipleCiphers / SQLCipher-compatible encrypted SQLite driver — cross-compiled for
the LOAM Android host's embedded runtime:

- **Package / version:** `better-sqlite3-multiple-ciphers@12.11.1`
- **Target:** `android-arm64` (`aarch64-linux-android`), matching the arm64-v8a APK LOAM builds.
- **Node ABI:** 108 — nodejs-mobile's embedded **Node 18.20.4**. This is the same runtime the plain
  `better-sqlite3` prebuild targets (see `apps/app/scripts/fetch-native-modules.mjs`).
- **Cipher:** ChaCha20-Poly1305 default, SQLCipher-compatible mode available. **No OpenSSL** — chosen
  specifically to avoid cross-compiling OpenSSL for the NDK (see `docs/01-sqlite-migration.md`).

## Files

| File | What it is |
|------|------------|
| `better-sqlite3-multiple-ciphers-12.11.1-node-108-android-arm64.tar.gz` | The prebuilt artifact. A **flat** tarball containing a single `better_sqlite3.node` (an aarch64 ELF shared object) at the root — matching the layout `fetch-native-modules.mjs` extracts for the plain driver. |
| `build-mc-android-arm64.sh` | Reproducible cross-compile recipe (the script that produced the tarball). |
| `CMakeLists.mc.txt` | digidem's `CMakeLists.txt` for the nodejs-mobile better-sqlite3 build, used **as-is** — the **stock** better-sqlite3 SQLite defines, with **no** MultipleCiphers-specific SQL feature toggles added. Consumed by `build-mc-android-arm64.sh`. |

## Pinned checksum

```
sha256  40976b009278d0b1da04b8f6d34b0badf60469d7b26df68471ee08796f868ef4
```

`fetch-native-modules.mjs` re-verifies this sha256 **before** extracting the `.node` into the
embedded project — it refuses to install a mismatched binary, exactly like the plain-driver path.
If you rebuild the artifact, update the pin in `fetch-native-modules.mjs` (`MC_PREBUILD_SHA256`) to
match (the build script prints the value; see "How it was built").

## SQLite defines — what this binary does and does NOT enable

`CMakeLists.mc.txt` is digidem's unmodified better-sqlite3 CMakeLists. It carries the **stock**
better-sqlite3 SQLite compile-time defines (FTS3/4/5, RTREE, JSON1, math functions, `SQLITE_DQS=0`,
etc.) and **nothing MultipleCiphers-specific**. In particular, the vendored binary is **NOT** built
with either of these:

- `SQLITE_ENABLE_PERCENTILE`
- `SQLITE_USER_AUTHENTICATION`

(Earlier revisions of this README / the build script mistakenly claimed these two were added — they
were not, and neither is in `CMakeLists.mc.txt`.) Both are **crypto-irrelevant** SQL feature toggles
that LOAM does not use; their absence has no bearing on the SQLCipher/MultipleCiphers encryption the
driver provides. They are called out here only to keep the documentation honest against the binary.
Adding them would require a rebuild and a new sha256 pin — do not add them without doing both.

## Pinned build inputs

The build recipe pins **every** input to an exact npm version or GitHub commit SHA so it can't
silently drift when npm/GitHub move (all set at the top of `build-mc-android-arm64.sh`):

| Input | Pin | Notes |
|-------|-----|-------|
| `better-sqlite3-multiple-ciphers` (source) | `12.11.1` (npm) | Supplies the MC amalgamation + JS wrapper. |
| nodejs-mobile Node / ABI | `18.20.4` / ABI `108` | The target runtime. Not passed to cmake by the script — it's the default baked into the pinned `cmake-napi` commit (`download_node_headers`), so the script **asserts** the fork's default equals `NODE_VERSION` and aborts if a future `cmake-napi` bump retargets a different Node. |
| `cmake-napi` | `github:digidem/cmake-napi-nodejs-mobile#0e344601443a11c636c39d1e19a11d6e5f871a35` | digidem's fork that fetches nodejs-mobile headers/libnode. Pinned to a commit (was an unpinned branch). |
| `cmake-bare` | `1.8.0` (npm) | |
| `cmake-fetch` | `1.5.2` (npm) | |
| `bare-make` | `1.8.0` (npm) | Was `@latest`. |
| Android NDK | `27.x` (`27.1.12297006`) | 16KB page-size alignment + `android-24` platform pin. |

**To update a pin:** change the exact version / SHA at the top of `build-mc-android-arm64.sh`,
re-run it, and update `MC_PREBUILD_SHA256` (+ this file's checksum) to the value the script prints.
Current npm "latest" for the cmake tooling and the digidem fork's current `main` HEAD were resolved
when these pins were set; bump deliberately, not automatically.

## Reproducibility — what a rebuild reproduces (and what it doesn't)

Because the inputs are pinned, a rebuild reproduces the **source**, the **toolchain**, and the
resulting **symbol/ABI shape**. It does **not** guarantee a **byte-identical** `.node`: the linker
embeds a build-id (and paths/timestamps can leak in), so two builds from identical pinned sources can
differ in a handful of bytes and thus produce a different sha256. This is expected and is **not** a
sign of tampering.

Consequently:

- The committed tarball's **sha256 pin** (`MC_PREBUILD_SHA256`) is what authorises the vendored
  artifact — `fetch:native` installs *that exact file* and nothing else. It is a supply-chain
  integrity check on the committed binary, **not** a claim that a rebuild will hash-match.
- A rebuilder verifies an independently built `.node` by comparing its **ABI/symbol shape** to the
  vendored one, not its hash. `build-mc-android-arm64.sh`'s final step runs `readelf` on the fresh
  binary (ELF64 / AArch64 / DYN header + the `napi_register_module_v1` N-API entry symbol); compare
  that against the same `readelf` output for the committed tarball's `.node`.

## How it was built

Run `./build-mc-android-arm64.sh` (requires host Node 20+, Android NDK 27.x, cmake, and `readelf`
from binutils). It mirrors `digidem/better-sqlite3-nodejs-mobile`'s recipe — cross-compiling against
nodejs-mobile's Node 18 headers with the Android NDK — but swaps the plain SQLite amalgamation for
the SQLite3MultipleCiphers amalgamation that the `better-sqlite3-multiple-ciphers` npm package
vendors. Its final steps package the built `.node` into the exact tarball name above, `readelf`-verify
its ABI/symbol shape, and print its sha256 for comparison against the pin. See the cross-compile
recipe in `docs/01-sqlite-migration.md` for the full rationale.

## Why vendored (not a hosted pin)

The plain `better-sqlite3` driver is fetched at build time from a **published** upstream release
(`digidem/better-sqlite3-nodejs-mobile`). No equivalent `better-sqlite3-multiple-ciphers` release
exists for Android / ABI 108 yet, so LOAM vendors a **self-built** artifact here (committed to the
repo, with the reproducible recipe alongside for audit/rebuild).

**Future:** if digidem's (or another) prebuild release matrix adds a MultipleCiphers android-arm64
ABI-108 artifact upstream, switch `fetch-native-modules.mjs` to download + sha256-pin the hosted
tarball (as the plain driver already does) and retire this vendored copy.

## Runtime support: what's proven vs. the remaining release gate

Two separate things must hold, and only one is proven today:

1. **The native binary is a correct ABI-108 aarch64 module** — proven as **build evidence**: it's a
   valid ELF64 / AArch64 shared object at Node ABI 108 (verified via `readelf`, and byte-comparable
   in ELF characteristics to the known-good plain prebuild), so the APK ships the exact vendored
   binary with the right symbols and it will *load* on nodejs-mobile's Node 18. This is a statement
   about the compiled artifact, **not** about runtime behaviour.

2. **The JS wrapper + runtime path actually works on Node 18 — NOT yet proven; this is the release
   gate.** `better-sqlite3-multiple-ciphers@12.11.1`'s `package.json` declares
   `engines: { node: "20.x || 22.x || ..." }` — it does **not** officially list Node 18. The embedded
   runtime is nodejs-mobile **Node 18.20.4**. ABI-108 *symbol* compatibility (point 1) does **not**
   by itself prove the JS-wrapper ↔ runtime path is sound on an engine the wrapper doesn't claim to
   support.

   > **RELEASE GATE (not done):** on a **physical arm64 device**, under the **exact embedded Node
   > 18.20.4** runtime, exercise the full path end to end — load the `better-sqlite3-multiple-ciphers`
   > wrapper, open + key a DB (`PRAGMA key`), reopen with the **correct** key (succeeds) and the
   > **wrong** key (fails cleanly), and **rekey** (`PRAGMA rekey`). This is device-runtime
   > verification; it has not been performed. Until it passes, on-device encryption at rest is
   > "binary ships and loads," not "encryption is proven to round-trip on device."

The desktop/CI DAL test suite already exercises open/key/wrong-key/rekey against this driver, but on
host Node (24.x), which is a *different runtime* from the device's Node 18 — so it does not close the
gate above.
