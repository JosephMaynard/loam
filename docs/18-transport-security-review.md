# 18 — Transport encryption: reviewer's guide

A map for anyone auditing LOAM's app-layer transport encryption (docs/08) — an external model, a
security researcher, or a future maintainer. It points at the exact code, states the guarantees and
the **known limitations honestly**, and lists the concrete things worth attacking. This covers Layer 1
(session encryption) **and** the v2 hardening (anti-replay + path-hiding tunnel + image encryption).

> **Context that shapes the design.** LOAM runs on a plain-HTTP LAN with **no secure context**, so
> `crypto.subtle` (WebCrypto) and service workers are unavailable and TLS is impossible without a
> publicly-trusted cert (see docs/08). All confidentiality is therefore **app-layer crypto** using a
> bundled pure-JS library (`@loam/crypto`, built on `@noble/*`), bootstrapped by the **join QR** — the
> only out-of-band authenticated channel available. The threat actor is a **network attacker on the
> LAN** (eavesdrop / MITM / inject / replay). The host itself is trusted for its local users (it
> decrypts to relay/search/LLM); hiding data *from the host* is the separate, deliberately-unbuilt E2EE
> layer (docs/07).

## Where the code lives

| Concern | File | Notes |
|---|---|---|
| Primitives (X25519 handshake, XChaCha20-Poly1305 AEAD, HKDF, fingerprint) | `packages/crypto/src/index.ts` | `transportClientHello`/`transportServerAccept`/`transportClientDerive`, `sealTransport`/`openTransport`. Do **not** hand-audit the AEAD/curve — that's `@noble/*`; audit our *use* of it (nonces, aad, key handling). |
| Host keypair + handshake endpoint | `apps/server/src/app.ts` | `ensureTransportIdentity` (persisted, kill-switch-rotated, validated on load), `POST /api/transport/handshake` (unauth bootstrap, rate-limited, session cap + eviction). |
| Request/response sealing hooks | `apps/server/src/app.ts` | `onRequest` (resolve session, fail-closed), `preValidation` (decrypt + replay check), `onSend` (seal string responses). |
| Anti-replay window | `apps/server/src/app.ts` | `acceptTransportSeq` + `TransportSession.{maxSeq,seen}`, `TRANSPORT_REPLAY_WINDOW`. |
| Path-hiding tunnel | `apps/server/src/app.ts` | `POST /api/transport/tunnel`, `internalTunnelToken` + `isInternalTunnelRequest`, `TUNNELLABLE_METHODS`. |
| Client (all of it) | `apps/client/src/lib/transport.ts` | `ensureSession`, `attemptFetch`/`tunnelFetch`, `encryptedImageUrl`, seq counter, re-handshake retry. |
| Image encryption | `apps/client/src/lib/use-encrypted-image.ts`, `components/Avatar.tsx`, `components/AttachmentImage.tsx` | plus the dropped image-route exemption in `requiresTransportSession`. |
| Tests | `apps/server/src/app.test.ts` ("transport …" describes), `apps/client/src/lib/transport.test.ts`, `packages/crypto/src/index.test.ts` | |

## Guarantees (what it's meant to provide)

1. **Confidentiality + integrity of request/response bodies** against a LAN network attacker, over
   plain HTTP, via an authenticated X25519 handshake + XChaCha20-Poly1305, keyed per session.
2. **MITM resistance at join** — the host's static public key is delivered by the **physical QR**
   (`#k=` URL fragment, never sent to the server), so trust is rooted out-of-band, not in the network.
   A swapped QR poster is surfaced by the emoji fingerprint (`transportFingerprint`).
3. **No silent downgrade.** `required` mode with no QR key **gates the app** (`TransportNeedsQrError`)
   rather than falling back to plaintext. A presented-but-unknown session id is 401'd (not served
   plaintext). A **QR key present forces encryption even if the (unauthenticated) `/api/config` mode
   says `off`** — defeating a MITM config-downgrade (regression-tested).
4. **Anti-replay** (v2): every sealed REST request carries a per-session monotonic sequence inside the
   authenticated envelope; a captured ciphertext replayed within the 12h session is 409'd. Sliding
   window tolerates real reordering.
