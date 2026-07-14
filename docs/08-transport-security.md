# 08 — Transport security on an off-grid LAN (no HTTPS)

> **⚠️ SUPERSEDED IN PART BY docs/20 (transport auth-binding).** The status block below describes the
> shipped #70/#75 foundation, but docs/20 fixes a **Critical** flaw in it and corrects three claims here:
> (1) the tunnel no longer forwards the **cookie** for a `bound` session — identity is the un-sniffable
> session key, resolved server-side via a trusted internal `x-loam-user` (the plaintext cookie is not a
> credential for a bound/`required` session); (2) the cookie-free public bootstrap is now
> **`GET /api/bootstrap`**, and `GET /api/config` is tunnel-only content for a bound session (it no
> longer "runs before a session exists" on a `required` node); (3) the claim that "**WS frames aren't
> sequence-numbered / a replayed frame is idempotent**" is **wrong and now fixed** — WS frames carry a
> per-connection sequence + connection-bound AAD and are preceded by a reflection-safe key-confirmation
> challenge (docs/20 §7). Read docs/20 for the authoritative auth model; the encryption/handshake/tunnel
> mechanics below still hold.

> **Status: Layer 1 (QR-bootstrapped session encryption) is BUILT AND SHIPPED end-to-end** — server,
> crypto, and client are all done (`feat/transport-encryption`). `@loam/crypto` has the X25519
> handshake (host-static + ephemeral, forward-secret) + XChaCha20-Poly1305 framing + emoji fingerprint.
> The server persists a host transport keypair (rotated by the kill switch), serves `POST
> /api/transport/handshake`, and transparently decrypts request bodies / encrypts responses (global
> Fastify hooks) + seals WS frames for `/ws?enc=<sid>`. The client routes every fetch and the WebSocket
> through `apps/client/src/lib/transport.ts`, which does the QR-bootstrapped handshake, seals/opens
> frames, and gates `required` mode behind a "scan the join QR" screen when no QR key is available.
> Gated by `security.transportEncryption` (`off` default / `optional` / `required`), which is now the
> axis that distinguishes the `open`/`standard`/`hardened` profiles (the docs/09 gap). `required` mode
> is deployable today: a client with no QR-delivered host key simply cannot connect, so there is no
> silent downgrade to plaintext. **Anti-replay is now built:** every sealed REST request carries a
> per-session monotonic sequence number *inside* its authenticated envelope, and the server enforces a
> DTLS-style sliding window (`TRANSPORT_REPLAY_WINDOW`), so a captured ciphertext replayed within the
> session's lifetime is refused (409) before its handler runs — a duplicate/out-of-window sequence is
> rejected while modest reordering/concurrency is tolerated. **Path-hiding tunnel is now built:** in
> `required` mode the client sends every post-handshake request as an opaque `POST /api/transport/tunnel`
> whose sealed body is `{ m, p, body }`; the server re-dispatches it internally (`server.inject`, with
> the caller's cookie + an unforgeable per-boot internal token) and seals the `{ status, contentType,
> bodyB64 }` response back — so the real method, path/query (a search term, which channel is read), and
> response body are all ciphertext; only `POST /api/transport/tunnel` is on the wire. `optional` mode
> keeps the lighter per-route body sealing (path visible). **Image encryption is now built too:** in
> `required` mode the avatar/attachment routes are no longer exempt — a direct `<img src>` GET (which
> can't carry the session header) is refused (401), forcing the client to fetch images through the tunnel
> (`encryptedImageUrl` / the `useEncryptedImage` hook) and render them from a cached `blob:` object URL,
> so image bytes are sealed on the wire like everything else. `optional`/`off` nodes still serve images
> directly in clear (lighter). So in `required` mode a **post-handshake REST request** reveals only that
> a `POST /api/transport/tunnel` happened, plus coarse ciphertext size/timing — its method, path/query,
> and body are all sealed. Still observable (unavoidably): the **bootstrap** — `GET /api/config` and
> `POST /api/transport/handshake` run before a session exists — and the **WebSocket upgrade**
> `GET /ws?enc=<sid>`, which exposes the session id and that a WS connection opened (its frames are then
> sealed). (WS frames aren't sequence-numbered: a replayed server→client frame is idempotent client-side
> — every event is upserted by id.)


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

## Node-to-node sync over the transport channel (BUILT)

> **Status: BUILT & TESTED** (`feat/sync-transport-encryption`). The puller side of the transport
> handshake now also lives **server-side**, so node-to-node sync (docs/11) rides the same encrypted
> channel instead of plain HTTP.

The transport hooks above were written for the browser client, but they don't care *who* the peer is —
they decrypt any request bearing `x-loam-enc` + a sealed `{ enc }` body, and seal the response. So a
LOAM node that **pulls** from another node can be a transport *client* to it. `apps/server/src/sync-transport.ts`
is that client (pure `@loam/crypto`, no native deps), mirroring `apps/client/src/lib/transport.ts`:

- `handshakeWithPeer(peerUrl, { expectedHostKey? })` — `transportClientHello()` → `POST
  /api/transport/handshake` → validate with `TransportHandshakeResponseSchema` → `transportClientDerive`
  → a `{ sessionId, key, hostPublicKey }` session. A supplied `expectedHostKey` (a pinned peer key) is
  verified against the handshake's returned `hostPublicKey` and **fails closed** on mismatch.
- `sealedFetch(session, peerUrl, path, { body?, syncToken?, headers?, reHandshake? })` — seals a request
  as `{ enc: sealTransport(key, JSON.stringify({ s, b?, tok? }), aad) }`. A request with a body **or** a
  `syncToken` is a sealed POST (so a `syncToken` forces a sealed POST even with no body — carrying the token
  and proving key possession); with neither it's a bodyless GET that sends no envelope but still asks for a
  sealed response. `aad = "${method} ${path}"`, header `x-loam-enc: sessionId`; unseals a `x-loam-enc: 1`
  response. On a `401` or an undecryptable/unsealed response it re-handshakes **once** and retries — always
  safe because every sync request is a read-only query.

**Framing note (important):** every sealed sync request is a **POST** whose inner sealed plaintext is the
**`{ s, b?, tok? }` envelope** — `s` a per-session monotonic sequence (starts at 1, resets on
re-handshake), `b` the route body (omitted for a bodyless digest), `tok` the `sync.token` bearer
credential. The peer's `preValidation` runs `s` through its `TRANSPORT_REPLAY_WINDOW` sliding window (a
replayed/out-of-window sequence gets a **409**), stashes `tok` for `syncPeerAuthorized`, and sets
`request.body = envelope.b` before schema validation. `s` (and `tok`) live inside the AEAD, so they can't
be renumbered/read without breaking the tag. Even a tokenless digest is a POST carrying just `{ s }` — so
the **response** can be bound to it: the peer seals its reply under `${method} ${path}#${seq}` (the
request sequence; sync paths carry no query, so `path === url`), and the puller opens it with the exact
`seq` it sent, so a captured response can't be **replayed or cross-fed** to another request on the same
route (the tunnel binds its responses `{s,m,p}` the same way). An `off`-mode peer's plaintext digest stays
a GET (nothing to seal). **Encrypted sessions authorize
ONLY via the sealed `tok`** — the `x-loam-sync-token` header is honoured solely on the plaintext path, so
a captured token can't authorize an attacker's own encrypted session by being attached as a header.

