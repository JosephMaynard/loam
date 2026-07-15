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
| `CMakeLists.mc.txt` | digidem's `CMakeLists.txt` for the nodejs-mobile better-sqlite3 build, plus MultipleCiphers' two extra SQLite defines. Consumed by `build-mc-android-arm64.sh`. |

## Pinned checksum

```
sha256  40976b009278d0b1da04b8f6d34b0badf60469d7b26df68471ee08796f868ef4
```

`fetch-native-modules.mjs` re-verifies this sha256 **before** extracting the `.node` into the
embedded project — it refuses to install a mismatched binary, exactly like the plain-driver path.
If you rebuild the artifact, update the pin in `fetch-native-modules.mjs` (`MC_PREBUILD_SHA256`) to
match.

## How it was built

Run `./build-mc-android-arm64.sh` (requires host Node 20+, Android NDK 27.x, cmake). It mirrors
`digidem/better-sqlite3-nodejs-mobile`'s recipe — cross-compiling against nodejs-mobile's Node 18
headers with the Android NDK — but swaps the plain SQLite amalgamation for the
SQLite3MultipleCiphers amalgamation that the `better-sqlite3-multiple-ciphers` npm package vendors.
See the cross-compile recipe in `docs/01-sqlite-migration.md` for the full rationale.

## Why vendored (not a hosted pin)

The plain `better-sqlite3` driver is fetched at build time from a **published** upstream release
(`digidem/better-sqlite3-nodejs-mobile`). No equivalent `better-sqlite3-multiple-ciphers` release
exists for Android / ABI 108 yet, so LOAM vendors a **self-built** artifact here (committed to the
repo, with the reproducible recipe alongside for audit/rebuild).

**Future:** if digidem's (or another) prebuild release matrix adds a MultipleCiphers android-arm64
ABI-108 artifact upstream, switch `fetch-native-modules.mjs` to download + sha256-pin the hosted
tarball (as the plain driver already does) and retire this vendored copy.

> **Note:** this artifact is verified to be a correct aarch64 ELF at Node ABI 108 (built from the
> recipe above and byte-compared against the known-good plain prebuild's ELF characteristics), but
> its `PRAGMA key`/rekey behaviour under nodejs-mobile's Node 18.20.4 has **not** yet been exercised
> on physical hardware — that on-device runtime verification is the remaining device seam
> (`docs/01`).
