<p align="center">
  <img src="apps/client/public/favicon.svg" alt="LOAM" width="96" height="96" />
</p>

<h1 align="center">LOAM</h1>

<p align="center">
  <strong>Off-grid, local-first messaging.</strong><br />
  Run it on a laptop, a Raspberry&nbsp;Pi, or your phone. Everyone nearby scans a QR code and starts talking — no internet, no accounts, no cloud.
</p>

<p align="center">
  <a href="https://loamnet.com">loamnet.com</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="docs/roadmap.md">Docs</a>
</p>

<p align="center">
  <a href="https://github.com/JosephMaynard/loam/actions/workflows/ci.yml"><img src="https://github.com/JosephMaynard/loam/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0" />
  <img src="https://img.shields.io/badge/node-24.13.1-brightgreen" alt="Node 24.13.1" />
  <img src="https://img.shields.io/badge/PWA-installable-5a7d5a" alt="Installable PWA" />
</p>

---

## What LOAM is

LOAM is a messaging system that works **when the internet doesn't**. One person becomes the
*host* — they run LOAM on any device and turn it into a small WiFi hotspot. Everyone nearby scans a
QR code, the messaging app opens in their browser, and the group can post to channels, reply in
threads, send direct messages, react, and — if the host enables it — chat with a local AI, all over
the local network. Nothing leaves the immediate area and nothing touches a server you don't control.

It's built for the moments when normal networks are **unavailable, unreliable, or unsafe**:
emergencies and outages, large events and remote sites, and communities that simply want to talk
without an account, a data plan, or anyone in the middle.

LOAM's priorities, in order:

- **Simplicity** — no accounts, no installs, no setup. Scan and go.
- **Privacy** — identities are anonymous and ephemeral by default.
- **Resilience** — designed for very low bandwidth and intermittent connectivity.

It is **transport-agnostic**: WiFi today, with low-bandwidth radio relay (LoRa) a stated design
goal, so a message can eventually hop device-to-device across a wider area with the same experience.

## Features

