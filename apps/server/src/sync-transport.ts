/**
 * Server-side transport client for node-to-node sync (docs/08, docs/11). This is the *puller* half of
 * LOAM's QR-bootstrapped app-layer transport encryption: the browser client
 * (`apps/client/src/lib/transport.ts`) establishes an encrypted session with a host and sends sealed
 * requests; this module does the same thing from ONE Node node against a *peer* node when it pulls
 * public data. The peer's existing transport hooks need no change — they already decrypt any request
 * bearing `x-loam-enc` + a sealed `{ enc }` body and seal the response back the same way.
 *
 * Framing matches the peer's Fastify hooks exactly (verified against `apps/server/src/app.ts`):
 *   - the sealed request body is `{ enc: sealTransport(key, <sealed-plaintext>, aad) }`;
 *   - the inner plaintext of a BODIED request is the anti-replay envelope `{ s: <per-session seq>, b:
 *     <body> }` (docs/08): `s` is a per-session monotonic sequence (starts at 1, resets on
 *     re-handshake), authenticated inside the AEAD, and the peer's `preValidation` runs it through the
 *     `TRANSPORT_REPLAY_WINDOW` sliding window — a 409 rejects a replayed/out-of-window sequence. The
 *     peer sets `request.body = envelope.b` before schema validation. A missing `s` 409s, so the
 *     envelope is mandatory once #75's hardening merged (which it now has, on master);
 *   - a bodyless GET sends NO envelope — the peer skips replay enforcement for GET/HEAD (nothing to
 *     seal/replay) and only asks that the response be sealed;
 *   - `aad` is `${method} ${path}` (method is GET when there's no body, else POST), matching the
 *     peer's `${request.method} ${request.url}` (sync paths carry no query string, so path === url);
 *   - a sealed response is signalled by `x-loam-enc: 1` and unsealed with the same `aad`.
 *
 * Pure `@loam/crypto` (X25519 handshake + XChaCha20-Poly1305), no native deps.
 */

import { openTransport, sealTransport, transportClientDerive, transportClientHello } from "@loam/crypto";
import { TransportHandshakeResponseSchema, type TransportEncryption } from "@loam/schema";

/** A live app-layer transport session this node holds against ONE peer (the puller side of docs/08). */
export interface PeerTransportSession {
  /** The peer-issued session id, sent back in the `x-loam-enc` header on every sealed request. */
  sessionId: string;
  /** The derived XChaCha20-Poly1305 session key (base64url). */
  key: string;
  /** The peer's static X25519 public key the session was derived against (for pinning / diagnostics). */
  hostPublicKey: string;
  /** Per-session monotonic request sequence for the `{ s, b }` anti-replay envelope (docs/08). Starts at
   * 0; `attemptSealed` pre-increments so the first bodied request sends `s: 1`. Reset to 0 on a
   * re-handshake (a fresh session id starts a fresh replay window on the peer). */
  seq: number;
}

/** A peer's advertised transport posture, read from its unauthenticated `/api/config`. */
export interface PeerTransportPosture {
  mode: TransportEncryption;
  /** The peer's static X25519 public key (base64url), when it advertises one. Absent when `off`. */
  publicKey?: string;
}

/** Default hard cap on a peer response body (matches the sync digest/messages ceiling in `app.ts`). */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Default per-request timeout (matches `fetchPeerJson`'s 10s abort). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Trim trailing slashes from a peer base URL so `${base}${path}` never doubles up (mirrors `app.ts`). */
function normalizeBase(peerUrl: string): string {
  return peerUrl.replace(/\/+$/, "");
}

/** A single HTTP round-trip with a timeout + a streamed byte cap, returning the raw text + headers. */
async function httpText(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  maxBytes: number,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<{ status: number; ok: boolean; header(name: string): string | null; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onAbort);

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await readCappedText(response, maxBytes);
    return {
      status: response.status,
      ok: response.ok,
      header: (name) => response.headers.get(name),
      text,
    };
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", onAbort);
  }
}

