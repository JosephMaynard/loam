/**
 * QR-bootstrapped app-layer transport encryption (docs/08). LOAM serves plain HTTP on the LAN (no
 * secure context, so no WebCrypto/TLS); this module mirrors the server's app-layer AEAD session so
 * plain HTTP carries only ciphertext for message/DM/config content. Trust is rooted in the join QR,
 * which delivers the host's static X25519 public key out-of-band via the URL fragment `#k=<b64url>`
 * (never sent to the server) — an active-MITM-resistant channel a bare token can't provide.
 *
 * When `transportEncryption` is `off` (the default) every export here is a byte-for-byte
 * pass-through: same request/response shape as the pre-transport-encryption client. This module owns
 * the one live session (module-scoped — a tab talks to exactly one node) and is the single place
 * that knows the wire framing; callers never touch `sealTransport`/`openTransport` directly.
 */
import { openTransport, sealTransport, transportClientDerive, transportClientHello, transportFingerprint } from "@loam/crypto";
import { TransportHandshakeResponseSchema, type TransportEncryption } from "@loam/schema";

/** localStorage key for an operator-configured server origin override (Android host / advanced
 * self-hosters); empty/absent means same-origin requests. Shared with `app.tsx`. */
export const SERVER_URL_KEY = "loam.serverUrl";

/** Where the QR-delivered host public key is cached, namespaced per server origin so switching
 * nodes (a different `SERVER_URL_KEY`, or a different origin entirely) doesn't leak one node's key
 * into another's slot. */
const HOST_KEY_STORAGE_PREFIX = "loam.transportHostKey.";

/** Build an absolute request URL for a server-relative API path (e.g. `/api/messages`), honouring an
 * optional configured server origin override. The single place that knows how to reach the server —
 * used for both `fetch` calls and non-fetch resource URLs (`<img src>`, `<a href>`). */
export function apiUrl(path: string): string {
  return `${localStorage.getItem(SERVER_URL_KEY) ?? ""}${path}`;
}

/**
 * Thrown by `ensureSession` when transport encryption is `required` but no host public key is
 * available from either the QR (this load's `#k=` fragment or a previously cached one) or the
 * server's advertised config key. The caller should render a "scan the join QR" gate instead of the
 * main app — there is no safe way to talk to a `required` node without it.
 */
export class TransportNeedsQrError extends Error {
  constructor() {
    super("This node requires a scanned join QR to connect securely.");
    this.name = "TransportNeedsQrError";
  }
}

/** The live transport session: a handshake-derived key, its server-side session id, the host public
 * key it was derived against (for the fingerprint UI), and a monotonic per-session request counter.
 * `seq` is bumped for every sealed REST request and carried inside the authenticated envelope so the
 * server can reject replays within the session's lifetime (docs/08); it resets to 0 on every fresh
 * handshake because the server starts each session's replay window empty. */
interface Session {
  sessionId: string;
  key: string;
  hostPublicKey: string;
  seq: number;
  /** Whether this session has completed a sealed identity resume (docs/20) — its identity is the
   * session key, not a cookie, so every request omits credentials and reaches content via the tunnel. */
  bound: boolean;
  /** The current WS connection's id, learned from the server's key-confirmation challenge (docs/20 §7);
   * `undefined` before a challenge is answered on this connection. Reset per new socket by `wsUrl`. */
  wsConnectionId?: string;
  /** Highest accepted server→client WS frame sequence for the current connection (docs/20 §7 replay
   * window) — a frame at or below this is a replay and dropped. */
  wsServerSeq: number;
}

let session: Session | undefined;

/** Where the per-origin secure identity token (docs/20) is cached. Namespaced per server origin like the
 * host key, so switching nodes never cross-presents one node's token to another. It's a bearer secret at
 * rest (same trust level as the host-key cache); the network threat model is what this defends — device
 * compromise is covered by the encrypted-at-rest DB + wipe, not by hiding this from same-origin JS. */
const IDENTITY_TOKEN_STORAGE_PREFIX = "loam.identityToken.";

/** The stored secure identity token for the current origin, if any. */
function storedIdentityToken(): string | undefined {
  return localStorage.getItem(IDENTITY_TOKEN_STORAGE_PREFIX + keyStorageOrigin()) ?? undefined;
}

function storeIdentityToken(token: string): void {
  localStorage.setItem(IDENTITY_TOKEN_STORAGE_PREFIX + keyStorageOrigin(), token);
}

