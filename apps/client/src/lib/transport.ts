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

/** The live transport session: a handshake-derived key, its server-side session id, and the host
 * public key it was derived against (for the fingerprint UI). */
interface Session {
  sessionId: string;
  key: string;
  hostPublicKey: string;
}

let session: Session | undefined;

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
    credentials: "include",
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

  session = { sessionId: parsed.data.sessionId, key, hostPublicKey };
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

/** Re-run the last `ensureSession` call's mode/host key after a session apparently expired
 * server-side. Best-effort: returns `false` on any failure so the caller's own error path takes over.
 * Mirrors `ensureSession`'s trust rule: `required` mode only ever re-handshakes against the QR-cached
 * key, never falling back to the config-advertised one. */
async function reHandshake(): Promise<boolean> {
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
    return true;
  } catch {
    return false;
  }
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

  const isSafe = SAFE_METHODS.has(method.toUpperCase());
  const aad = restAad(method, path);
  // A safe (GET/HEAD) call with no logical body keeps the pre-existing shape: no envelope at all.
  // Every other method is ALWAYS sealed, even with an empty payload — the server (docs/08) requires a
  // sealed `{ enc }` body from any mutation presented under a live session, so a bodyless mutation
  // still needs an (empty) envelope to prove it actually went through the session.
  const requestBody =
    isSafe && body === undefined
      ? undefined
      : JSON.stringify({
          enc: sealTransport(active.key, body === undefined ? "" : JSON.stringify(body), aad),
        });

  const response = await fetch(apiUrl(path), {
    method,
    credentials: "include",
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

/** Append the live session's `?enc=<sessionId>` to a WebSocket URL (docs/08), so the server knows to
 * seal inbound frames; unchanged when no session is active. */
export function wsUrl(base: string): string {
  return session ? `${base}${base.includes("?") ? "&" : "?"}enc=${encodeURIComponent(session.sessionId)}` : base;
}

/**
 * Decrypt one inbound WebSocket frame when a session is live (`aad` is the constant `"ws"` — WS
 * frames aren't route-scoped); otherwise passes the raw frame through unchanged. Returns `null` only
 * on an actual decrypt failure — never for an inert (no-session) pass-through.
 */
export function openWsFrame(raw: unknown): string | null {
  if (!session) {
    return typeof raw === "string" ? raw : String(raw);
  }

  return openTransport(session.key, String(raw), "ws");
}

/** Test-only: reset all module state between tests. Never called from app code. */
export function resetTransportStateForTests(): void {
  session = undefined;
  hostKeyMismatch = false;
  sessionQrVerified = false;
  lastParams = undefined;
}