/** Read a response body as UTF-8 text, aborting if it exceeds `maxBytes` (bounded while streaming). */
async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new Error("Peer response too large");
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/** Read a peer's transport posture from the raw `/api/config` JSON, defensively (no zod dep here). */
function readTransportPosture(config: unknown): PeerTransportPosture {
  const networkConfig =
    config && typeof config === "object" ? (config as { networkConfig?: unknown }).networkConfig : undefined;
  const nc = networkConfig && typeof networkConfig === "object" ? (networkConfig as Record<string, unknown>) : {};
  const mode = nc.transportEncryption;

  // A real LOAM peer always advertises the mode; anything else (older peer, garbage) → treat as off so
  // the caller keeps the existing plaintext path rather than trying to seal against a peer that can't.
  if (mode !== "off" && mode !== "optional" && mode !== "required") {
    return { mode: "off" };
  }

  const publicKey = typeof nc.transportPublicKey === "string" && nc.transportPublicKey.length > 0
    ? nc.transportPublicKey
    : undefined;
  return { mode, publicKey };
}

export interface PostureOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Fetch a peer's transport posture from its unauthenticated `/api/bootstrap` (the public, cookie-free
 * bootstrap — open even under `required` mode, where `/api/config` is now session-gated content behind
 * the tunnel since the docs/20 auth-binding change). It carries the same `networkConfig`, so it tells
 * the puller whether to handshake and which static key to derive against. The key is learned over plain
 * HTTP, so this is trust-on-first-use, not out-of-band: it defeats a passive eavesdropper but NOT an
 * active MITM between nodes unless the operator pins the key in the sync-peer config
 * (`SyncPeer.transportKey`). Throws on a non-2xx / unreachable peer.
 */
export async function fetchPeerTransportPosture(
  peerUrl: string,
  options: PostureOptions = {},
): Promise<PeerTransportPosture> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await httpText(
    fetchImpl,
    `${normalizeBase(peerUrl)}/api/bootstrap`,
    { method: "GET" },
    options.maxBytes ?? DEFAULT_MAX_BYTES,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );

  if (!response.ok) {
    throw new Error(`Peer /api/bootstrap answered ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("Peer /api/bootstrap returned invalid JSON");
  }
  return readTransportPosture(parsed);
}

export interface HandshakeOptions {
  /** A pinned expected peer static key (base64url). When set, a handshake whose returned
   * `hostPublicKey` differs fails closed — the only way to get active-MITM resistance between nodes. */
  expectedHostKey?: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Run the transport handshake against a peer and derive a session: generate an ephemeral X25519
 * keypair, POST the client hello to `/api/transport/handshake`, validate the reply, and derive the
 * shared session key. Mirrors the browser client's `handshake()`.
 *
 * The key is derived against the peer-returned `hostPublicKey`. When `expectedHostKey` is supplied
 * (an operator-pinned key), a mismatch throws BEFORE deriving — a substituted peer key can neither be
 * silently accepted nor produce a working session. Throws on any network/validation failure.
 */
export async function handshakeWithPeer(
  peerUrl: string,
  options: HandshakeOptions = {},
): Promise<PeerTransportSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const hello = transportClientHello();

  const response = await httpText(
    fetchImpl,
    `${normalizeBase(peerUrl)}/api/transport/handshake`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientEphemeralPublic: hello.ephemeralPublic }),
    },
    options.maxBytes ?? DEFAULT_MAX_BYTES,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );

  if (!response.ok) {
    throw new Error(`Transport handshake failed: ${response.status}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(response.text);
  } catch {
    throw new Error("Transport handshake returned invalid JSON");
  }

  const parsed = TransportHandshakeResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Transport handshake returned an invalid response");
  }

  // Pinned-key check: fail closed if the peer's advertised static key isn't the one the operator
  // pinned (defeats an active MITM that swapped in its own key over plain HTTP).
  if (options.expectedHostKey && parsed.data.hostPublicKey !== options.expectedHostKey) {
    throw new Error("Peer transport key does not match the pinned key");
  }

  const key = transportClientDerive({
    clientEphemeralSecret: hello.ephemeralSecret,
    hostPublic: parsed.data.hostPublicKey,
    hostEphemeralPublic: parsed.data.hostEphemeralPublic,
  });

  return { sessionId: parsed.data.sessionId, key, hostPublicKey: parsed.data.hostPublicKey, seq: 0 };
}

