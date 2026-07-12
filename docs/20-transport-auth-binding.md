# 20 — Binding identity to the transport session (fixing the plaintext-cookie flaw)

> **Status: DESIGN (not built) — for review.** Addresses the **Critical** finding from the external
> review of the transport encryption (docs/08, PRs #70/#75): in `required` mode the `loam_session`
> **cookie** — the app's sole bearer credential — travels as a **plaintext HTTP header, outside the
> AEAD-encrypted channel**, so a LAN attacker can steal it and impersonate the victim (up to admin).
> This doc proposes the fix and folds in the two related image findings (High + Medium). Please review
> the *design* before any code is written. This changes an auth model that ships in #70, so get it right.

## 1. The flaw (verified)

- `getSessionUserId` (`app.ts`) authenticates purely from the `loam_session` cookie → `sessions.get(token)` → userId. **The cookie is the credential.**
- Transport encryption seals the request/response **body** (and, via the tunnel, the path). It does **not** seal HTTP **headers** — and a cookie is a header. So the cookie is on the wire in cleartext on every request (`Cookie:`), when minted (`Set-Cookie:`), and on the WS upgrade.
- The handshake is **unauthenticated** (anonymous client — by design, for MITM resistance rooted in the QR). So an attacker mints *their own* valid transport session, then sends sealed-under-their-key tunnel requests carrying the **victim's sniffed cookie**; the tunnel forwards that cookie inward (`app.ts` tunnel handler) → the server runs the attacker **as the victim**.

Net: bodies are private, but the *credential that unlocks them* is stealable. `required` mode's stated guarantee (a LAN attacker can't reach your data) is broken. It is **opt-in and off by default**, so no default deployment is exposed — but the docs oversold it.

## 2. Principle

> In `required` mode, the credential that proves identity must travel **inside** the AEAD-sealed
> channel, and identity must be **bound to the transport session** — whose key is derived via ECDH and
> **never appears on the wire**. The plaintext cookie must not be used for outer HTTP or WebSocket
> traffic in `required` mode.

The transport **session key** becomes the effective per-connection credential (unstealable — never transmitted). A small persistent **identity token** ties a user across sessions, and is only ever transmitted *sealed*.

## 3. The credential model

Reuse the existing `sessions` map concept (`token → userId`) — but in `required` mode change **how the token is delivered and carried**:

- **Today (all modes):** token = cookie. `Set-Cookie` (plaintext) + `Cookie:` header (plaintext).
- **New (`required` mode):** token = an **identity token** exchanged **once per transport session, sealed**; the server **binds `session.userId`**; thereafter the *session itself* authenticates requests (no per-request token, no cookie).

The identity token persists the user across re-handshakes; it is stored client-side (IndexedDB, like the current cached data) and only ever sent inside a sealed body.

## 4. Flows (`required` mode)

```
1. GET /api/config                      (plaintext bootstrap; PUBLIC)
   → node name, mode=required, transportPublicKey.
   → mints NO identity, sets NO cookie, returns NO currentUser.   [CHANGE]

2. POST /api/transport/handshake        (plaintext bootstrap; anonymous)
   → transport session (sessionId + derived key). No user bound yet.

3. POST /api/session/resume             (SEALED, via the tunnel)   [NEW]
   body (sealed): { token? }            // client's stored identity token, if any
   → if token valid  : bind session.userId = sessions.get(token)
     else            : mint new user + new token; sessions.set(token,uid); bind
   resp (sealed): { currentUser, token }
   → client stores `token` in IndexedDB; sets currentUser.

4. All subsequent requests              (SEALED, via the tunnel)
   → authenticated by x-loam-enc → session → session.userId.       [CHANGE]
   → NO cookie sent; tunnel does NOT forward a cookie.             [CHANGE]

5. WebSocket  GET /ws?enc=<sid>
   → authenticated by the session's bound userId, not the cookie.  [CHANGE]

6. Re-handshake (12h expiry / reconnect)
   → repeat 2–3, re-presenting the stored token → SAME user rebound to the new session.
```

`optional`/`off` mode: **unchanged** (cookie bootstrap + auth) — see §7.

## 5. Server changes

