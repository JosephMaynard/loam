# 24 — Electron desktop host (macOS / Windows / Linux) — feasibility briefing

**Status: investigation / briefing — not sequenced.** Assesses a double-click desktop app that runs a LOAM
host, for the "noob doesn't want a terminal" audience the `loamnet` CLI (`docs/14`) doesn't serve. Read
`CLAUDE.md` + `docs/04` (Android host — the same "boot the embedded server + serve the PWA in a webview"
pattern) first.

## Verdict

**Feasible, low-risk, medium effort — and unusually cheap because the server was already built for it.**
`apps/server` is a plain-Node, env-driven library entry (`startEmbeddedServer()` in
`apps/server/src/embedded.ts`), the client is served single-origin from `apps/client/dist`, and the
`cli/` workspace already proves "boot the bundled server + serve the PWA on desktop Node." **Electron is
that CLI wrapped in a window.** The real work is packaging, native-module rebuild, and the honest
unsigned-distribution UX — **not LOAM code** (v1 needs zero server changes).

## Architecture — reuse vs new

Electron's **main process** becomes the launcher:
1. Pick a free port; set the existing env contract — `LOAM_DATA_DIR` → `app.getPath('userData')`,
   `LOAM_CLIENT_DIST` → packaged `apps/client/dist`, `PORT`, `HOST=0.0.0.0` (LAN joiners),
   `LOAM_DB_DRIVER`, optional `LOAM_DB_KEY`/`LOAM_DB_ENCRYPTION_MODE`.
2. `await startEmbeddedServer()` (Fastify listens).
3. `BrowserWindow.loadURL('http://127.0.0.1:PORT')` — same-origin, so cookies + WebSocket "just work" (the
   identical constraint the Android WebView already satisfies).
4. Quit → `app.close()` the server; single-instance lock.

| Reused as-is | New (Electron-only) |
|---|---|
| `apps/server` (`startEmbeddedServer`, the whole `LOAM_*` env contract) — **unchanged** | `apps/desktop` main process: port pick, env wiring, boot, `BrowserWindow`, lifecycle |
| `apps/client/dist` (served + SPA fallback, as the CLI does) | `electron-builder` config + per-OS targets |
| `net.ts` `resolveLanIPv4()` (VPN-filtered LAN IP for the join QR) | `@electron/rebuild` step for the native SQLite driver |
| `@loam/qr` + the client's existing `InviteControl` (reuse for the join UI — no native chrome) | optional: auto-update, OS-keychain key storage |
| `cli/cli-entry.ts` + `cli/scripts/build-cli.mjs` (near-drop-in launcher + esbuild recipe) | |

Lives as a new `apps/desktop` workspace. Electron main runs real Node, so bundling isn't strictly required
(unlike nodejs-mobile) — it can import `@loam/server`'s `dist/` directly or reuse the CLI bundle.

## Joining — a laptop is not a phone

Android's model is "the phone **is** the access point" (`LocalOnlyHotspot`). **Desktop has no clean
programmatic hotspot API.** Two modes:
- **Mode A — laptop as a peer on a shared LAN (ship this).** Café/office/event WiFi; server binds
  `0.0.0.0:PORT`; joiners open `http://<laptop-LAN-IP>:PORT` (already computed by `resolveLanIPv4()` for the
  QR). Zero new native code.
- **Mode B — laptop shares its own hotspot.** macOS Internet Sharing / Windows Mobile Hotspot exist but are
  **user-driven OS features with no clean cross-platform API** — do **not** try to automate in v1; just
  detect + display the address with a "turn on your OS hotspot, then share this URL" hint.

**Top runtime gotcha:** the **host firewall** (macOS Application Firewall / Windows Defender) prompts or
silently blocks incoming LAN connections on first listen — the #1 desktop joining failure; document it, and
signing later makes the prompt show the real app name. AP/client isolation on guest WiFi is the same
unfixable class `docs/04` notes for phones.

## SQLite under Electron's Node

