# Vendored prebuild: `better-sqlite3` (android-arm64, ABI 108)

The plain (unencrypted) SQLite driver for the LOAM Android host's embedded Node 18.20.4, from
[digidem/better-sqlite3-nodejs-mobile](https://github.com/digidem/better-sqlite3-nodejs-mobile)
(the prebuild CoMapeo ships).

| | |
|---|---|
| Package / version | `better-sqlite3@12.10.0` (the JS wrapper is installed from npm at the same version) |
| Target | `android-arm64`, Node ABI 108 |
| Upstream asset | `https://github.com/digidem/better-sqlite3-nodejs-mobile/releases/download/12.10.0/better-sqlite3-12.10.0-node-108-android-arm64.tar.gz` |
| Original upstream tarball sha256 | `00d84fcd41b80bbc910c0531320763f8f1a5c72a5638404ad9484f8805d70e9a` (pinned 2026-07-02) |
| `better_sqlite3.node` sha256 | `a338a11b261c3db217cddf3b7597ce265ae02780bf55c55cbb677c940dc7a9a7` (2,197,656 bytes, aarch64 ELF, BuildID `75598132ae793e6865d913587034488934f513cf`) |
| Vendored tarball sha256 | `c454974e7194fb078830e9c7c494477cfd41cd963c125225d995f128749b7241` |

## Why it is vendored

`fetch-native-modules.mjs` used to download the upstream asset and verify it against the pin above.
On 2026-08-17 a digidem maintainer re-ran the upstream "Generate prebuilds" workflow (run
`32065561570`), which re-uploaded every 12.10.0 asset. The build isn't reproducible, so the new tarball
(`01a02b0c…b952`) and its `.node` (2,228,320 bytes) differ from what LOAM pinned, and the verified
download started failing.

Rather than trust a rebuilt binary nobody has run on a device, this directory keeps the **original**
binary — the one extracted from the pinned tarball and shipped in earlier LOAM APKs — so the build no
longer depends on a mutable upstream release. The tarball is a flat, deterministic repackaging (one
`better_sqlite3.node`, mtime 0, uid/gid 0, gzip mtime 0), the same layout as the multiple-ciphers
prebuild beside it.

To move to a newer upstream release: download it, check its GitHub asset digest, test it on a device,
then replace this tarball and update `PREBUILD_SHA256` in `fetch-native-modules.mjs` and this README.
