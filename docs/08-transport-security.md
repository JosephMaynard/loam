# 08 — Transport security on an off-grid LAN (no HTTPS)

> **Status: Layer 1 (QR-bootstrapped session encryption) is BUILT — server + crypto done, client in
> progress** (`feat/transport-encryption`). `@loam/crypto` has the X25519 handshake (host-static +
> ephemeral, forward-secret) + XChaCha20-Poly1305 framing + emoji fingerprint. The server persists a
> host transport keypair (rotated by the kill switch), serves `POST /api/transport/handshake`, and
> transparently decrypts request bodies / encrypts responses (global Fastify hooks) + seals WS frames
> for `/ws?enc=<sid>`. Gated by `security.transportEncryption` (`off` default / `optional` / `required`),
> which is now the axis that distinguishes the `open`/`standard`/`hardened` profiles (the docs/09 gap).
> **Layer-1 scope (documented below):** request/response BODIES + WS frames are encrypted; GET request
> paths + query strings and image bytes remain visible metadata (the tunnel + image encryption are v2).


## The problem

Off-grid, everyone joins a WiFi hotspot and reaches LOAM at a private address like `http://192.168.0.1`.
There is no internet, so **no publicly-trusted TLS certificate** and no HTTPS. That means:

- **`http://<private-ip>` is not a "secure context".** Secure contexts are HTTPS, `http://localhost`,
  `127.0.0.1`, or `file:` — a LAN IP is none of them.
- Therefore **`crypto.subtle` (WebCrypto) is unavailable** and **service workers won't register** on the
  off-grid origin. (Verified today: `main.tsx` registers the SW in PROD and the failure is silently
  swallowed — so the offline-PWA promise doesn't currently hold off-grid.)
- Still available insecure: **`crypto.getRandomValues`** (a real CSPRNG — the client already uses only
  this, no `subtle`/`randomUUID`), **IndexedDB**, and **`ws://`**.

So we can't lean on the browser's TLS or WebCrypto. Any confidentiality has to be **app-layer crypto
using a bundled library**, bootstrapped by an **out-of-band channel we already have: the QR code.**

## Threat model (what actually needs defending on a LAN)

1. **Network eavesdroppers.** An open hotspot = zero encryption. Even a **WPA2 password-protected**
   hotspot doesn't help *between members*: anyone who knows the shared password and captured the
   handshake can derive keys and decrypt other clients' traffic. (WPA3-SAE fixes this, but Android's
   `LocalOnlyHotspot` is typically WPA2-PSK.) → **App-layer encryption is what actually protects message
   confidentiality on the wire.**
2. **Active MITM at join.** Someone stands up a look-alike node / intercepts the first connection. A bare
   join token does **not** stop this. The fix is delivering the host's key out-of-band (the QR).
3. **Host seizure / malicious host.** The host stores and relays messages. Session encryption protects
   the wire but the host still holds plaintext. Mitigated by at-rest encryption ([01](01-sqlite-migration.md))
   + kill switch ([02](02-kill-switch.md)) + ephemeral messages ([07](07-more-features.md)); *fully*
   addressed only by E2EE ([07](07-more-features.md)), which trades away server-side LLM/search.

## Evaluating the original idea (token in the QR)

`http://192.168.0.1?token=asdfghjk` is a good **authorization + frictionless-join** primitive, but two
upgrades make it a real security mechanism:

1. **Put the host's public key (or its fingerprint) in the QR, not just a token.** The QR is shown
   physically and scanned in person — an *authenticated out-of-band channel*. If the client learns the
   host's public key from the QR, it can set up an encrypted, MITM-resistant channel over plain HTTP,
   because trust is rooted in the QR, not the network. This is the crucial change; the token alone can't
   provide it. A QR easily holds a 32-byte X25519 key plus a token.
2. **Keep the token out of the query string.** Query-string tokens leak into server logs, browser
   history, and `Referer` headers. Put it in the **URL fragment** (`http://192.168.0.1/#t=…`) — the
   fragment isn't sent to the server automatically; the client JS reads `location.hash` and submits it in
   a POST body/header. Make it **single-use + expiring**, bound to a new session.

## Recommended approach: QR-bootstrapped app-layer session encryption

Think of it as "TLS we bootstrap ourselves via the QR," using a vetted crypto library (WebCrypto is
unavailable, so ship one):

- **Host static keypair** (X25519), persisted encrypted at rest. Its **public key goes in the join QR**.
- **Handshake**: use the **Noise Protocol Framework — pattern `Noise_NK`** (client knows the responder's
  static key from the QR; client stays anonymous), or equivalently an authenticated X25519 ECDH:
  client generates an ephemeral keypair, does ECDH against the QR-delivered host key, both sides derive a
  session key via HKDF. Noise gives **forward secrecy** and identity hiding and saves you from rolling
  your own — strongly preferred over an ad-hoc scheme.