Electron ships its own Node/V8 with a distinct native ABI, so:
- **Default to `better-sqlite3` + `@electron/rebuild`** (the safe path; already a supported driver via
  `LOAM_DB_DRIVER=better-sqlite3`, mirrors the Android host). It publishes Electron-ABI prebuilds, so the
  rebuild is essentially free — and it **sidesteps** the open question of whether a given Electron build
  compiles in `node:sqlite` (needs Node ≥22 *and* the experimental builtin exposed — treat as a spike, not
  an assumption).
- **Encryption is *easier* than Android:** `better-sqlite3-multiple-ciphers` (already a server dep) is just
  a normal native module rebuilt for the Electron ABI — no hand-vendored cross-compiled prebuild (contrast
  `apps/app/native-prebuilds/`). Key management ports from the CLI's `--encrypt` model; a persistent key
  could later use the OS keychain (`safeStorage`).

## Packaging & signing (the honest unsigned UX)

**Use `electron-builder`** (emits every artifact from one config + handles rebuild/sign/notarize/update):
macOS `dmg`, Windows `nsis`, Linux `AppImage`/`deb`/`rpm`/`flatpak`. App size is **~80–150 MB/platform**
(inherent to Electron; comparable to the ~91 MB APK). (Tauri would be far smaller but throws away the
"reuse `apps/server` in a bundled Node" advantage — not worth it here.)

Unsigned distribution UX, per OS — **be blunt with users:**

| OS | Unsigned experience | Cheapest path to clean |
|----|--------------------|------------------------|
| **Linux** ✅ | AppImage/deb/rpm run unsigned with no gatekeeper nag — the smoothest story | Flathub (Flatpak) for trusted install + auto-update; or GPG-sign a repo |
| **Windows** ⚠️ | SmartScreen "unknown publisher" → *More info → Run anyway* (clickable, scary; some managed PCs block) | OV cert (~$200–400/yr, reputation still ramps) · **Azure Trusted Signing ~$10/mo** (needs org identity) · EV (immediate trust, pricey) |
| **macOS** ❌ | The worst: quarantine → "developer cannot be verified", often **"is damaged"** on Apple Silicon; **macOS 15 removed the right-click→Open bypass** → users must use System Settings → "Open Anyway" or `xattr -dr com.apple.quarantine` (a real adoption tax) | **Apple Developer $99/yr → codesign + notarize** (electron-builder does it) — removes *all* friction |

**If shipping unsigned:** Linux is fine, Windows is tolerable, macOS is genuinely user-hostile. **Prioritize
the Apple $99/yr + notarization as the first paid step** — it fixes the single worst experience. Windows/Linux
signing can wait.

## Effort & risks

**Medium overall.** Boot+window+lifecycle = **S** (day or two). `better-sqlite3` via rebuild = **S–M**.
Cross-platform packaging + CI matrix = **M**. Signing = **M but mostly money/process, not code**. Auto-update
+ keychain = **S–M, defer**.

Risks: (1) `node:sqlite`-in-Electron unverified → default to `better-sqlite3`; (2) native ABI mismatch →
`@electron/rebuild` mandatory in CI, re-run on every Electron bump; (3) host firewall blocking joiners; (4)
surface async boot failures to the UI (reuse the `embedded-main.ts` pattern — simpler here, no RN bridge);
(5) ~100 MB size; (6) no programmatic hotspot → set Mode-A expectations.

## Recommendation & minimal v1

**Worth it — yes.** Broadens "who can run a node" beyond the CLI audience at low code cost, since the server
was already engineered for embedding. The one caveat is macOS unsigned UX pushing toward the $99/yr sooner
than ideal.

**MVP (ship first):** `apps/desktop` Electron app → env + `startEmbeddedServer()` → `BrowserWindow` on
`127.0.0.1:PORT`; **Mode A joining only** (reuse `resolveLanIPv4()` + `@loam/qr` + the client's invite UI);
**`better-sqlite3` unencrypted** via `@electron/rebuild`; package **dmg + nsis + AppImage** with
electron-builder; **ship unsigned** with per-OS "how to open" docs, **budgeting Apple $99 + notarization as
the first paid step**. Defer: auto-update, keychain key storage, programmatic hotspot, Windows/Linux signing,
deb/rpm/flatpak.

No server changes required for v1.
