# Vendored npm packages: the SQLite drivers' JS side

The JavaScript half of the two SQLite drivers that the Android host's embedded server loads. The native
binaries sit beside this directory (`../better-sqlite3/`, `../multiple-ciphers/`); these are the
packages that load them.

`fetch-native-modules.mjs` checks each tarball's sha256 against the pin in the script, unpacks it into
`nodejs-assets/nodejs-project/node_modules/<name>/` and refuses to continue on a mismatch. It doesn't
contact the npm registry and runs no install scripts. These packages run inside the process that holds
the database key, so the build takes these exact bytes and nothing the registry serves later.

| Tarball | sha256 | npm integrity (as published) |
|---|---|---|
| `better-sqlite3-12.10.0.tgz` | `842b5442b62913e6b9378394ade4e80d5d2e4bbb537e0c20b11bc4cf58313d3f` | `sha512-CyzaZRQKyHkB2ZInfTTl2nvT33EbDpjkLEbE8/Zck3Ll6O0qqvuGdrJ45HgtH+HykRg88ITY3AdreBGN70aBSQ==` |
| `better-sqlite3-multiple-ciphers-12.11.1.tgz` | `01388c78f46ce63c6aec021f67b364cc67bd637edba64f7add0c0230ce5f777a` | `sha512-pG72+3VkUipnmYx4LwQqoOXNG2CJ1HlmDrlvqgr7xQHgsE+cz5rAZEiaJHnUKTHaGfGifggA/C0Sv9qZlUrfow==` |
| `bindings-1.5.0.tgz` | `d77781178c5bd89a91b1f6c5556acd511b1b5927eb13e2ad8189cac29eeb0907` | `sha512-p2q/t/mhvuOj/UeLlV6566GD/guowlr0hHxClI0W9m7MWYkL1F0hLo+0Aexs9HSPCtR1SXQ0TD3MMKrXZajbiQ==` |
| `file-uri-to-path-1.0.0.tgz` | `5440cdf67e75ab96f36a6be63c1d4c3d54255b1d0970273710fecfebfab06fb3` | `sha512-0Zt+s3L7Vf1biwWZ29aARiVYLx7iMGnEUl9x33fbB/j3jR81u/O2LbqK+Bm1CDSNDKVtJ/YjwY7TUd5SkeLQLw==` |

Each file is the unmodified output of `npm pack <name>@<version>` (fetched 2026-10-09), which checks the
download against the registry's published integrity. The integrity values for the last three also match
the root `pnpm-lock.yaml`.

Both wrappers also depend on `prebuild-install`, which only runs at install time to fetch a desktop
binary. LOAM supplies its own binary, so it isn't vendored. The wrappers' `deps/` and `src/` (the
SQLite C sources) are deleted after unpacking.

## Changing a version

A wrapper's version must match its native binary's (see the README beside each binary). To move one:

1. `npm pack <name>@<version>` in this directory and delete the old tarball.
2. Put the new file's sha256 (`shasum -a 256 <file>`) in `NPM_TARBALLS` in
   `apps/app/scripts/fetch-native-modules.mjs` and in the table above.
3. Run `pnpm --filter app fetch:native`, then build and test the APK on a device.

The root `.gitignore` ignores `*.tgz` but makes an exception for this directory.