export interface SealedFetchOptions {
  /** JSON-serializable request body. Undefined → a bodyless GET; defined → a POST. */
  body?: unknown;
  /** Extra headers merged onto the sealed request (e.g. `x-loam-sync-token`). */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Re-establish the session after an apparent expiry (a 401, or a response we can't decrypt). Called
   * at most once per `sealedFetch`. When it resolves to a fresh session, that session's fields are
   * copied INTO the passed `session` object (so a cached reference updates in place) and the request is
   * retried. Safe for sync because every sync request is a read-only query.
   */
  reHandshake?: () => Promise<PeerTransportSession | undefined>;
}

/** The outcome of a sealed request: the peer's status + the already-unsealed response text. */
export interface SealedResponse {
  status: number;
  ok: boolean;
  /** The decoded (unsealed if the peer sealed it) response body, ready for `JSON.parse`. */
  text: string;
}

/**
 * Send ONE request to a peer through a live transport session, sealed end-to-end. Mirrors the browser
 * client's `attemptFetch` sealed path:
 *   - GET (no body) sends no envelope but still asks the peer to seal its response (`x-loam-enc: <sid>`);
 *   - anything with a body seals `{ enc: sealTransport(key, JSON.stringify(body), aad) }`;
 *   - a `x-loam-enc: 1` response is unsealed with the same `aad`.
 *
 * On a 401 (peer refused the session in `onRequest`, before any handler ran) or a response we can't
 * decrypt (the session key changed under us), it re-handshakes ONCE via `options.reHandshake` and
 * retries — always safe here, as sync only ever issues read-only queries. Throws if the retry still
 * can't decrypt, or on any network failure.
 */
export async function sealedFetch(
  session: PeerTransportSession,
  peerUrl: string,
  path: string,
  options: SealedFetchOptions = {},
): Promise<SealedResponse> {
  return attemptSealed(session, peerUrl, path, options, false);
}

async function attemptSealed(
  session: PeerTransportSession,
  peerUrl: string,
  path: string,
  options: SealedFetchOptions,
  retried: boolean,
): Promise<SealedResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const hasBody = options.body !== undefined;
  const method = hasBody ? "POST" : "GET";
  const aad = `${method} ${path}`;

  // GET with no body: no envelope, but signal we want a sealed response. Anything with a body is sealed
  // as the `{ s, b }` anti-replay envelope (docs/08) — `s` a per-session monotonic sequence the peer
  // checks against its replay window (a bare body would 409). The peer refuses a non-GET that lacks a
  // sealed body, so a bodied request is always sealed. `s` is computed per attempt, so the retry path
  // (after a re-handshake reset `seq` to 0) sends a fresh in-window sequence on the new session.
  const sealedBody = hasBody
    ? JSON.stringify({
        enc: sealTransport(session.key, JSON.stringify({ s: ++session.seq, b: options.body }), aad),
      })
    : undefined;

  const headers: Record<string, string> = {
    ...options.headers,
    "x-loam-enc": session.sessionId,
  };
  if (sealedBody !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await httpText(
    fetchImpl,
    `${normalizeBase(peerUrl)}${path}`,
    { method, headers, body: sealedBody },
    options.maxBytes ?? DEFAULT_MAX_BYTES,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );

  if (response.header("x-loam-enc") === "1") {
    let enc: unknown;
    try {
      const payload: unknown = JSON.parse(response.text);
      enc = payload && typeof payload === "object" ? (payload as { enc?: unknown }).enc : undefined;
    } catch {
      enc = undefined;
    }
    const opened = typeof enc === "string" ? openTransport(session.key, enc, aad) : null;

    if (opened === null) {
      // The peer's handler ran and sealed a reply we can't open (session key changed between request
      // and response). Retrying is safe — sync requests are read-only — so re-handshake once.
      if (!retried && (await refreshSession(session, options))) {
        return attemptSealed(session, peerUrl, path, options, true);
      }
      throw new Error("Transport session expired");
    }

    return { status: response.status, ok: response.ok, text: opened };
  }

  // A 401 means the peer refused the session in `onRequest`, before any handler ran (unknown/expired
  // session id) — nothing was applied, so retrying after a fresh handshake is safe.
  if (response.status === 401 && !retried && (await refreshSession(session, options))) {
    return attemptSealed(session, peerUrl, path, options, true);
  }

  return { status: response.status, ok: response.ok, text: response.text };
}

/** Run the caller's `reHandshake`, copying a fresh session's fields into `session` so a cached
 * reference updates in place. Returns whether a usable session was obtained. */
async function refreshSession(session: PeerTransportSession, options: SealedFetchOptions): Promise<boolean> {
  if (!options.reHandshake) {
    return false;
  }
  const next = await options.reHandshake();
  if (!next) {
    return false;
  }
  session.sessionId = next.sessionId;
  session.key = next.key;
  session.hostPublicKey = next.hostPublicKey;
  // Fresh session id → fresh replay window on the peer, so restart the sequence (next.seq is 0).
  session.seq = next.seq;
  return true;
}
