# 14 — Distribution (the `loamnet` npm package)

> **Status: implemented.** `npm install -g loamnet` gives non-developers a one-command LOAM node
> (`loam`) without cloning the repo or running a toolchain. The git-clone path (`pnpm dev`) is
> unchanged and remains the way to hack on LOAM.

## What ships

The published package is **`loamnet`** (the name `loam` was already taken on npm; the *command* is
still `loam`). It is the single-origin production build — the Fastify server serving the built PWA —
bundled into one self-contained file plus the web client:

```
loamnet/
├─ bin/loam.js          # the `loam` CLI: sets env, prints the join QR, boots the node
├─ dist/loam-server.js  # esbuild ESM bundle of the server (+ @loam/* inlined, QR helper re-exported)
└─ client/              # the built PWA (apps/client/dist), served offline over the LAN
```

`npm pack` produces a ~0.6 MB tarball (~2.9 MB unpacked). There are **no regular runtime
dependencies**: the default database driver is the built-in `node:sqlite` (Node ≥22), so a plain
`npm install -g loamnet` needs **no node-gyp / no native build**.

## How it's built

`scripts/build-cli.mjs` (a fork of the Android bundler `apps/app/scripts/bundle-server.mjs`) runs
esbuild over `cli/cli-entry.ts`:

- **`format: esm`, `target: node22`.** A banner recreates `require`/`__dirname`/`__filename` from
  `import.meta.url` so the CommonJS deps that call `require(...)` (e.g. `@fastify/static`) work in the
  ESM output.
- **`cli/cli-entry.ts`** is a thin library entry that re-exports `startEmbeddedServer` + `firstLanIPv4`
  from `apps/server/src/embedded.ts` and `encodeQR` + `renderQRToTerminal` from `@loam/qr`. Bundling a
  library (not a boot-on-import `main`) lets `bin/loam.js` own env setup and the QR print before the
  server starts.
- The **`@loam/*` workspace packages are inlined** from their compiled `dist/` (run `pnpm -r build`
  first — `prepublishOnly` does).
- The **three SQLite drivers stay external**: `node:sqlite` (the builtin default), `better-sqlite3`,
  and `better-sqlite3-multiple-ciphers`. Only the ciphers driver is a package dependency, and it is an
  **`optionalDependency`** — so encryption is opt-in and a native build failure never aborts
  `npm i -g loamnet`.

Build it locally with `pnpm build:cli` (assumes `pnpm -r build` and `pnpm --filter client build` have
run). Output lands in `cli/dist/` and `cli/client/`, both gitignored.

## The `loam` command

`bin/loam.js` is env-driven — it only sets what the already-env-driven `startEmbeddedServer` reads:

| Flag | Env it sets | Default |
|------|-------------|---------|
| `--port <n>` | `PORT` | `3000` (or `$PORT`) |
| `--data-dir <dir>` | `LOAM_DATA_DIR` | `$XDG_DATA_HOME/loam` or `~/.loam` — **user-writable, never inside the global package** |
| `--encrypt [key]` | `LOAM_DB_KEY` | off; a value → passphrase, bare → `ephemeral` (RAM-only key) |

It also sets `LOAM_CLIENT_DIST` to the packaged `client/` dir and `LOAM_JOIN_HOST` to the first LAN
IPv4, prints the LAN URL + a terminal QR (via the bundled `@loam/qr`), then `await`s the server. If
`--encrypt` is used but the native SQLCipher driver isn't installed, it prints a targeted hint instead
of a stack trace.

## Publishing

Publishing is a **manual step** (needs the owner's npm account + 2FA — not automated here):

```bash
cd cli
npm publish        # prepublishOnly runs `pnpm -r build && node scripts/build-cli.mjs` from the repo root
```

Bump `cli/package.json` `version` per release. The package is `AGPL-3.0-only`, matching the repo.

## Verifying a build

```bash
pnpm -r build && pnpm build:cli
cd cli && npm pack                      # inspect the tarball
npm install -g --prefix /tmp/x ./loamnet-*.tgz
/tmp/x/bin/loam --port 3068 --data-dir /tmp/loam-data
# → boots with no node-gyp, prints a scannable QR, serves the PWA on the LAN URL,
#   persists to /tmp/loam-data/loam.db (plain SQLite). `--encrypt <pass>` writes an
#   encrypted DB (no "SQLite format 3" header) using the optional native driver.
```