**Tunnel-only gate reconcile:** under `required` mode the peer makes user-facing content *tunnel-only*
(`/api/transport/tunnel`, identity-bound). Sync is different — it is authenticated by the shared
`sync.token` (a *node* credential, not a user identity, so there is nothing to bind or carry over
`x-loam-user`, and the tunnel would admit neither an unbound session nor the token). So the two sync
routes (`/api/sync/digest`, `/api/sync/messages`) are reachable via a **direct sealed request**
(`DIRECT_SEALED_SYNC_ROUTES` in `app.ts`): they still **must** be sealed in `required` mode (a plaintext
hit with no resolved session is refused), so the data is encrypted end-to-end; they are only exempt from
the tunnel/bound requirement, never from encryption.

`fetchPeerJson` (`apps/server/src/app.ts`, the single choke point for every peer request) decides per
peer:

1. Reuse a cached decision if fresh (a live session is cached ~11 h — just under the peer's 12 h
   server-side TTL; a "this peer runs plaintext" verdict is cached only ~5 min so a peer that *enables*
   transport is noticed quickly). The cache is cleared on any config PATCH and by the kill switch.
2. Otherwise learn the peer's posture from its unauthenticated `/api/bootstrap`
   (`networkConfig.transportEncryption` + `transportPublicKey`) — the public, cookie-free bootstrap;
   under the auth-binding change `/api/config` itself became session-gated content, so posture is read
   from `/api/bootstrap` instead.