5. **Metadata hiding** (v2, `required` mode): method, path, query, response status/body, and image
   bytes are all ciphertext — only that `POST /api/transport/tunnel` happened (+ coarse size/timing)
   is visible.

## Known limitations (documented, not defects)

- **Not hidden from the host.** The host decrypts everything to relay/search/LLM. That's E2EE
  (docs/07), deliberately separate and unbuilt.
- **Coarse traffic analysis** remains: request/response **sizes and timing** are visible even through
  the tunnel. No padding/cover traffic.
- **WS frames are not sequence-numbered.** A replayed *server→client* frame is idempotent client-side
  (events upsert by id), so replay has no effect — but this is an argument, not an enforced check;
  worth confirming there's no event whose re-application is not idempotent.
- **`optional` mode** intentionally leaves paths + image bytes in clear (lighter; MITM guarantee only
  with a QR key). Only `required` gets the full tunnel.
- **No forward secrecy *within* a session** beyond the ephemeral handshake — a session key compromise
  exposes that session's traffic (standard for a session cipher; sessions are ephemeral, 12h TTL).
- **Offline PWA** does not work off-grid (insecure context blocks the service worker) — a UX gap, not
  a crypto one.

## What to attack (audit checklist)

**Handshake / keys**
- Can a MITM force key agreement on a key it controls? (Should be impossible without the QR key;
  `required` never falls back to the config-advertised key — see the `ensureSession` tests.)
- Nonce reuse in `sealTransport` (random 24-byte XChaCha nonce per frame — confirm it's fresh each
  call and never derived from the seq).
- Persisted host identity: is a corrupt/truncated stored key rejected and regenerated? (`isValidTransportIdentity`.)

**AAD / framing**
- The REST aad is `${METHOD} ${url}`; the WS aad is the constant `"ws"`. Can a frame sealed for one
  route/channel be opened on another? (aad-binding test.) Is the tunnel's aad
  (`POST /api/transport/tunnel`) consistent client↔server so responses can't be cross-fed?

**Anti-replay**
- Sequence handling: overflow (2^53), out-of-order beyond the window, duplicate at the window
  boundary, a request with a missing/negative/float `s`. Is the `seen` set provably bounded (≤ window)?
- Does a re-handshake reset the client counter **and** start the server window empty, in lock-step?

**Tunnel (the biggest new surface)**
- **Internal bypass token**: 256-bit per-boot random, `timingSafeEqual`, never leaves the process.
  Can an external request forge `x-loam-internal` to skip transport enforcement or the rate limiter?
- **SSRF / target abuse**: `p` is restricted to `/api/`, not `/api/transport/*`, and rejects `..`.
  Can a normalized `p` still escape the prefix or reach the handshake/tunnel (recursion)? Can it hit
  an endpoint the caller shouldn't? (Inner runs under the **caller's own cookie** — no new authz.)
- **Cookie handling**: the tunnel forwards the outer request's cookie to the inner inject and forwards
  the inner `Set-Cookie` back out. Can this cross identities or leak another user's session?
- **Rate-limit bypass**: internal requests are allow-listed. Can an attacker amplify (1 outer →
  many inner)? (One outer → one inner; outer is rate-limited.)
- **Response reconstruction**: a sealed non-descriptor reply is surfaced as a 400 (not a crash);
  confirm no path decodes attacker-influenced base64 into something dangerous.

**Image encryption**
- In `required` mode a direct `/api/avatars|attachments` GET must 401 (no clear bytes); via the tunnel
  it must reach the route. Object-URL cache: any cross-user leakage? bounded + revoked?

**Fail-closed**
- A mutation presented under a live session with a **plaintext** (unsealed) body must be refused (not
  run) — the fail-closed check. Confirm every unsafe method is covered.

## Running it
`pnpm test` (server "transport …" describes + `transport.test.ts` + `packages/crypto`). The crypto
suite is deterministic (a previously-flaky tamper test was fixed). See `feat/transport-hardening` / the
PR for the full diff.
