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

`npm pack` produces a ~1 MB tarball (~4.5 MB unpacked; the figure moves with the client build). There are **no regular runtime
dependencies**: the default database driver is the built-in `node:sqlite` (Node 22.14 or newer; `loam` refuses to start on an older Node with a plain message), so a plain
`npm install -g loamnet` needs **no node-gyp / no native build**.

## What the command shows

In a terminal, `loam` opens a full-screen terminal UI (`@loam/tui`): the join QR stays on screen, with
Activity, People, Settings and Debug screens a key away, a one-time "open as admin" code (`o`), live
settings, Emergency Reset, and a kiosk mode (`loam --kiosk`, a password-locked screen that shows only
the QR). Without a terminal on both ends (a service, a pipe, `--plain`) it prints the join address, the
QR and a one-time admin link instead. The web app, messages and moderation stay in the browser.

## How it's built

`scripts/build-cli.mjs` (a fork of the Android bundler `apps/app/scripts/bundle-server.mjs`) runs
esbuild over `cli/cli-entry.ts`:

- **`format: esm`, `target: node22`.** A banner recreates `require`/`__dirname`/`__filename` from
  `import.meta.url` so the CommonJS deps that call `require(...)` (e.g. `@fastify/websocket` and Fastify itself) work in the
  ESM output.
- **`cli/cli-entry.ts`** is a thin library entry that re-exports `startEmbeddedServer` + `firstLanIPv4`
  from `apps/server/src/embedded.ts`, `encodeQR` + `renderQRToTerminal` from `@loam/qr`, and the terminal
  UI (`createTui`, its log book, terminal and settings helpers) from `@loam/tui`. Bundling a library (not
  a boot-on-import `main`) lets `bin/loam.js` own env setup, the passphrase prompt and the port check
  before the server starts, then hand the running node to the terminal UI (or print the plain output).
- **The terminal UI** (`packages/tui`) drives the node only through the in-process host API
  (`LoamApp.host`, `HostApi` in `@loam/schema`): never over the network. `bin/loam.js` passes a per-boot
  host token, so admin comes from the host's own screen (`hostDevice`), as on Android.
- The **`@loam/*` workspace packages are inlined** from their compiled `dist/` (run `pnpm -r build`
  first — `prepublishOnly` does). `build-cli.mjs` fails early if any of them (`schema`, `display-name`,
  `avatar`, `qr`, `crypto`, `tui`) hasn't been built.
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
| `--port <n>` (or `--port=<n>`) | `PORT` | `3000` (or `$PORT`) |
| `--data-dir <dir>` (or `--data-dir=<dir>`) | `LOAM_DATA_DIR` | `$XDG_DATA_HOME/loam` or `~/.loam` — **user-writable, never inside the global package** |
| `--encrypt` | `LOAM_DB_KEY` | off. Bare `--encrypt` takes `$LOAM_DB_KEY` if set, else prompts without echo (asked twice for a new database, and an empty answer = `ephemeral`; for an existing `loam.db` an empty answer is refused and it asks again, since a fresh ephemeral key can't open it). Pasting both lines at once works. With no terminal and no env it uses `ephemeral`. `--encrypt ephemeral` skips the prompt. `--encrypt <value>` still works but warns — an argv passphrase shows in `ps` and shell history. |

Arguments are parsed by `bin/args.js`: a value goes after a space or an equals sign, and an option `loam`
doesn't know (or a stray argument, or a missing value) stops it with a one-line message naming the known
options, so a typo can't start a node on defaults the operator never meant. In `--plain` mode the server's
log reaches the console only as `[warn] message` lines for warnings and errors (every line with
`--verbose`), never as raw JSON with the hostname and pid; the QR is painted black on white on a colour
terminal (bare blocks invert on a dark theme) and drawn bare under `NO_COLOR` or when output isn't a terminal.

A `LOAM_DB_KEY` already in the environment encrypts the node even without the flag (the server reads it
directly). It also sets `LOAM_CLIENT_DIST` to the packaged `client/` dir and `LOAM_JOIN_HOST` to the
first LAN IPv4, prints the LAN URL + a terminal QR (via the bundled `@loam/qr`), then `await`s the
server. When encryption is requested (`--encrypt` or `LOAM_DB_KEY`), the launcher first **probes the
SQLCipher driver** (loads it and opens an in-memory DB, so the native addon really loads) before
prompting or booting; if it won't load, it exits with a hint. The driver resolves from the package's own
`dist/` (it's loamnet's optional dependency), so the hint prints that path and says to reinstall loamnet
and check the install output for the native build error. A separately installed global copy of the driver
is never found. (Letting the server try
instead was unsafe: its keyed-open recovery path could leave a plaintext `loam.db` in a fresh data dir.)

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
#   persists to /tmp/loam-data/loam.db (plain SQLite). `LOAM_DB_KEY=<pass> loam --encrypt`
#   (or bare `--encrypt` and answer the prompt) writes an encrypted DB (no "SQLite format 3"
#   header) using the optional native driver.
```