- **Encrypt everything** (REST bodies + WebSocket frames) in a single **AEAD envelope**
  (XChaCha20-Poly1305) keyed by the session key. Plain HTTP now carries only ciphertext.
- **Join token** stays as an orthogonal *authorization* check (prove you scanned the physical QR;
  one-time; rate-limited), separate from the confidentiality the handshake provides.
- **Verification UX**: derive a short **safety word / emoji fingerprint** from the host public key and
  show it in the UI (and optionally on the host screen). MITM is already prevented by the QR-delivered
  key; the fingerprint lets humans confirm they scanned the real host and detects a swapped QR poster.

### Libraries (must work in an insecure context — no WebCrypto)
- **`@noble/curves`** (x25519), **`@noble/ciphers`** (xchacha20poly1305), **`@noble/hashes`** (hkdf) —
  audited, tiny, pure-JS, use `getRandomValues`, run anywhere. Lightest option.
- **`libsodium.js`** (WASM) — batteries-included: `crypto_kx`, `crypto_box`, and `secretstream` (ideal
  for encrypting the streaming WS/LLM channel). Heavier bundle.
- A JS **Noise** implementation on top of either, for the handshake framing.
- **Do not hand-roll** the handshake or AEAD.

### What this buys / doesn't
- ✅ Confidentiality + integrity + MITM resistance **against network attackers** over plain HTTP — the
  core "no HTTPS" problem solved, no certificates, no browser warnings.
- ✅ Frictionless join preserved (scan QR → connected + encrypted, invisibly).
- ❌ Does **not** hide plaintext **from the host** (it decrypts to relay/LLM/search). That's the E2EE
  layer, deliberately separate.
- ❌ Does not restore the **service worker / offline PWA** (still an insecure context) — see below.
- ⚠️ **Metadata** (who talks to whom, timing, sizes) is still visible to the host and partially to the
  network. Note it honestly.

## Alternative: get a real secure context (real TLS on the LAN)

Only viable for **self-hosters with a domain**, *not* a mass-distributed app:

- Own a domain, obtain a **wildcard cert via DNS-01** (Let's Encrypt, while online), and resolve
  `*.loam.example.com → 192.168.0.1` using DNS the host serves on the hotspot. Clients then load
  `https://node.loam.example.com` with a **publicly-trusted cert and no warning** → a real secure context
  → **WebCrypto, service workers/offline PWA, and `wss://` all work normally.**
- **Pros:** standard crypto stack; unlocks the PWA offline shell and WebCrypto; no app-layer handshake
  needed. **Cons:** needs a domain + **online cert renewal every ~90 days** + the host running DNS;
  mildly compromises "pure off-grid" at setup time.
- **Why it can't be the default for the Android app:** you'd have to ship a *shared* cert private key
  inside a public app, which is instantly compromised (anyone extracts it). Per-install certs need a CA
  the client trusts → self-signed warnings, which is worse UX than the QR handshake. **So: app-layer QR
  handshake for the distributed/Android case; real-cert option documented for advanced self-hosters.**

## Layered recommendation

1. **Layer 1 — QR-bootstrapped session encryption** (this doc). High value, achievable, no certs; makes
   plain-HTTP confidential against the network. **Do this.**
2. **Layer 2 — optional E2EE** for DMs / private channels ([07](07-more-features.md)) for when the host
   must not be able to read; knowingly disables server-side LLM/search for those conversations.
3. **Plus** at-rest encryption ([01](01-sqlite-migration.md)) + kill switch ([02](02-kill-switch.md)) +
   ephemeral messages ([07](07-more-features.md)) for the seizure case.

## Loose ends to decide
- Static vs **rotating** QR token: static suits a printed poster; rotating limits a photographed QR's
  lifetime. **Make it configurable** (`qr.mode: none|static|rotating`) — see the profile model in
  [09](09-security-profiles.md). Rotation only affects new joins; connected sessions are undisturbed.
- Offline PWA off-grid: accept the loss under Layer 1, or pursue the real-cert path for self-hosters, or
  investigate whether the **Android app's own WebView** can be given a trusted local cert (helps only the
  host device, not remote joiners' browsers).
- Where the host key lives on Android (device keystore vs the encrypted DB) and how the kill switch
  destroys it.
- Handshake library choice (`@noble/*` vs `libsodium.js`) and Noise vs plain authenticated ECDH.