3. `off` / no key / posture unreadable → the **unchanged plaintext path** (a genuinely `required` peer
   whose `/api/bootstrap` we can't read just 401s the plaintext pull, surfacing as a normal sync failure —
   never a silent wrong result).
4. `optional` / `required` with a key → handshake + route the digest/messages/attachment requests through
   `sealedFetch`, so the **sync data AND the `sync.token`** are sealed on the wire (the token rides inside
   the `{ s, b, tok }` envelope, never a header). **Fail-closed:** a `required` peer (or any peer with a
   pinned key) that can't complete the handshake fails the sync attempt rather than falling back to a
   plaintext pull that would 401 anyway; an `optional` peer degrades to plaintext (it still serves the
   clear path). An UNSEALED 2xx over a live session is refused (a downgrade), never imported.

This closes a real gap: a peer running `transportEncryption: "required"` previously **401'd every
plaintext sync pull** (its transport hook refuses any `/api/*` content request without a session), so it
could not be synced *from* at all. It can now.

**Attachments** are fetched over the channel the peer supports: from an **encrypted** peer as base64
JSON from `POST /api/sync/attachment` (a string payload `onSend` can seal), **not** the tunnel-only binary
`/api/attachments/:fileName` (which a peer's sessionless GET would 401, dropping every attachment on a
required peer). A **plaintext** (`off`-mode) peer keeps using the legacy public binary GET
`/api/attachments/:fileName` — preserving back-compat with older / off-mode peers that predate the
sync-attachment route (an older *encrypted* peer without it must be upgraded). Only attachments on
syncable (public) messages are served.

**Token confidentiality (honest scope):** over a **sealed** channel (`optional`/`required` peer) the
`sync.token` is confidential + authenticated — it never leaves the AEAD. Over the **plaintext** path
(an `off`-mode peer) it still rides as an `x-loam-sync-token` header, since there is no encrypted channel
to carry it — but there the whole sync is plaintext anyway, and the token gates public-data-only reads.

### MITM disposition between nodes (honest scope)

The peer's static transport key is learned from its `/api/bootstrap` **over plain HTTP** — that is *not*
an out-of-band channel (unlike the browser's join-QR `#k=`). Unpinned, this is **unauthenticated key
discovery**, not true trust-on-first-use: the key is taken from the peer's advertisement on *each*
resolve and is **not** persisted or pinned across session expiry, so there is no first-seen key to detect
a later swap against. So by default node-to-node sync gets **passive-eavesdropper confidentiality +
integrity for the sync data and the token, but NOT active-MITM resistance** between nodes: a
machine-in-the-middle could present its own key on `/api/bootstrap` and the handshake, then re-encrypt to
the real peer (and so read the token it terminates). Pinning the peer key closes that.

To get active-MITM resistance, an operator **pins** the peer's key: `SyncPeer.transportKey` (a
base64url X25519 key, e.g. copied from the peer's join QR / host screen out-of-band). When set, the
puller verifies the handshake's `hostPublicKey` against it and **refuses to sync on a mismatch**, and
goes encrypted regardless of what `/api/bootstrap` claims. Unpinned = unauthenticated key discovery (the
honest default; documented here and in docs/15 as the residual). This mirrors the browser's
QR-key-vs-config-key trust rule.

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