/** Drop the stored identity token (invalid/revoked token, or explicit logout/wipe). */
export function clearStoredIdentityToken(): void {
  localStorage.removeItem(IDENTITY_TOKEN_STORAGE_PREFIX + keyStorageOrigin());
}

/** Credentials mode for a fetch on the live session: a `bound`/required session NEVER sends the cookie
 * (docs/20 — the cookie is not its credential; the un-sniffable session key is), so it omits it. An
 * anonymous optional session keeps cookie auth. */
function sessionCredentials(): RequestCredentials {
  return lastParams?.mode === "required" ? "omit" : "include";
}

/**
 * Set when the QR-delivered key (this boot's `#k=` hash, or a previously cached one for this origin)
 * disagrees with the server's advertised `transportPublicKey` — e.g. a swapped join-QR poster.
 * Surfaced so Settings can warn the user; the QR key is still the one trusted for the handshake.
 */
let hostKeyMismatch = false;

/**
 * Whether the live session's host key came from the QR (this boot's `#k=` fragment, or a previously
 * cached key for this origin) rather than only from the server's advertised `transportPublicKey`.
 * The QR is out-of-band-authenticated (MITM-resistant); the config-advertised key is delivered over
 * the same plain-HTTP channel it's meant to protect, so trusting it alone gives no MITM resistance —
 * Settings uses this to distinguish "verified" from merely "encrypted" in the UI.
 */
let sessionQrVerified = false;

/** The mode/host-key an `ensureSession` call last used, so a decrypt-failure/401 retry can
 * transparently re-handshake without the caller re-supplying context. */
let lastParams: { mode: TransportEncryption; hostKey?: string } | undefined;

/** The server origin a cached host key is namespaced under — the configured override if set, else
 * this page's own origin. */
function keyStorageOrigin(): string {
  return localStorage.getItem(SERVER_URL_KEY) || window.location.origin;
}

/**
 * Read a `#k=<b64url>` fragment left by the join QR, cache it for this origin, and strip it from the
 * visible URL/history (the fragment is never sent to the server, but it's still a secret-shaped value
 * that shouldn't linger in the address bar or back-button history). Safe to call repeatedly — only
 * acts when the hash is actually present.
 */
function consumeHashKey(): string | undefined {
  const match = /^#k=([A-Za-z0-9_-]+)$/.exec(window.location.hash);

  if (!match) {
    return undefined;
  }

  const key = match[1];
  localStorage.setItem(HOST_KEY_STORAGE_PREFIX + keyStorageOrigin(), key);

  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(window.history.state, "", url.toString());

  return key;
}

/** The cached (or just-scanned-this-load) host public key for the current server origin, if any. */
export function getCachedHostPublicKey(): string | undefined {
  return localStorage.getItem(HOST_KEY_STORAGE_PREFIX + keyStorageOrigin()) ?? undefined;
}

/** Whether the QR-delivered key and the node's advertised config key disagree (see `hostKeyMismatch`). */
export function getHostKeyMismatch(): boolean {
  return hostKeyMismatch;
}

/**
 * Whether the live session's host key is QR-verified (see `sessionQrVerified`) — `false` when there is
 * no live session, or when the session was established using only the server-advertised config key.
 */
export function isSessionQrVerified(): boolean {
  return !!session && sessionQrVerified;
}

/** The live transport session, if any (`undefined` when transport encryption is `off`, or `optional`
 * with no host key available yet). */
export function getSession(): Session | undefined {
  return session;
}

/**
 * The join URL to encode in a QR: appends the host's transport public key as a `#k=<b64url>` fragment
 * (docs/08) so a scanner learns the key **out-of-band** — the physical QR, not the network — which is
 * what makes the handshake MITM-resistant at join. The fragment is never sent to the server; the
 * *displayed* URL text should stay the plain `joinUrl` (this is for the QR image only). Returns
 * `joinUrl` unchanged when transport encryption is off / no key is available.
 */
export function joinQrUrl(joinUrl: string, transportPublicKey?: string): string {
  return transportPublicKey ? `${joinUrl}#k=${transportPublicKey}` : joinUrl;
}

/** Emoji fingerprint of a host public key (docs/08) — defaults to the live session's host key. */
export function fingerprint(hostPublicKey?: string): string | undefined {
  const key = hostPublicKey ?? session?.hostPublicKey;
  return key ? transportFingerprint(key) : undefined;
}

/** Run the client↔host handshake against a known host public key and store the resulting session.
 * Throws on any network/validation failure — callers treat that like any other bootstrap failure. */
