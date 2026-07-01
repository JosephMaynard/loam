# Open decisions

Consequential choices that shape the initiatives. Each has a recommendation; the starred ones (★) are
worth confirming with the project owner before Fable commits, because they're expensive to reverse.
Update the "Decision" column as they're settled.

| # | Question | Options | Recommendation | Decision |
|---|----------|---------|----------------|----------|
| ★1 | **Encryption at rest?** Drives the SQLite driver and strengthens the kill switch. | none (`node:sqlite`) / SQLCipher (`better-sqlite3`) / `libsql` | — | **✅ YES — encrypt at rest.** Driver must be SQLCipher-capable; kill switch discards the key. Spike which encrypted driver runs under nodejs-mobile (see 01/04). |
| ★2 | **Android hosting model.** | embedded Node (nodejs-mobile, needs Expo prebuild) / thin host UI + external server | — | **✅ Phone runs the server** via nodejs-mobile; leaving pure-managed Expo (prebuild) is OK. |
| ★3 | **Admin bootstrap.** No real user can be admin today. | setup code / first-user / passphrase / host-device | — | **✅ Per-deployment, pluggable.** RN app: the host phone is admin (device owner). Pi: first user becomes admin. Keep other strategies (setup code / passphrase) available via config. |
| 4 | **Co-locate the RN app** as `apps/mobile`? | monorepo / separate repo | Monorepo, to share `@loam/qr` + `@loam/schema`; gate its install. | _TBD_ |
| 5 | **Kill-switch UX.** | instant / confirm / duress code; remote-wipe clients? | Config `requireConfirmation` (default on for team use) + fast path (hold/panic token) for protest; **do** remote-wipe connected clients. | _TBD_ |
| 6 | **"Two hotspot QR codes"** — what are they? | WiFi-join + LOAM-URL / Android-format + plain SSID / other | — | **✅ WiFi-join QR + LOAM-URL QR** (two-step: connect, then open), open to a manual SSID/password fallback. See 04 for the refined scheme. |
| 7 | **Wire the hardcoded `NetworkConfig` flags** now or later? | with admin UI / separate pass | Do it during initiative 3 and enforce server-side. | _TBD_ |
| 8 | **Avatars: files or DB BLOBs** after SQLite migration? | keep files / move to BLOBs | Keep as files; revisit only if it simplifies backup/wipe. Note: with encryption at rest, avatar *files* sit outside the encrypted DB — consider encrypting them too or moving to BLOBs. | _TBD_ |
| ★9 | **Identity mode = deployment switch?** (auth) | anonymous only / add opt-in `authenticated` mode | Yes — `identity.mode: anonymous (default) \| authenticated`. Anonymous stays effortless & default; auth is opt-in for website hosting. See 05. | _TBD_ |
| 10 | **Auth library** for `authenticated` mode | Better Auth / atproto / both | Better Auth first (shares SQLite/SQLCipher DB, gives roles+passkeys, solves admin bootstrap in that mode). atproto later, website-only (needs internet). See 05. | _TBD_ |
| ★11 | **End-to-end encryption?** Server currently sees all plaintext. | none / at-rest only / optional E2EE for DMs+private channels | At-rest (01) as baseline; optional E2EE as its own initiative — it disables server-side LLM/RAG/search for those convos. Top-level strategic call. See 07. | _TBD_ |
| 12 | **Message retention / ephemerality** default | keep forever / configurable TTL | Add configurable per-channel/global TTL + reaper; cheap on SQLite, high privacy fit. Default off (keep) for team mode, easy to enable. See 07. | _TBD_ |
| 13 | **i18n/RTL README-vs-reality gap** | implement / soften README | README promises multilingual+RTL that isn't built. Decide to implement (dir/lang/translation) or adjust the README. See 07. | _TBD_ |
| ★14 | **LAN transport security** (no HTTPS off-grid). `http://<lan-ip>` is not a secure context → no WebCrypto, no service worker. | QR-bootstrapped app-layer session encryption / real-cert (domain+DNS-01) / plaintext | QR delivers the host's public key → Noise_NK / authenticated X25519 + XChaCha20-Poly1305 over plain HTTP, via a bundled lib (`@noble/*` or libsodium.js). Real-cert path only for self-hosters. See 08. | _TBD_ |
| 15 | **Off-grid PWA offline shell** | accept loss / real-cert / native WebView cert | Service worker can't register on an insecure LAN origin (silently fails today). Accept under app-layer crypto, or pursue real-cert for self-hosters. See 08. | _TBD_ |
| ★16 | **Security = configurable spectrum** (disaster-open ↔ protest-hardened) | named presets / raw toggles | **Presets, not a toggle matrix** — `open`/`standard`/`hardened` (default `standard`) + `custom` override; each layer active-or-passthrough; client negotiates from `/api/config`+QR. See 09. | **Owner intent set:** host trusted (E2EE optional, not default); QR rotating **but configurable** (static/none too); everything optional incl. fully-open no-crypto mode. |
| 17 | **E2EE default even in `hardened`?** | opt-in / on-by-default | Opt-in per DM/private channel (it disables server LLM/search). Owner: include E2EE as an option even though host is trusted. See 07/09. | _TBD_ |

## Notes captured during research (2026)

- `node:sqlite` is present and working on the repo's Node **24.13.1** (`DatabaseSync`, sync API,
  ExperimentalWarning). Zero external deps — attractive for Pi hosting; unverified under nodejs-mobile.
- The RN app (`../react-native-test-app`) is a stock **Expo SDK 52 / RN 0.76.6** managed starter with
  `react-native-webview` and `expo-web-browser` already present; no LOAM/native/server code yet.
- `packages/qr` already exports `wifiPayload()` (standard `WIFI:…` string) and `encodeQR()` /
  `renderQRToSvg()` — the QR generation for both the hotspot-join and LOAM-access codes is largely done.
- Current server persistence is flat JSON in `.loam/` flushed every 1s (`saveAllData` + `setInterval`),
  which SQLite replaces with transactional writes.
