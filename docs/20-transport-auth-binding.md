# 20 — Binding identity to the transport session (fixing the plaintext-cookie flaw)

> **Status: APPROVED FOR IMPLEMENTATION (v3, simplified).** Incorporates two rounds of external design
> review; migration/legacy-admin-reclaim machinery **cut** (no users to migrate — clean break).
> Fixes the **Critical** finding: the `loam_session` **cookie** (the app's bearer credential) travels as
> a plaintext HTTP header **outside the AEAD channel**, so a LAN attacker steals it and impersonates the
> victim (up to admin). v3 settles the four pre-implementation blockers from the second review: a precise
> public bootstrap API, **secure binding modelled as session state (not global mode)**, a real
> admin-reclaim path, and a reflection-safe WS challenge. Also folds in the two image findings and the
> replay / response-binding / WS-sequencing follow-ups (review #3/#6).

## 1. The flaw (verified)

`getSessionUserId` authenticates from the `loam_session` cookie → `sessions.get(token)` → userId, and the
cookie is a plaintext header **outside** the sealed body/tunnel. The handshake is anonymous, so an
attacker mints their own session and tunnels requests carrying the victim's sniffed cookie; the tunnel
forwards it inward → runs the attacker **as the victim**. Opt-in / off by default, so no default
deployment is exposed — but `required`'s guarantee is broken until this lands.

## 2. Principle → **session state, not global mode** (review blocker #2)

The server **cannot** know how a client learned the host key (QR scan vs. config). "QR-verified" is a
*client* trust decision; the server's job is to represent the corresponding **session state**. So:

> A transport session carries `authMode: "anonymous" | "bound"`. A client that completes a **sealed
> secure resume** promotes its session to **`bound`** (with `userId` + `identityTokenHash`). **Every
> secure rule below keys off `authMode === "bound"`, regardless of the node's global optional/required
> setting.** The un-sniffable session **key** (proven per request by a valid sealed envelope) is the
> credential; the plaintext cookie is never a credential for a bound session.

- A **bound** session: never uses/forwards a cookie; reaches content **only through the tunnel**;
  requires WS key-confirmation. (True even on an `optional` node — an effectively-`required`, key-pinned
  client gets full protection.)
- Global mode governs whether binding is *mandatory*: **`required`** ⇒ an `anonymous` session may reach
  only bootstrap/handshake/resume (it must bind to touch content). **`optional`** ⇒ a session may bind
  (secure) **or** stay anonymous + cookie-auth (best-effort, unchanged). **`off`** ⇒ plaintext.

## 3. The credential model — a NEW, separate namespace (review blocker #1, the crux)

**Never reuse the `sessions` (cookie-token) map** — a sniffed cookie could otherwise be replayed inside
an attacker's own sealed `/resume` and restore the whole attack.

- **New DAL table `transport_identity_tokens`** (`tokenHash → { userId, createdAt }`), separate from
  legacy `sessions`. Tokens are freshly-generated **256-bit** secrets, stored **hashed** (never the
  bearer at rest). The bound session stores the current **`identityTokenHash`** so logout/rotation can
  revoke exactly this device's token without searching by bearer value.
- **Legacy cookie tokens are NEVER accepted at `/resume`.** Namespaces never mix.
- **The client** only ever creates/sends a secure token over a **QR-verified** session (a client-enforced
  property — the server can't verify key provenance, so the server enforces the *session-state* rules of
  §2 instead). Over an `optional` non-QR session the client must **not** transmit a secure token: that
  session may have handshaked against a MITM-substituted config key, which could then decrypt resume.
- **Clean break, no migration** (§6): there is no legacy state to preserve — a cookie is simply never a
  valid credential for a `bound` session, and any pre-existing `required`-mode identity is disposable.

## 4. Public bootstrap API (review blocker #1b)

`/api/config` is authenticated bootstrap and stays that way for optional/off — so it can't just be
"made public". Instead:

- **New `GET /api/bootstrap`** — **always public, cookie-free**, fetched with `credentials: "omit"`.
  Returns only public data: `mode`, host `transportPublicKey`, `nodeName`, `version`, connection details.
  The client hits this *first* (it doesn't yet know the mode).
- **`GET /api/config`** — unchanged for optional/off (authenticated bootstrap, returns `currentUser`).
  For a **bound** session it is reached **through the tunnel** like any content route; a bound client gets
  `currentUser` from resume + tunnelled config, never from a cookie.
- **Every fetch a bound/required-mode client makes uses `credentials: "omit"`** — not just bootstrap:
  same-origin `fetch` sends cookies by default, so `resume` and every tunnel POST set it explicitly.
- **Legacy cookies may still ride the initial document load + the WS upgrade** (JS can't suppress those).
  That is safe **only because a bound session / required mode treats them as entirely invalid
  credentials** (§2, §3).

## 5. Flows (a QR-verified / effectively-required client)

```
1. GET /api/bootstrap          (PUBLIC, credentials:"omit")                           [NEW]
   → mode, transportPublicKey, nodeName, version. No identity, no cookie, no currentUser.

2. POST /api/transport/handshake   (anonymous; credentials:"omit")
   → transport session, authMode:"anonymous". No user bound.

3. POST /api/session/resume    (DIRECT but SEALED — not tunnelled; credentials:"omit") [NEW]
   Direct so the outer TransportSession is reachable (no user yet); path is harmless
   bootstrap metadata; body sealed + normal sequence (proof of key + replay-protected).
   body (sealed): { token? }
     • no token          → mint user + 256-bit token; bind; store tokenHash
     • valid token       → resume that user; bind
     • nonempty invalid  → 401 AUTH ERROR (never silently mint)
     • already-bound     → never rebind to a different identity
   → session.authMode:"bound", userId, identityTokenHash set.
   resp (sealed): { currentUser, token }.  Idempotent: cache the result on the session so a
   fresh-sequence RETRY after a lost response returns the SAME user+token (no 2nd mint).
   Client stores `token` (IndexedDB, per origin); sets currentUser.

4. All content (incl. /api/config, images)  → SEALED via the tunnel; identity = session.userId.
   No cookie sent or forwarded.

5. WebSocket  GET /ws?enc=<sid>   → §7 key-confirmation before any presence/events.

6. Re-handshake (expiry/reconnect)  → handshake + resume BEFORE retrying; concurrent
   re-handshakes share ONE in-flight handshake+resume.
```

An `optional` non-QR client uses the old `/api/config` cookie bootstrap, stays `anonymous`, unchanged.

## 6. No migration — clean break for a pre-release app

LOAM has **no real users yet, so there is nothing to migrate.** We take a **clean breaking change** and
deliberately do **not** build migration / legacy-admin-reclaim machinery (that would be solving a
deployment problem we don't have):

- Introduce the new secure-token / session-binding model outright.
- **Never** accept a cookie token as a secure token (the namespaces just coexist: cookies for
  `anonymous`/optional sessions, secure tokens for `bound`).
- Any pre-existing `required`-mode identity is **disposable**; the **first user** under the new model
  receives normal **`firstUser` bootstrap administration** over the secure channel — no reclaim code.
- A development database predating this change may simply need resetting.

*(If LOAM ever gains real deployments to upgrade, a legacy-admin reclaim path — a one-time
locally-surfaced code accepted only inside a sealed post-resume request — can be designed then. It is
explicitly out of scope now.)*

## 7. WebSocket key-confirmation — reflection-safe (review blocker #4)

A visible session id is not proof of key. After `GET /ws?enc=<sid>` opens, run a challenge/response with
**direction-separated AAD + typed messages** (a same-AAD nonce echo is unsafe — a keyless attacker could
reflect the ciphertext unchanged):

```
server → client   AAD "loam.ws.challenge.v1"   { type:"challenge", connectionId, nonce }
client → server   AAD "loam.ws.proof.v1"        { type:"proof",     connectionId, nonce }
```

- `nonce`: fresh, random, **connection-bound**, **single-use**; short **auth timeout**; a **cap/rate
  limit on unauthenticated sockets**.
- Only after the proof verifies: bind `userId`, add to the authenticated socket set, broadcast presence,
  send events. Before that the socket gets nothing. No extra derived key is needed — direction-separated
  AAD + typed plaintext suffice.
- WS frames also get an **independent server→client sequence + replay window** (review #6): deltas
  *append* and config/presence *replace*, so replay is **not** idempotent (my v1 claim was wrong).
- **Application frames are bound to the connection** so a frame captured on socket A can't be replayed
  on a reconnected socket B under the same transport session: use AAD `loam.ws.frame.v1 ${connectionId}`
  with a **per-connection** sequence (the `connectionId` is the challenge's, fresh per socket). Acceptance
  test: a valid frame from connection A is rejected on connection B.

## 8. Token lifecycle (the revocations are real; migration is not)

- **Revoke a secure token** (delete its `tokenHash` row) **+ its bound sessions + its sockets** on:
  explicit **logout / device wipe** (revoke server-side **before** deleting IndexedDB — also closes
  docs/15 #4 for this credential), **ban/deny**, **kill switch**, or **explicit rotation**.
- **transport-session eviction/expiry:** the token survives (persisted); the next handshake+resume
  rebinds. Eviction drops only the session, not the identity.
- **switching origins:** tokens are namespaced per origin (client + server) — never cross-presented.
- **Mode changes** need no special handling (§6, clean break): a `bound` session keeps its secure rules;
  an `optional`/`off` node simply doesn't *require* binding. No legacy state to preserve or migrate.

## 9. Co-design with anti-replay + response binding (review #3/#6)

- **Resume consumes a normal client sequence** (sealed `{ s, b }` envelope + window).
- **Sealed responses (tunnel + resume) authenticate the request they answer:** the descriptor binds the
  request's **sequence `s`, method `m`, and the exact envelope path `p`** (compared **verbatim** — the
  client sent `p`, the server echoes the same bytes, so no separate canonicalisation is needed and both
  compare identical values). The client **verifies** them before using the response — especially before
  storing a returned identity **token**. Closes review #3 (constant-aad tunnel responses cross-fed).
- **Re-handshake resumes before retrying;** concurrent re-handshakes share one in-flight op.

## 10. Server changes (summary)

- `TransportSession`: `authMode`, `userId?`, `identityTokenHash?`, cached `resumeResult?`.
- `transport_identity_tokens` DAL table (`tokenHash → userId`, persisted); revocations per §8.
- `GET /api/bootstrap` (public, cookie-free); `/api/config` unchanged for optional/off, tunnel-only for
  bound sessions.
- `POST /api/session/resume` (direct, sealed): the mint/resume/reject/immutable/idempotent rules (§5),
  resolving the outer session from the request WeakMap; sets `authMode:"bound"`.
- Identity resolution: a **bound** session (internal tunnel dispatch + WS) → `session.userId` via a
  trusted `x-loam-user` set **only** by the tunnel handler, gated by the unforgeable `x-loam-internal`;
  the resolver requires **both** a valid internal token **and** a bound user, and **strips/ignores** any
  client-supplied `x-loam-user`/`x-loam-internal`. Cookie fallback only for `anonymous` sessions.
- Content routes (incl. images): reachable by a bound session **only through the tunnel** (§2); images
  therefore return sealed bytes, never clear.
- WS key-confirmation (§7) + server→client sequencing.

## 11. Client changes (summary)

- `GET /api/bootstrap` first (credentials:"omit"); handshake; then sealed `/resume` (credentials:"omit")
  with the stored token → store returned token, set currentUser — **before** opening the WS / content.
- **Every** required-mode/bound fetch uses `credentials:"omit"`.
- WS: answer the sealed challenge before trusting the socket.
- Image loading **fails closed** (no `src`/placeholder) on a tunnel error — never the raw URL (review #5).
- Response verification: check the bound `s/m/p` before using/storing a sealed response.

## 12. Security analysis

Identity **token**: only ever sealed, separate namespace, hashed at rest → not sniffable, a leaked cookie
is not a token. Session **key**: never transmitted → can't seal as the victim. `session → userId` binding
is server-side + **immutable**. A sniffed session **id** is inert (can't seal, can't reach content, can't
pass the WS challenge). Bootstrap is cookie-free. **Residuals:** device compromise exposes the local
token (network is the threat model; covered by at-rest enc + wipe/kill switch); metadata (session id,
timing, sizes, bootstrap) observable; `anonymous`/optional sessions keep the weaker cookie model.

## 13. Compatibility & a factual correction

- **Correction:** cookie `sessions` **already persist in SQLite** (`store.loadSessions()` on boot,
  persisted on mint) — so a host restart does **not** currently invalidate cookie identities. The new
  `transport_identity_tokens` table also persists (parity), with §8 revocations.
- `anonymous`/optional/off behaviour is byte-unchanged.
- Affects the **shipped #70** foundation, not only #75; docs/08 to be corrected.

## 14. Tests (acceptance)

- **Impersonation defeated:** a captured cookie **and** session id, without the key, can't read/mutate,
  can't resume, can't pass the WS challenge (bound session).
- **Legacy-token separation:** a legacy cookie token at `/resume` → rejected.
- **Resume semantics:** mint / resume / invalid→401 / no-rebind / idempotent-retry.
- **Direct content refused:** any content route via a direct session id (bound-or-required) → 401; only
  the tunnel reaches it; images sealed.
- **Cookie-free client:** required-mode fetches actually send `credentials:"omit"` (assert the *client*,
  not merely that the server ignores cookies); `/api/bootstrap` is public + cookie-free.
- **Session-state binding:** a `bound` session on an **optional** node still enforces all secure rules.
- **WS challenge:** reflection of the challenge ciphertext is rejected; no presence/events pre-verify;
  unauthenticated sockets are capped + time out.
- **Response binding:** a response bound to a different `s/m/p` is rejected client-side.
- **WS connection binding:** a valid WS application frame captured on connection A is rejected on
  connection B (reconnect under the same transport session).
- **First-user admin:** on a fresh node the first user to bind via the secure channel becomes admin
  (normal `firstUser` bootstrap) — no reclaim code involved.
- **Lifecycle:** logout / wipe / ban / kill-switch revoke the token + its bound sessions + sockets.
- **optional/off unchanged:** existing cookie-auth tests pass.

---

*All blockers from both review rounds are now folded in. Pending a final reviewer confirmation that v3
closes it, this is the implementation spec.*