async function handshake(hostPublicKey: string): Promise<void> {
  const hello = transportClientHello();
  const response = await fetch(apiUrl("/api/transport/handshake"), {
    method: "POST",
    // The handshake is anonymous bootstrap; a bound/required client omits the cookie here too (docs/20).
    credentials: sessionCredentials(),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientEphemeralPublic: hello.ephemeralPublic }),
  });

  if (!response.ok) {
    throw new Error(`Transport handshake failed: ${response.status}`);
  }

  const parsed = TransportHandshakeResponseSchema.safeParse(await response.json().catch(() => undefined));

  if (!parsed.success) {
    throw new Error("Transport handshake returned an invalid response");
  }

  const key = transportClientDerive({
    clientEphemeralSecret: hello.ephemeralSecret,
    hostPublic: hostPublicKey,
    hostEphemeralPublic: parsed.data.hostEphemeralPublic,
  });

  session = { sessionId: parsed.data.sessionId, key, hostPublicKey, seq: 0, bound: false, wsServerSeq: 0 };
}

/**
 * Establish (or refresh) a transport session for the given mode. `off` clears any session and is
 * otherwise a no-op. In `required` mode ONLY the QR-delivered key (this boot's `#k=` fragment, else a
 * previously cached one for this origin) is ever trusted for the handshake — falling back to the
 * server-advertised `configHostKey` would let an active MITM simply hand out its own key over the same
 * plain-HTTP channel the QR is meant to protect, defeating the reason `required` mode exists. In
 * `optional` mode `configHostKey` stays a fallback (best-effort encryption without the MITM guarantee)
 * when no QR key is available. When both a QR key and a config key are present and disagree, the QR
 * key is what gets used either way (see `getHostKeyMismatch`) — the QR is the out-of-band-authenticated
 * channel, config is not. When `required` and no QR key is available, throws `TransportNeedsQrError`.
 */
export async function ensureSession(mode: TransportEncryption, configHostKey?: string): Promise<void> {
  const hashKey = consumeHashKey();
  const qrKey = hashKey ?? getCachedHostPublicKey();

  // A QR key pins this join to an encrypted, MITM-authenticated session. `/api/config` is
  // unauthenticated, so its `transportEncryption` value is attacker-mutable — a network MITM could
  // flip it to `off` to strip encryption while the user believes their scanned QR protected them.
  // Presence of a QR key (freshly scanned `#k=` or one cached from a prior verified join) overrides
  // the advertised mode: we treat the join as `required` and never fall back to plaintext once the
  // operator has handed out a key out-of-band. `lastParams` stores the *effective* mode so a later
  // `reHandshake` keeps the pin instead of degrading on reconnect.
  const effectiveMode: TransportEncryption = qrKey ? "required" : mode;
  lastParams = { mode: effectiveMode, hostKey: configHostKey };

  if (effectiveMode === "off") {
    session = undefined;
    hostKeyMismatch = false;
    sessionQrVerified = false;
    return;
  }

  hostKeyMismatch = !!qrKey && !!configHostKey && qrKey !== configHostKey;
  const hostPublicKey = effectiveMode === "required" ? qrKey : (qrKey ?? configHostKey);

  if (!hostPublicKey) {
    if (effectiveMode === "required") {
      throw new TransportNeedsQrError();
    }

    session = undefined;
    sessionQrVerified = false;
    return;
  }

  await handshake(hostPublicKey);
  sessionQrVerified = hostPublicKey === qrKey;
}

/** A single in-flight re-handshake, shared by all concurrent callers (docs/20 §5.6/§9). Without this, a
 * burst of parallel requests all 401ing on an expired session would each handshake AND resume, minting
 * several fresh identities and fragmenting the client. */
let reHandshakeInFlight: Promise<boolean> | undefined;

/** Re-run the last `ensureSession` call's mode/host key after a session apparently expired
 * server-side. Best-effort: returns `false` on any failure so the caller's own error path takes over.
 * Mirrors `ensureSession`'s trust rule: `required` mode only ever re-handshakes against the QR-cached
 * key, never falling back to the config-advertised one. Concurrent calls share ONE in-flight op. */
async function reHandshake(): Promise<boolean> {
  if (reHandshakeInFlight) {
    return reHandshakeInFlight;
  }
  reHandshakeInFlight = doReHandshake();
  try {
    return await reHandshakeInFlight;
  } finally {
    reHandshakeInFlight = undefined;
  }
}