- **`transportSessions` entry** gains `userId?: string` (undefined until bound in step 3).
- **`POST /api/session/resume`** (new, sealed, requires a live transport session): exchanges the token, binds `session.userId`, returns `{ currentUser, token }`. Operates on the session directly (it *establishes* identity, so it doesn't go through `getSessionUserId`). The per-IP identity-mint budget still applies to the mint path.
- **Identity resolution** (`getSessionUserId` and callers): for a request that arrived over a transport session — the **internal tunnel dispatch** and the **WS** — resolve identity from `session.userId`, **not** the cookie. Concretely, the tunnel handler sets a trusted `x-loam-user: <uid>` on the inner `inject`, gated by the unforgeable `x-loam-internal` token; `getSessionUserId` trusts `x-loam-user` **only** when `isInternalTunnelRequest` is true, else falls back to the cookie (optional/off).
- **Tunnel handler**: in `required` mode, do **not** forward the outer `Cookie` header inward; instead pass `x-loam-user` from `session.userId`. (An unbound session that hasn't resumed yet → the only route it may reach is `/api/session/resume`; everything else 401s until bound.)
- **`GET /api/config`**: in `required` mode, mint no identity, set no cookie, omit `currentUser` (it now comes from resume). Bootstrap stays public.
- **Image routes** (`/api/avatars`, `/api/attachments`) — folds in the High/Med findings: in `required` mode reachable **only via the authenticated internal tunnel dispatch** (a direct GET, even with a live `x-loam-enc`, 401s). The tunnel seals the (binary) response as base64 in its descriptor, so no clear image bytes ever leave. (Alternative considered: seal binary in `onSend` — rejected because a direct GET would still expose the *path* and the fact of access; internal-tunnel-only is stronger.)
- **WS**: authenticate the connection from the `?enc=<sid>` → session → `userId`.

## 6. Client changes

- Store the **identity token** in IndexedDB (namespaced per node origin, like the host key).
- After the handshake, `POST /api/session/resume` (sealed) with the stored token → store the returned token, set `currentUser`. Do this before opening the WS / fetching content.
- In `required` mode, never rely on the cookie; the session carries identity.
- **Image loading fails closed** in `required` mode: on a tunnel error / non-2xx, render no `src` / a local placeholder — **never** fall back to the raw `apiUrl(path)` (which would leak the path + allow MITM injection). (Med finding #5.)

## 7. Scope: `required` mode only

`optional`/`off` keep cookie-auth. Rationale: they explicitly do **not** promise active-LAN-attacker resistance (`optional` is best-effort; `off` is plaintext), and they allow un-sessioned plaintext requests where a cookie is the only available credential. The secure binding is what makes `required` actually deliver its promise. **Open for review:** is that acceptable, or should `optional` also bind when a session happens to be live? (Leaning: keep it simple, `required`-only, and document `optional`'s weaker guarantee.)

## 8. Security analysis

- The identity **token** is only ever transmitted **sealed** → a LAN attacker never sees it.
- The transport **session key** is never transmitted → not stealable; an attacker cannot seal requests as the victim.
- The `session → userId` binding is **server-side** → an attacker's own session is bound to *their* (different) identity; they cannot rebind the victim's session.
- A sniffed `x-loam-enc` session **id** is useless without the session **key** (can't seal) and cannot be rebound.
- Bootstrap (`/api/config`, handshake) is plaintext but now carries **no credential** (no mint, anonymous handshake) → nothing to steal there.

**Residuals (honest):**
- **Device compromise** (not network): the stored identity token lives client-side; a seized/compromised *device* exposes it — the same posture as any local credential, addressed by at-rest encryption + kill switch + ephemeral retention, not by this layer. Threat model here is the **network**, not device seizure.
- **Metadata**: the session id, request timing/sizes, and the bootstrap remain observable (documented in docs/08).
- **`optional`/`off`**: retain the stealable-cookie weakness by design (best-effort).

## 9. Compatibility & rollout

- Affects the **shipped #70** foundation, not only #75: `required` mode wasn't safe against an active LAN attacker until this lands. (Opt-in, off by default → no default deployment exposed; docs/08 to be corrected.)
- `optional`/`off` behavior is byte-unchanged.
- `sessions` is already in-memory (a server restart already invalidates all cookies/sessions), so the token model has the same restart semantics — no regression. **Open for review:** should `token → userId` persist (DB) so identities survive a host restart? (Today they don't, via the cookie either.)

## 10. Tests (acceptance)

- **Impersonation is defeated:** possession of a captured cookie **and** a captured `x-loam-enc` id, **without** the transport key, cannot read or mutate anything in `required` mode (401/empty).
- **Identity persists:** resume round-trips the same user across a re-handshake (new session, same token → same userId + history).
- **Images:** a direct `/api/avatars|attachments` GET in `required` mode 401s even with a live session; the same fetch via the tunnel returns sealed bytes; `encryptedImageUrl` returns no raw URL on failure.
- **Bootstrap:** `/api/config` in `required` mode mints no identity, sets no cookie, returns no `currentUser`.
- **optional/off unchanged:** existing cookie-auth tests still pass.

## 11. Open questions for the reviewer

1. `x-loam-user` internal-header (gated by the unforgeable internal token) vs. an alternative way to carry the session's user into the inner `inject` (e.g. an internal-only cookie set on the inject but never on the outer response). Which is cleaner/safer?
2. `required`-only scope (§7) — acceptable, or bind `optional` too?
3. Persist `token → userId` in the DB (survive restart), or keep in-memory parity with today's cookie? (Interacts with the kill switch, which should invalidate tokens.)
4. Is the single sealed `resume` exchange (§4.3) sufficient, or do you want the identity token bound into **every** sealed request (defence-in-depth vs. a hijacked but keyless session id — which we already argue is inert)?
5. Anything in this that the anti-replay / tunnel-response-binding follow-ups (review findings #3, #6) constrain or should be co-designed with?
