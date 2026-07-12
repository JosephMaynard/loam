# 20 — Binding identity to the transport session (fixing the plaintext-cookie flaw)

> **Status: DESIGN v2 (not built) — incorporates external design review.** Fixes the **Critical**
> finding: in `required` mode the `loam_session` **cookie** — the app's bearer credential — travels as a
> **plaintext HTTP header outside the AEAD channel**, so a LAN attacker can steal it and impersonate the
> victim (up to admin). This version folds in the review's rollout/proof-of-key corrections, which are
> **merge-blocking** relative to v1. It also folds in the two image findings (High + Med #5) and
> co-designs with the tunnel-response-binding + WS-sequencing follow-ups (review #3/#6).

## 1. The flaw (verified)

`getSessionUserId` authenticates from the `loam_session` cookie → `sessions.get(token)` → userId. The
cookie is the credential, and it is a plaintext HTTP header — **outside** the sealed body/tunnel. The
handshake is anonymous, so an attacker mints their **own** session and tunnels requests carrying the
**victim's sniffed cookie**; the tunnel forwards it inward → the server runs the attacker **as the
victim**. Bodies are private but the credential is stealable. `required` is opt-in / off by default, so
no default deployment is exposed — but its stated guarantee is broken until this lands.

## 2. Principle

> In `required` (or any **QR-verified**, effectively-required) session, the identity credential must
> travel **only inside** the AEAD-sealed channel, and identity is bound to the transport session — whose
> key is derived via ECDH and **never appears on the wire**. The plaintext cookie is not a valid
> credential in this mode. The un-sniffable **session key** (proven per request by a valid sealed
> envelope) is the effective credential.

## 3. The core invariant (state it once, enforce it everywhere)

> **In `required` mode, external post-handshake traffic may reach ONLY the encrypted tunnel.** The sole
> external exceptions are the **cookie-free public bootstrap** (`/api/config`, `/api/health`), the
> **handshake**, and the **sealed `/api/session/resume`** endpoint. A live `x-loam-enc` session id, by
> itself, authorizes **nothing** — not `/api/users`, `/api/messages`, images, admin, or any content
> route. This makes a captured session id **genuinely inert** (broadens v1's image-only rule per review).

Enforced in `onRequest`: in `required` mode, a content route is served only when it is the **internal
tunnel dispatch** (`isInternalTunnelRequest`); a direct request bearing only a session id → 401.

## 4. The credential model — a NEW, separate namespace (review's #1, the crux)

**Do NOT reuse the existing `sessions` (cookie-token) map.** A previously-sniffed cookie token could
otherwise be submitted inside an attacker's own sealed `/resume` and restore the whole attack.

- **New table `transport_identity_tokens`** (`tokenHash → { userId, createdAt }`), separate from the
  legacy `sessions`. Tokens are **freshly generated 256-bit** secrets, issued **only** over a
  QR-verified session, and **stored hashed** (never the bearer value at rest).
- **Legacy cookie tokens are NEVER accepted at `/resume`.** The two namespaces never mix.
- **No safe auto-migration** from an exposed HttpOnly cookie to a secure token: enabling/upgrading
  `required` mode **invalidates legacy cookie credentials for that mode**, and existing required-mode
  users receive **new identities**. Admin authority is re-established via the normal bootstrap/promote
  path (an operator who "was" admin re-bootstraps or is re-promoted) — documented as the recovery path,
  since these identities are anonymous/ephemeral with no account to restore.
- The secure token persists the user across re-handshakes; it is stored client-side (IndexedDB,
  namespaced per node origin) and **only ever transmitted sealed**.

## 5. Flows (`required` / QR-verified)

```
1. GET /api/config            (PUBLIC bootstrap; client sends credentials:"omit")   [CHANGE]
   → node name, mode, transportPublicKey.  Mints NO identity, sets NO cookie, NO currentUser.
   (Universally public + cookie-free — the client doesn't know the mode yet. A 2nd
    authenticated bootstrap is done ONLY for optional/off mode.)

2. POST /api/transport/handshake   (bootstrap; anonymous; credentials:"omit")        [CHANGE]
   → transport session (sessionId + derived key). No user bound.

3. POST /api/session/resume    (DIRECT but SEALED endpoint — NOT tunnelled)          [NEW]
   Why direct: during resume there is no user yet, so the tunnel's x-loam-user path
   can't apply; a direct endpoint keeps the outer TransportSession reachable via the
   request WeakMap. Its PATH is harmless bootstrap metadata; its BODY is sealed and
   carries a normal sequence number (proof of key + replay-protected).
   body (sealed): { token? }
     • no token           → mint new user + new 256-bit token; bind session.userId; store token hash
     • valid token        → resume that user; bind session.userId
     • nonempty invalid   → explicit AUTH ERROR (401). NEVER silently mint.            [CHANGE]
     • already-bound sess → NEVER rebind to a different identity (409/no-op).          [CHANGE]
   resp (sealed): { currentUser, token }
   Idempotency: cache the resume result on the transport session, so a fresh-sequence
   RETRY (lost response after a mint) returns the SAME user+token — never a 2nd mint.  [CHANGE]
   Client stores `token` (IndexedDB); sets currentUser.

4. All content requests       (SEALED, via the tunnel; authenticated by session.userId)
   → NO cookie sent; tunnel does NOT forward a cookie; identity = bound session user.  [CHANGE]

5. WebSocket  GET /ws?enc=<sid>   → see §7: a session id is NOT proof of key.           [CHANGE]

6. Re-handshake (expiry/reconnect) → repeat 2–3 (resume BEFORE retrying the request);
   concurrent re-handshakes share ONE in-flight handshake+resume.                      [CHANGE]
```

`optional`/`off` (non-QR-verified): **unchanged** cookie bootstrap + auth (see §9).

## 6. Server changes

- **`transportSessions` entry** gains `userId?` and a cached `resumeResult?` (for idempotent retry).
- **`transport_identity_tokens` DAL table** (`tokenHash → userId`), persisted; kill switch / wipe / ban
  / logout delete the relevant rows (see §8).
- **`POST /api/session/resume`** (direct, sealed): resolves the outer session from `transportRequestSessions`
  (the WeakMap), applies the mint/resume/reject/immutable/idempotent rules above, binds `session.userId`.
- **Identity resolution**: for the **internal tunnel dispatch**, identity = `session.userId`, passed as a
  trusted `x-loam-user` **only** by the tunnel handler, gated by the unforgeable `x-loam-internal`. The
  inner resolver requires **both** a valid internal token **and** a bound user, and **never** honours a
  client-supplied `x-loam-user`/`x-loam-internal` (strip them from external requests). Cookie fallback
  applies only to optional/off.
- **Tunnel handler**: never forwards the outer `Cookie` in `required`; sets `x-loam-user` from the bound
  session; rejects tunnelling anything but content routes once bound (resume is direct, not tunnelled).
- **`GET /api/config` / `/api/health`**: public, cookie-free; in `required` mode return no `currentUser`.
- **Content routes** (incl. images): governed by §3's invariant — internal-tunnel-only in `required`.
  Images therefore never leave as clear bytes (the tunnel base64-seals the binary response).

## 7. WebSocket key-confirmation (review #3-of-crit / WS section)

A visible session id is **not** proof of key possession. An attacker who sniffs `?enc=<sid>` can open a
socket the server would associate with the victim (can't decrypt, but false presence, resource use,
racing the real socket). So:

- On open, the server sends a **sealed challenge** (a fresh nonce, sealed under the session key).
- The client (holding the key) unseals it and returns a **sealed proof**.
- **Only after the proof verifies** does the server: bind `userId`, add the socket to the authenticated
  set, broadcast presence, and send application events. Before that the socket receives nothing.
- WS frames also get an **independent server→client sequence + replay window** (co-designs with review
  #6): stream deltas *append* and config/presence *replace*, so replay is **not** idempotent — my v1
  "harmless" claim was wrong.

## 8. Token lifecycle & mode transitions (must be specified)

- **optional → required:** legacy cookie credentials become invalid for content in required mode (§4);
  clients re-bootstrap and resume into a new secure token.
- **required → optional/off:** secure tokens stop being minted; existing ones may be revoked or left to
  expire (decide: revoke on downgrade for cleanliness).
- **runtime config change with live sessions:** re-evaluate per-session on the next request; a session
  that loses its right to content is refused until it re-resumes appropriately.
- **device wipe / explicit logout:** **revoke the secure token server-side FIRST**, then delete
  IndexedDB. (Fixes the docs/15 "device wipe can't revoke the server session" gap for this credential.)
- **ban / deny / kill switch:** invalidate the user's secure tokens **plus** their bound transport
  sessions **plus** their authenticated sockets.
- **transport-session eviction / expiry:** the token survives (persisted); the next handshake+resume
  rebinds. Eviction drops only the session, not the identity.
- **switching server origins:** tokens are namespaced per origin (client + server), so one node's token
  is never presented to another.

## 9. Scope: `required` / QR-verified only (review Q2)

`optional`-without-QR keeps cookie-auth. **A secure identity token must NEVER be sent through an
optional, non-QR-verified session:** that session may have handshaked against a host key learned from the
unauthenticated `/api/config`, which a MITM could substitute — then decrypt the resume exchange and steal
the token. A QR-verified client already forces effective-`required` behaviour, which is exactly the
boundary for issuing/accepting secure tokens. `off` is plaintext by definition.

## 10. Co-design with anti-replay + response-binding (review #3/#6)

- **Resume consumes a normal client request sequence** (it's a sealed request; same `{ s, b }` envelope
  + window).
- **Sealed responses (tunnel + resume) must authenticate the request they answer:** the response
  descriptor includes and binds the **request sequence + canonical method + canonical path**, and the
  client **verifies** them before accepting/using the response — especially before storing a returned
  identity **token**. (Closes review #3: constant-aad tunnel responses being cross-fed/replayed.)
- **WS** gets its own server→client sequence + replay window (§7).
- **Re-handshake performs resume before retrying** the original request; concurrent re-handshakes share
  one in-flight operation.

## 11. Security analysis

- Identity **token**: only ever sealed → never sniffable; separate namespace → a leaked cookie is not a
  valid token; hashed at rest.
- Session **key**: never transmitted → an attacker can't seal as the victim.
- `session → userId` binding is server-side + **immutable** → an attacker's session is bound to *their*
  identity; the victim's session can't be rebound.
- A sniffed **session id** is inert: it can't seal (no key), can't reach content directly (§3), and can't
  authenticate a WS (§7).
- Bootstrap is cookie-free and carries no credential.
- **Residuals:** device compromise exposes the client-stored token (network is the threat model here, not
  device seizure — covered by at-rest encryption + wipe/kill switch); metadata (session id, timing,
  sizes, the bootstrap) remains observable; optional/off retain the weaker cookie model by design.

## 12. Compatibility & a factual correction

- **Correction to v1:** the existing cookie `sessions` **already persist in SQLite**
  (`store.loadSessions()` on boot, persisted on mint) — so a host restart does **not** currently
  invalidate cookie identities. The new `transport_identity_tokens` table therefore also persists (parity
  + no identity churn on restart), with the lifecycle revocations of §8.
- `optional`/`off` behaviour is byte-unchanged.
- Affects the **shipped #70** foundation, not only #75 — `required` wasn't safe against an active LAN
  attacker until this lands; docs/08 to be corrected.

## 13. Tests (acceptance)

- **Impersonation defeated:** a captured cookie **and** a captured `x-loam-enc` id, **without** the
  session key, cannot read/mutate anything in `required` mode, cannot resume (no key → can't seal), and
  cannot authenticate a WS.
- **Legacy-token separation:** a valid *legacy cookie* token submitted at `/resume` is **rejected**.
- **Resume semantics:** no-token mints; valid resumes; invalid → 401 (no mint); already-bound → no
  rebind; a retried resume after a lost response returns the same user+token (no 2nd mint).
- **Direct content refused:** any content route (users/messages/images/admin) via a direct session id in
  `required` → 401; only the tunnel reaches them; images come back sealed.
- **Cookie-free bootstrap:** config/handshake carry no cookie; config mints no identity in `required`.
- **WS key-confirmation:** a socket without a valid sealed challenge-response gets no presence/events and
  is not in the authenticated set.
- **Response binding:** a tunnel/resume response bound to a different request seq/method/path is rejected
  client-side.
- **Lifecycle:** device wipe / ban / kill switch revoke the token + session + socket.
- **optional/off unchanged:** existing cookie-auth tests pass.

## 14. Remaining open questions

1. On `optional → required` upgrade with existing admins: confirm the recovery story (re-bootstrap vs. a
   dedicated admin reclaim) — anonymous identities have nothing to "restore", so is re-bootstrap enough?
2. `required → optional` downgrade: revoke secure tokens immediately, or let them lapse?
3. WS challenge: a simple sealed-nonce echo vs. binding the challenge into the session's derived key
   (belt-and-suspenders) — is the echo sufficient given the key already gates it?