async function doReHandshake(): Promise<boolean> {
  if (!lastParams || lastParams.mode === "off") {
    return false;
  }

  const cachedKey = getCachedHostPublicKey();
  const hostPublicKey = lastParams.mode === "required" ? cachedKey : (cachedKey ?? lastParams.hostKey);

  if (!hostPublicKey) {
    return false;
  }

  try {
    await handshake(hostPublicKey);
    sessionQrVerified = hostPublicKey === cachedKey;
    // A fresh transport session starts `anonymous` server-side; a bound/required client must re-bind
    // its identity before content or the WebSocket will work again (docs/20). Re-resume with the stored
    // token — silently (a lost identity just re-mints), so the caller's retry proceeds on a bound session.
    if (lastParams.mode === "required" && session) {
      try {
        await resumeAttempt(session, storedIdentityToken(), {}, false);
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Path + direction-separated AAD for the sealed identity resume (docs/20 §5). */
const RESUME_PATH = "/api/session/resume";
const RESUME_AAD = "POST /api/session/resume";

/**
 * Bind this transport session to a persistent secure identity (docs/20). Seals `{ token? }` to the
 * DIRECT `/api/session/resume` endpoint (credentials omitted — the cookie is never a bound credential),
 * verifies the sealed reply is bound to the exact request it answers (`s/m/p`, §9), stores the returned
 * 256-bit token per origin, and marks the session `bound`. With no stored token the server mints a fresh
 * identity; a stored-but-rejected token is cleared and a fresh identity minted once. Returns the
 * authenticated `currentUser`. Requires a live transport session (call after `ensureSession`).
 */
export async function resumeIdentity(init: EncryptedFetchInit = {}): Promise<{ currentUser: unknown }> {
  const active = session;
  if (!active) {
    throw new Error("Cannot resume an identity without a transport session");
  }
  return resumeAttempt(active, storedIdentityToken(), init, false);
}

async function resumeAttempt(
  active: Session,
  token: string | undefined,
  init: EncryptedFetchInit,
  retriedFreshMint: boolean,
): Promise<{ currentUser: unknown }> {
  const seq = ++active.seq;
  const envelope = JSON.stringify(token === undefined ? { s: seq, b: {} } : { s: seq, b: { token } });
  const response = await fetch(apiUrl(RESUME_PATH), {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json", "x-loam-enc": active.sessionId },
    signal: init.signal,
    body: JSON.stringify({ enc: sealTransport(active.key, envelope, RESUME_AAD) }),
  });

  const sealedReply = response.headers.get("x-loam-enc") === "1";

  // A SEALED 401 came from the resume handler AFTER decrypting our body → the token itself was rejected
  // (unknown/revoked). Clear it and mint a brand-new identity exactly once, rather than stranding the
  // client on a dead token. An UNSEALED 401 is `onRequest` refusing an expired transport session — let
  // that propagate so the caller re-handshakes.
  if (response.status === 401 && sealedReply) {
    if (token !== undefined && !retriedFreshMint) {
      clearStoredIdentityToken();
      return resumeAttempt(active, undefined, init, true);
    }
    throw new Error("Identity resume rejected");
  }

  if (!sealedReply) {
    throw new Error(`Identity resume failed: ${response.status}`);
  }

  const payload: unknown = await response.json().catch(() => undefined);
  const enc = payload && typeof payload === "object" ? (payload as { enc?: unknown }).enc : undefined;
  const opened = typeof enc === "string" ? openTransport(active.key, enc, RESUME_AAD) : null;
  if (opened === null) {
    throw new Error("Identity resume response could not be decrypted");
  }

  let result: { s?: unknown; m?: unknown; p?: unknown; currentUser?: unknown; token?: unknown };
  try {
    result = JSON.parse(opened) as typeof result;
  } catch {
    throw new Error("Malformed identity resume response");
  }

  // Response binding (docs/20 §9): the resume reply carries the secret token and is sealed under a
  // CONSTANT aad, so confirm it answers the exact { s, m, p } we sent before trusting/storing the token —
  // an attacker can't cross-feed a different sealed resume reply.
  if (result.s !== seq || result.m !== "POST" || result.p !== RESUME_PATH) {
    throw new Error("Identity resume response did not match the request");
  }

  if (typeof result.token === "string") {
    storeIdentityToken(result.token);
  }
  active.bound = true;
  return { currentUser: result.currentUser };
}

/** Re-establish the transport session (handshake + re-bind if required) for the WS reconnect path, where
 * an expired session id would otherwise loop. Best-effort — returns `false` on any failure. */
export async function reestablishSession(): Promise<boolean> {
  return reHandshake();
}

/** The `aad` bound into a REST frame: exactly `${METHOD} ${path}` — `path` is the same path+query
 * string handed to `fetch`, matching `${request.method} ${request.url}` server-side. */
function restAad(method: string, path: string): string {
  return `${method} ${path}`;
}

export interface EncryptedFetchInit {
  signal?: AbortSignal;
}

/** Methods that never mutate server state — safe to retry after ANY kind of failure, including one
 * where the server may already have processed the request (see `attemptFetch`'s decrypt-failure
 * branch). */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Re-handshake once the per-session request sequence gets within this of the safe-integer ceiling, so
 * the counter never loses precision (docs/20 #8). Vast headroom — this is never hit in a real session. */
const SEQ_REHANDSHAKE_THRESHOLD = Number.MAX_SAFE_INTEGER - 1024;

/**
 * The single REST entry point every call site uses instead of a bare `fetch(apiUrl(path), …)`. With
 * no live session (mode `off`, or `optional` with no key yet) this is a byte-for-byte pass-through —
 * same method/credentials/headers/body shape as the pre-transport-encryption client. With a live
 * session: the body is sealed as `{ enc }` (even an empty payload, for any non-GET/HEAD method — see
 * below), the `x-loam-enc: <sessionId>` header asks the server to seal the response too, and the
 * response is transparently unsealed back into a normal `Response` the caller can `.json()` / check
 * `.ok` on exactly as before. A 401 or a decrypt failure (the session likely expired) triggers exactly
 * one re-handshake + retry before giving up — but see `attemptFetch` for why a decrypt failure only
 * retries for safe methods.
 *
 * @param method - HTTP method, exactly as it will appear on the wire (e.g. `"POST"`).
 * @param path - The server-relative path + query string (e.g. `/api/messages`, `/api/search?q=x`).
 * @param body - Optional JSON-serializable request body.
 * @param init - Optional `AbortSignal` to wire into the underlying `fetch`.
 */
export async function encryptedFetch(
  method: string,
  path: string,
  body?: unknown,
  init: EncryptedFetchInit = {},
): Promise<Response> {
  return attemptFetch(method, path, body, init, false);
}

async function attemptFetch(
  method: string,
  path: string,
  body: unknown,
  init: EncryptedFetchInit,
  retried: boolean,
): Promise<Response> {
  const active = session;

  if (!active) {
    return fetch(apiUrl(path), {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      signal: init.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // Re-handshake (resetting the per-session sequence to 0) well before the counter could approach the
  // safe-integer ceiling, past which it would lose precision/monotonicity (docs/20 #8). Unreachable in
  // practice — a 12h session cannot issue 2^53 requests — but correct, and near-free to check.
  if (active.seq >= SEQ_REHANDSHAKE_THRESHOLD && !retried && (await reHandshake())) {
    return attemptFetch(method, path, body, init, true);
  }

  // `required` mode (the hardened profile, always the case for a QR-pinned join) routes every request
  // through the opaque tunnel so the real path + query — e.g. a search term, or which channel is being
  // read — never appear on the wire. `optional` keeps the lighter per-route body sealing below.
  if (lastParams?.mode === "required") {
    return tunnelFetch(active, method, path, body, init, retried);
  }

  const isSafe = SAFE_METHODS.has(method.toUpperCase());
  const aad = restAad(method, path);
  // A safe (GET/HEAD) call with no logical body keeps the pre-existing shape: no envelope at all.
  // Every other method is ALWAYS sealed, even with an empty payload — the server (docs/08) requires a
  // sealed `{ enc }` body from any mutation presented under a live session, so a bodyless mutation
  // still needs an (empty) envelope to prove it actually went through the session.
  //
  // The sealed plaintext is a `{ s, b? }` envelope: `s` is this session's next monotonic sequence
  // number (for the server's replay window) and `b` the actual body (omitted when there is none).
  // `++active.seq` is atomic under JS's single thread, so concurrent in-flight requests each get a
  // distinct, ever-increasing number.
  const requestBody =
    isSafe && body === undefined
      ? undefined
      : JSON.stringify({
          enc: sealTransport(
            active.key,
            JSON.stringify(body === undefined ? { s: ++active.seq } : { s: ++active.seq, b: body }),
            aad,
          ),
        });

  const response = await fetch(apiUrl(path), {
    method,
    credentials: sessionCredentials(),
    headers: { "content-type": "application/json", "x-loam-enc": active.sessionId },
    signal: init.signal,
    body: requestBody,
  });

  if (response.headers.get("x-loam-enc") === "1") {
    const payload: unknown = await response.json().catch(() => undefined);
    const enc =
      payload && typeof payload === "object" ? (payload as { enc?: unknown }).enc : undefined;
    const opened = typeof enc === "string" ? openTransport(active.key, enc, aad) : null;

    if (opened === null) {
      // The server replied `x-loam-enc: 1` — i.e. its handler already ran and produced a response —
      // and we simply can't decrypt it (e.g. the session key changed between request and response).
      // Retrying is only safe here for methods that don't mutate state: retrying a POST/PATCH/DELETE
      // would re-apply a mutation the server already committed.
      if (isSafe && !retried && (await reHandshake())) {
        return attemptFetch(method, path, body, init, true);
      }

      throw new Error("Transport session expired");
    }

    return new Response(opened, { status: response.status, statusText: response.statusText });
  }

  // A 401 means the server refused the request in `onRequest`, BEFORE any route handler ran (no
  // session presented, or an unknown/expired one) — nothing was applied server-side, so retrying is
  // safe regardless of method.
  if (response.status === 401 && !retried && (await reHandshake())) {
    return attemptFetch(method, path, body, init, true);
  }

  return response;
}

/** The single opaque endpoint every `required`-mode request is tunnelled through (docs/08). */
const TUNNEL_PATH = "/api/transport/tunnel";

/** Decode standard base64 (the tunnel descriptor's `bodyB64`, from Node's `Buffer.toString("base64")`)
 * into a raw `ArrayBuffer`, so a tunnelled binary response (images) reconstructs losslessly while a
 * JSON one still `.json()`s. `atob` is available in an insecure context (unlike most of WebCrypto). */
function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

/**
 * Send a request through the metadata-hiding tunnel (docs/08 v2). The real `{ method, path, body }` is
 * sealed inside the `{ s, b }` anti-replay envelope and POSTed to the single opaque
 * `/api/transport/tunnel`, so the path/query (a search term, which channel is read) never hit the wire.
 * The sealed response is a `{ status, contentType, bodyB64 }` descriptor rebuilt into a normal
 * `Response`. Mirrors `attemptFetch`'s one-shot re-handshake retry (safe methods on a decrypt failure,
 * any method on a 401), delegating the retry back through `attemptFetch` so it re-tunnels under the
 * fresh session.
 */
async function tunnelFetch(
  active: Session,
  method: string,
  path: string,
  body: unknown,
  init: EncryptedFetchInit,
  retried: boolean,
): Promise<Response> {
  const aad = restAad("POST", TUNNEL_PATH);
  const inner = body === undefined ? { m: method, p: path } : { m: method, p: path, body };
  const seq = ++active.seq;
  const requestBody = JSON.stringify({
    enc: sealTransport(active.key, JSON.stringify({ s: seq, b: inner }), aad),
  });

  const response = await fetch(apiUrl(TUNNEL_PATH), {
    method: "POST",
    credentials: sessionCredentials(),
    headers: { "content-type": "application/json", "x-loam-enc": active.sessionId },
    signal: init.signal,
    body: requestBody,
  });

  const isSafe = SAFE_METHODS.has(method.toUpperCase());

  if (response.headers.get("x-loam-enc") === "1") {
    const payload: unknown = await response.json().catch(() => undefined);
    const enc = payload && typeof payload === "object" ? (payload as { enc?: unknown }).enc : undefined;
    const opened = typeof enc === "string" ? openTransport(active.key, enc, aad) : null;

    if (opened === null) {
      if (isSafe && !retried && (await reHandshake())) {
        return attemptFetch(method, path, body, init, true);
      }
      throw new Error("Transport session expired");
    }

    let descriptor: { s?: unknown; m?: unknown; p?: unknown; status?: unknown; contentType?: unknown; bodyB64?: unknown };
    try {
      descriptor = JSON.parse(opened) as typeof descriptor;
    } catch {
      throw new Error("Malformed tunnel response");
    }
    // The tunnel endpoint's own guards (bad target, missing session) reply with a sealed errorBody, NOT
    // a `{ status, contentType, bodyB64 }` descriptor. Surface that as a readable 400 Response rather
    // than crashing on `base64ToBytes(undefined)` — defence in depth (the client shouldn't trip those
    // guards, but a Response beats a throw).
    if (typeof descriptor.status !== "number" || typeof descriptor.bodyB64 !== "string") {
      return new Response(opened, { status: 400, headers: { "content-type": "application/json" } });
    }
    // Response binding (docs/20 §9): the tunnel seals EVERY response under the same constant aad, so a
    // valid descriptor alone doesn't prove it answers THIS request. Confirm it echoes the exact
    // { s, m, p } we sent before using the body — else an attacker could cross-feed one in-flight
    // tunnel response as another's. A mismatch is fatal (never a silent wrong render).
    if (descriptor.s !== seq || descriptor.m !== method || descriptor.p !== path) {
      throw new Error("Tunnel response did not match the request");
    }
    const contentType = typeof descriptor.contentType === "string" ? descriptor.contentType : "application/octet-stream";
    // Rebuild a normal Response from the raw bytes (an ArrayBuffer is a valid BodyInit), so the caller's
    // `.json()` / `.blob()` work exactly as on a direct response — text and binary (images) alike.
    return new Response(base64ToBytes(descriptor.bodyB64), {
      status: descriptor.status,
      headers: { "content-type": contentType },
    });
  }

  if (response.status === 401 && !retried && (await reHandshake())) {
    return attemptFetch(method, path, body, init, true);
  }

  return response;
}

/** Whether requests are currently being tunnelled (required mode with a live session). When true, the
 * server refuses a direct `<img>` GET for avatars/attachments, so images must be fetched through the
 * tunnel and rendered from a `blob:` URL — see `encryptedImageUrl`. */
export function isTunnelActive(): boolean {
  return !!session && lastParams?.mode === "required";
}

/** Bounded cache of tunnelled image object URLs (`path → blob: URL`), so an avatar that appears in
 * dozens of rows is fetched once. Evicting (or resetting) revokes the URL to release the blob. */
const imageObjectUrls = new Map<string, string>();
/** In-flight fetches by path, so N rows requesting the same avatar on first paint share ONE tunnel
 * fetch instead of racing N of them (each of which would create — and mostly leak — a blob URL). */
const imageUrlInFlight = new Map<string, Promise<string>>();
const IMAGE_URL_CACHE_MAX = 200;

/**
 * Resolve an image path to a render-ready `src`. With the tunnel active (required mode) the raw
 * endpoint refuses a direct `<img>` GET, so the bytes are fetched through the tunnel (coming back
 * sealed) and handed back as a cached `blob:` object URL. Otherwise returns the plain same-origin URL
 * unchanged. Concurrent callers for the same path share a single in-flight fetch.
 *
 * FAILS CLOSED (docs/20 §11): when the tunnel is active and the fetch fails, it returns an empty string
 * — NEVER the raw `apiUrl(path)`. Falling back to the raw URL would make the browser issue a direct,
 * UNENCRYPTED `<img>` GET on a `required` node (leaking which avatar/attachment is being viewed, and
 * relying on plaintext bytes), defeating the tunnel. A missing image beats a downgraded one.
 */
export async function encryptedImageUrl(path: string): Promise<string> {
  if (!isTunnelActive()) {
    return apiUrl(path);
  }
  const cached = imageObjectUrls.get(path);
  if (cached) {
    return cached;
  }
  const inFlight = imageUrlInFlight.get(path);
  if (inFlight) {
    return inFlight;
  }

  const pending = (async () => {
    try {
      const response = await encryptedFetch("GET", path);
      if (!response.ok) {
        return ""; // fail closed — no direct, unencrypted fallback GET
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      if (imageObjectUrls.size >= IMAGE_URL_CACHE_MAX) {
        const oldest = imageObjectUrls.keys().next().value;
        if (oldest !== undefined) {
          URL.revokeObjectURL(imageObjectUrls.get(oldest) as string);
          imageObjectUrls.delete(oldest);
        }
      }
      imageObjectUrls.set(path, objectUrl);
      return objectUrl;
    } catch {
      return ""; // fail closed
    } finally {
      imageUrlInFlight.delete(path);
    }
  })();

  imageUrlInFlight.set(path, pending);
  return pending;
}

/** Revoke every cached image object URL (on wipe / test reset) so blobs aren't leaked. */
export function clearImageObjectUrls(): void {
  for (const url of imageObjectUrls.values()) {
    URL.revokeObjectURL(url);
  }
  imageObjectUrls.clear();
  imageUrlInFlight.clear();
}

/** Append the live session's `?enc=<sessionId>` to a WebSocket URL (docs/08), so the server knows to
 * seal inbound frames; unchanged when no session is active. Also RESETS the per-connection
 * key-confirmation state (docs/20 §7): every new socket gets a fresh challenge with a fresh connection
 * id, so `handleWsFrame` must forget the previous connection's id + sequence. */
export function wsUrl(base: string): string {
  if (session) {
    session.wsConnectionId = undefined;
    session.wsServerSeq = 0;
  }
  return session ? `${base}${base.includes("?") ? "&" : "?"}enc=${encodeURIComponent(session.sessionId)}` : base;
}

/** Direction-separated AADs for the reflection-safe WS key-confirmation (docs/20 §7). */
const WS_CHALLENGE_AAD = "loam.ws.challenge.v1";
const WS_PROOF_AAD = "loam.ws.proof.v1";
function wsFrameAad(connectionId: string): string {
  return `loam.ws.frame.v1 ${connectionId}`;
}

/**
 * Handle one inbound WebSocket frame (docs/20 §7). Returns exactly one of:
 *  - `{ proof }`  — a sealed key-confirmation proof the caller must send straight back over the socket
 *                   (the reply to the server's challenge). Until this is sent the socket receives nothing.
 *  - `{ payload }`— a decoded application-frame payload (a `ClientEvent` JSON string) to process.
 *  - `{}`         — ignore (undecryptable, malformed, replayed/out-of-order, or a pre-confirmation frame).
 * With no live session (transport off) the raw frame passes straight through as `{ payload }`.
 */
export function handleWsFrame(raw: unknown): { proof?: string; payload?: string } {
  const active = session;
  if (!active) {
    return { payload: typeof raw === "string" ? raw : String(raw) };
  }
  const text = String(raw);

  // Not yet confirmed on this connection: the only thing we accept is the server's challenge, sealed
  // under the challenge aad. Anything else (including a reflected app frame) fails to open and is ignored.
  if (active.wsConnectionId === undefined) {
    const opened = openTransport(active.key, text, WS_CHALLENGE_AAD);
    if (opened === null) {
      return {};
    }
    let challenge: { type?: unknown; connectionId?: unknown; nonce?: unknown };
    try {
      challenge = JSON.parse(opened) as typeof challenge;
    } catch {
      return {};
    }
    if (challenge.type !== "challenge" || typeof challenge.connectionId !== "string" || typeof challenge.nonce !== "string") {
      return {};
    }
    active.wsConnectionId = challenge.connectionId;
    active.wsServerSeq = 0;
    // Answer under the SEPARATE proof aad — a keyless attacker can only reflect the challenge bytes,
    // which won't open under this aad server-side, so reflection can never confirm.
    const proof = sealTransport(
      active.key,
      JSON.stringify({ type: "proof", connectionId: challenge.connectionId, nonce: challenge.nonce }),
      WS_PROOF_AAD,
    );
    return { proof };
  }

  // Confirmed: an application frame is `{ q, f }` sealed under the connection-bound aad. Reject a frame
  // whose sequence doesn't advance (a replay, or one captured on another connection — different aad).
  const opened = openTransport(active.key, text, wsFrameAad(active.wsConnectionId));
  if (opened === null) {
    return {};
  }
  let envelope: { q?: unknown; f?: unknown };
  try {
    envelope = JSON.parse(opened) as typeof envelope;
  } catch {
    return {};
  }
  if (typeof envelope.q !== "number" || typeof envelope.f !== "string" || envelope.q <= active.wsServerSeq) {
    return {};
  }
  active.wsServerSeq = envelope.q;
  return { payload: envelope.f };
}

/** Path + AAD for the sealed logout / device-wipe revocation (docs/20 §8). */
const LOGOUT_PATH = "/api/session/logout";
const LOGOUT_AAD = "POST /api/session/logout";

/**
 * Revoke this device's secure identity SERVER-SIDE (docs/20 §8) before a local wipe/logout clears
 * storage — so the token can't be resumed afterwards even if a copy leaked. Sent as a DIRECT sealed
 * request (like resume; it operates on the outer bound session, so it must NOT be tunnelled). Best
 * effort: the local token is dropped regardless of the server's reply.
 */
export async function logoutSecureIdentity(init: EncryptedFetchInit = {}): Promise<void> {
  const active = session;
  try {
    if (active?.bound) {
      await fetch(apiUrl(LOGOUT_PATH), {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json", "x-loam-enc": active.sessionId },
        signal: init.signal,
        body: JSON.stringify({ enc: sealTransport(active.key, JSON.stringify({ s: ++active.seq, b: {} }), LOGOUT_AAD) }),
      });
    }
  } catch {
    // Best effort — a failed revoke still clears the local token below (the network is the threat model).
  } finally {
    clearStoredIdentityToken();
    if (active) {
      active.bound = false;
    }
  }
}

/** Test-only: reset all module state between tests. Never called from app code. */
export function resetTransportStateForTests(): void {
  session = undefined;
  hostKeyMismatch = false;
  sessionQrVerified = false;
  lastParams = undefined;
  reHandshakeInFlight = undefined;
  clearImageObjectUrls();
}