- 📡 **Off-grid by design** — a local hotspot is the whole network; no internet required at any point.
- 📱 **Nothing to install** — joiners open a link (or scan a QR); the host can run it from a laptop, Pi, or [an Android phone](docs/04-android-host-app.md).
- 🕶️ **Anonymous & ephemeral** — every joiner gets a deterministic, memorable display name and avatar derived from a random id. No email, no phone number.
- 💬 **Real messaging** — public and private (invite-only) channels, threaded replies, direct messages, reactions, and message search.
- 🤖 **Optional local AI** — point it at a local [Ollama](https://ollama.com) model and a bot appears as a DM contact; replies stream in. Entirely local, entirely optional.
- 🔌 **Works offline** — the client is an installable PWA that keeps working against its local cache when the connection drops.
- 🌍 **Minimal by design** — an intentionally sparse interface that stays out of the way and renders text in any language, including right-to-left scripts.
- 🌗 **Light & dark** — the client follows your system theme automatically.
- 🔒 **Optional encryption at rest + a kill switch** — the host can encrypt the on-disk database and wipe everything in one action (see [Security](#security)).

## Quick start

You'll need [Node 24.13.1](.node-version) and [pnpm 10](https://pnpm.io) (`corepack enable` will
set pnpm up for you).

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the server and client together and prints a **join QR code plus a LAN URL** to your
terminal. On any device connected to the same network, scan the QR or open the URL — that's the whole
join flow. (Under the hood the client runs on `:3000` and proxies the API to the server on `:3001`.)

### Run it as one process (production)

In production LOAM is a single origin: the client is built to static files and served by the server
with an SPA fallback.

```bash
pnpm build
pnpm --filter @loam/server start   # serves the built client + API, defaults to PORT 3000
```

### Host it from an Android phone

`apps/app` is an Expo/React-Native host that runs the LOAM server **embedded on the phone**, brings
up a local-only WiFi hotspot, and shows the join QR — turning a single phone into a complete,
internet-free LOAM node.

**Prerequisites:** [Android Studio](https://developer.android.com/studio) (for its bundled JDK, the
Android SDK + platform-tools, and NDK r27+) with `adb` on your `PATH`. On macOS the build script
auto-detects the Studio JDK and SDK; otherwise set `JAVA_HOME` and `ANDROID_HOME` yourself.

**Build the APK** — one command from the repo root:

```bash
pnpm install
pnpm --filter app apk        # → apps/app/loam-host.apk (takes a few minutes)
```

That runs the whole pipeline (workspace build → native prebuild → bundle the embedded server → Expo
prebuild → `gradlew assembleRelease`) and writes the finished APK to `apps/app/loam-host.apk`.

**Copy it to a phone with `adb`:**

1. On the phone, enable **Developer options** (Settings → About phone → tap *Build number* 7×), then
   turn on **USB debugging**.
2. Connect the phone with a **data** USB cable (set it to *File transfer*) and accept the *Allow USB
   debugging?* prompt. Confirm the phone is listed:
   ```bash
   adb devices                # your phone's serial should appear
   ```
3. Install (and replace any older copy):
   ```bash
   adb install -r apps/app/loam-host.apk
   ```
   If both a phone and an emulator are connected, target the phone: `adb -s <serial> install -r apps/app/loam-host.apk`.
4. Launch **LOAM** on the phone. First cold start takes ~1 minute; tap **Share · Host** to bring up
   the hotspot and join QRs.

See **[docs/04-android-host-app.md](docs/04-android-host-app.md)** for the manual step-by-step, the
two-step join flow, and troubleshooting.

## How it works

```text
   Host device (laptop / Pi / phone)              Nearby people
 ┌───────────────────────────────────┐
 │  LOAM server (Fastify)            │            📱  scan QR ─┐
 │   • REST + WebSocket              │            📱  scan QR ─┤
 │   • local database (SQLite)       │◀── WiFi ───            ├─▶ open the PWA
 │   • serves the PWA client         │            📱  scan QR ─┘     in a browser
 │   • optional local LLM (Ollama)   │
 └───────────────────────────────────┘
        no internet · no cloud · no accounts
```

The host runs a small [Fastify](https://fastify.dev) server that stores everything locally and
serves a [Preact](https://preactjs.com) PWA. Joiners never install anything — they load the app in a
browser and talk to the host over the local network via REST and a WebSocket. The client and server
share a single [Zod](https://zod.dev) schema package as their contract and both validate every
message against it, so the wire format can't drift.

## Project layout

A [pnpm workspace](pnpm-workspace.yaml) (`apps/*`, `packages/*`).

| Path | What it is |
|------|------------|
| [`apps/server`](apps/server) | Fastify backend: REST + WebSocket, SQLite persistence (optionally encrypted), optional Ollama LLM. |
| [`apps/client`](apps/client) | The Preact + Vite PWA everyone connects to. |
| [`apps/app`](apps/app) | Expo/React-Native Android host — runs the server on a phone and brings up a hotspot. |
| [`apps/site`](apps/site) | The [loamnet.com](https://loamnet.com) landing site (static Vite build). |
| [`packages/schema`](packages/schema) | The client↔server contract: shared Zod schemas + inferred types. |
| [`packages/display-name`](packages/display-name) | Deterministic anonymous display names from an id. |
| [`packages/avatar`](packages/avatar) | Deterministic SVG avatars from an id. |
| [`packages/qr`](packages/qr) | Dependency-free QR encoder + renderers used by the join flow. |

## Configuration

LOAM runs with **no config file at all**. Optional identity and LLM features are enabled by creating
`.loam/config.json` (or pointing `LOAM_CONFIG_FILE` at another JSON path). See
[`config.example.json`](config.example.json) for the full set. A minimal example, assuming
[Ollama](https://ollama.com) is running locally:

```json
{
  "identity": {
    "allowUserDisplayNameEdit": true,
    "allowUserAvatarEdit": true,
    "allowUserAvatarUpload": true
  },
  "llm": {
    "ollama": {
      "enabled": true,
      "baseUrl": "http://localhost:11434",
      "model": "gemma4",
      "botId": "llm.ollama.gemma4",
      "botDisplayName": "Gemma"
    }
  }
}
```

When the LLM is enabled the bot appears as a DM contact and its replies stream into the conversation.
With `allowUserAvatarUpload` on, users can pick an image, crop it **locally in the browser**, and
upload only the final 256×256 avatar — the original file never leaves the device. If the config is
absent, none of these features are active.

## Security

LOAM can **encrypt its on-disk database** so that a lost or seized host device doesn't readily give
up stored messages. It's **off by default** and controlled by the `LOAM_DB_KEY` environment variable:

- **unset** — no encryption; the database is a plain SQLite file.
- **a passphrase** — encrypted at rest with SQLCipher (AES-256); the same passphrase is required on every start.
- **`ephemeral`** — a random key is generated in memory and **never written to disk**. Data is readable only while the process runs; a reboot loses the key forever, and the [kill switch](docs/02-kill-switch.md) rotates to a fresh key so anything still physically on flash becomes unreadable.

```bash
LOAM_DB_KEY=ephemeral pnpm --filter @loam/server start
```

**Honest limitations.** This raises the bar; it is not a guarantee of safety. The host processes
messages in plaintext while running, so a compromised host, a device seized while powered on with the
key in memory, or coercion of a known passphrase can still expose data. Anyone whose safety depends
on this should seek a professional security review and not treat LOAM as sufficient on its own. See
[`SECURITY.md`](SECURITY.md) and the [docs](#documentation) for the full threat model.

> **A note on intent.** These protections exist to protect *ordinary people* — activists,
> journalists, people organising where that is dangerous, communities cut off from the internet. They
> are deliberately **not** marketed as a way to hide wrongdoing, and LOAM's other design choices (a
> trusted host who can read and wipe everything, admin moderation) reflect that.

## Documentation

Design notes, threat models, and initiative briefings live in [`docs/`](docs/):

- [Roadmap & how the initiatives interlock](docs/roadmap.md)
- [SQLite migration](docs/01-sqlite-migration.md) · [Kill switch](docs/02-kill-switch.md) · [Admin UI](docs/03-admin-ui.md)
- [Android host app](docs/04-android-host-app.md) · [Authentication](docs/05-authentication.md) · [LLM](docs/06-llm.md)
- [More features menu](docs/07-more-features.md) · [Transport security](docs/08-transport-security.md) · [Security profiles](docs/09-security-profiles.md)
- [Maps & location sharing](docs/10-maps-location-sharing.md)
- [`CLAUDE.md`](CLAUDE.md) — architecture baseline for contributors (and AI agents).

## Contributing

```bash
pnpm install    # install workspace deps
pnpm dev        # run server + client, print the join QR
pnpm build      # build every package, then server and client (also type-checks via tsc)
pnpm test       # run the workspace test suite
```

CI runs `pnpm build` then `pnpm test` on every push and PR to `master`. There's no separate lint or
typecheck script — type-checking happens as part of `pnpm build`. If you're new to the codebase,
[`CLAUDE.md`](CLAUDE.md) is the fastest way in, and a server or client test harness is a
high-value first contribution.

## License

LOAM is licensed under the **[GNU Affero General Public License v3.0](LICENSE)**. Copyright ©
Magic Zebra Ltd. The AGPL's network-use clause means that if you run a modified LOAM as a service,
you must offer your users the corresponding source.
