// The transport-encryption session layer (docs/08, docs/20): the host identity, live sessions + replay
// windows, the internal tunnel token, the global request hooks, and the handshake/resume/logout/tunnel
// routes, registered over the shared AppContext.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { type TransportIdentity, createTransportIdentity, openTransport, sealTransport, transportServerAccept, verifyTransportKeypair } from "@loam/crypto";
import { TransportHandshakeRequestSchema } from "@loam/schema";
import type { AppContext } from "./app-context.js";
import { IdentityLimitError, errorBody } from "./errors.js";
import { hashIdentityToken, makeIdentityToken } from "./identity.js";
import { registerRateLimit } from "./rate-limit.js";
import { type FastifyRequest, LogController } from "fastify";

// Live transport sessions: sessionId → derived key + expiry + anti-replay window. In-memory only;
// cleared by the kill switch. Ephemeral handshakes mean a lost entry just forces a re-handshake.
// `maxSeq`/`seen` implement a DTLS-style sliding replay window (docs/08): every sealed REST request
// carries a per-session monotonically increasing sequence number inside its authenticated envelope,
// and a captured ciphertext replayed within the session's 12h life is rejected because its sequence
// was already spent. `seen` holds only the sequence numbers still inside the window (pruned as it
// advances), so it stays bounded regardless of how long the session lives.
export interface TransportSession {
  key: string;
  expiresAt: number;
  maxSeq: number;
  seen: Set<number>;
  // Identity binding (docs/20). A session starts `anonymous` (handshake is unauthenticated); a sealed
  // `/api/session/resume` promotes it to `bound` and records the user it authenticates + the hash of
  // the identity token that bound it. A `bound` session is what makes the secure rules apply (content
  // only via the tunnel, no cookie, WS key-confirmation) — independent of the node's global mode.
  // `resumeResult` caches the sealed resume payload so a fresh-sequence retry is idempotent; the resume
  // handler is the only place that binds a session and sets it in the same synchronous step, so it is
  // present exactly when `authMode` is "bound".
  authMode: "anonymous" | "bound";
  userId?: string;
  identityTokenHash?: string;
  resumeResult?: { s?: number; m: string; p: string; currentUser: unknown; token: string };
}

// Every live app's per-boot internal tunnel token (normally one per process; tests build many). The request
// LOGGER needs to recognise a tunnel re-dispatch before the app context exists — Fastify's logger options are
// fixed at construction — so the check is keyed on the token itself. A forged header can only ever suppress
// the forger's OWN request log line; it grants nothing (authorization still uses `isInternalTunnelRequest`).
const liveInternalTunnelTokens = new Set<string>();

/** Whether a request is an internal tunnel re-dispatch, for logging purposes (see above). */
function isInternalDispatchForLogging(request: { headers?: Record<string, unknown> }): boolean {
  const header = request.headers?.["x-loam-internal"];
  return typeof header === "string" && liveInternalTunnelTokens.has(header);
}

/**
 * The server's request-log controller: never log a tunnel re-dispatch. Its URL is the
 * real path + query the tunnel exists to hide (`/api/search?q=…`), and server logs outlive an Emergency
 * Reset. The OUTER `POST /api/transport/tunnel` is still logged, which is all the wire shows too.
 */
export function loamLogController(): LogController {
  return new LogController({ disableRequestLogging: (request) => isInternalDispatchForLogging(request) });
}

/**
 * The logged form of a request: Fastify's default `req` serializer minus the query string (search terms,
 * `?enc=` WebSocket session ids…) — and, for an internal tunnel re-dispatch (should one ever be logged, e.g.
 * a 5xx error line), no path at all.
 */
export function loggedRequest(request: {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number };
}): Record<string, unknown> {
  return {
    method: request.method,
    url: isInternalDispatchForLogging(request) ? "[tunnelled]" : (request.url ?? "").split("?", 1)[0],
    // A `Host` is logged only when it's one of the names every node serves (an IP literal, localhost, a
    // `.local` name); anything else (a configured join hostname, or the arbitrary name a misdirected
    // request carried) is a placeholder, so a refused hostname never reaches the log.
    host: hostNameAllowed(hostHeaderName(request.host), () => undefined) ? request.host : "[hostname]",
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/**
 * The name in a `Host` header (or a URL authority): lowercased, port stripped, IPv6 brackets removed, a
 * trailing dot dropped. Undefined for an empty or malformed value (a non-numeric port, an unclosed
 * bracket, a bare multi-colon value that isn't an IPv6 address).
 */
export function hostHeaderName(host: string | undefined): string | undefined {
  const value = host?.trim().toLowerCase() ?? "";
  if (!value) {
    return undefined;
  }
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) {
      return undefined;
    }
    const rest = value.slice(close + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) {
      return undefined;
    }
    return value.slice(1, close) || undefined;
  }
  // A bare IPv6 literal (no brackets, several colons) is tolerated; a `name:port` has exactly one colon.
  if (value.split(":").length > 2) {
    return isIP(value) ? value : undefined;
  }
  const [name = "", port] = value.split(":");
  if (port !== undefined && !/^\d{1,5}$/.test(port)) {
    return undefined;
  }
  return name.replace(/\.$/, "") || undefined;
}

/**
 * Whether a request's `Host` names this node (DNS rebinding): an IP literal (v4 or v6),
 * `localhost` or a `*.localhost` name, an mDNS `*.local` name (LAN-only by construction), or the node's
 * advertised join host. `joinHost` is consulted last and lazily: when no join host is pinned, resolving it
 * scans the network interfaces, and the result is then an IP literal the first rule already covers.
 */
export function hostNameAllowed(name: string | undefined, joinHost: () => string | undefined): boolean {
  if (!name) {
    return false;
  }
  if (isIP(name) || name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) {
    return true;
  }
  return name === hostHeaderName(joinHost());
}

/** The port a scheme uses when a URL or a `Host` header leaves it out. */
function defaultPortFor(protocol: "http" | "https"): number {
  return protocol === "https" ? 443 : 80;
}

/**
 * The explicit port in a `Host` header, or undefined when it names none. Only meaningful for a value
 * {@link hostHeaderName} accepts: `name:port` or `[v6]:port` carry one; a bare name or IPv6 literal does not.
 */
function hostHeaderPort(host: string): number | undefined {
  const value = host.trim();
  const portPart = value.startsWith("[")
    ? value.slice(value.indexOf("]") + 1)
    : value.split(":").length === 2
      ? value.slice(value.indexOf(":"))
      : "";
  return /^:\d{1,5}$/.test(portPart) ? Number(portPart.slice(1)) : undefined;
}

/**
 * Whether a WebSocket upgrade's `Origin` is a page this node serves, judged against the request's `Host`:
 * an `http:` or `https:` Origin whose host name is the `Host`'s and whose port is either the `Host`'s port
 * or the node's advertised client port (`clientPort`, the port in the join URL). A port left out is its
 * scheme's default: the Origin's from its own scheme, the `Host`'s from the protocol the request arrived on
 * (`protocol`, default `http`). The port counts because browsers share cookies across the ports of one host:
 * any other web app on the same machine (another port on a laptop running `loamnet`) could otherwise open
 * `/ws` with a member's cookie. A page on another host (a DNS-rebinding page, any cross-site page), any
 * other scheme, and an opaque `Origin: null` never match.
 */
export function originMatchesHost(
  origin: string,
  host: string | undefined,
  options: { clientPort?: number; protocol?: "http" | "https" } = {},
): boolean {
  if (host === undefined) {
    return false;
  }
  const hostName = hostHeaderName(host);
  if (!hostName) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || hostHeaderName(url.host) !== hostName) {
    return false;
  }
  const originPort = url.port ? Number(url.port) : defaultPortFor(url.protocol === "https:" ? "https" : "http");
  const hostPort = hostHeaderPort(host) ?? defaultPortFor(options.protocol ?? "http");
  return originPort === hostPort || originPort === options.clientPort;
}

/**
 * Scrub request URLs from a free-text log message. A few of Fastify's own lines interpolate the raw URL into
 * the message, bypassing both the `req` serializer and the LogController: the
 * double-send warnings name it — for a request re-dispatched inside the tunnel, that's the hidden inner path
 * — so their URL is dropped outright; any other URL-shaped token keeps its path but loses its query string.
 */
export function redactLogText(text: string): string {
  return text
    .replace(/(did you forget to "return reply" in (?:the )?")[^"]*(")/g, "$1[redacted]$2")
    .replace(/(\/[^\s"'?]*)\?[^\s"')]*/g, "$1");
}

/** {@link redactLogText} applied to one pino log-call argument: a message string, or an `{ err }` object. */
function redactLogArg(arg: unknown): unknown {
  if (typeof arg === "string") {
    return redactLogText(arg);
  }
  if (arg && typeof arg === "object" && (arg as { err?: unknown }).err instanceof Error) {
    const err = (arg as { err: Error & Record<string, unknown> }).err;
    const message = redactLogText(err.message);
    if (message === err.message) {
      return arg;
    }
    const clean = Object.assign(new Error(message), { name: err.name, code: err.code, statusCode: err.statusCode });
    clean.stack = err.stack === undefined ? undefined : redactLogText(err.stack);
    return { ...(arg as object), err: clean };
  }
  return arg;
}

/** The server's pino options: the level, the query-stripping `req` serializer, the message redaction hook,
 *  and an optional sink. */
export function loamLoggerOptions(level: string, stream?: { write(line: string): void }) {
  return {
    level,
    serializers: { req: loggedRequest },
    hooks: {
      logMethod(this: unknown, inputArgs: unknown[], method: (...args: unknown[]) => void) {
        method.apply(this, inputArgs.map(redactLogArg));
      },
    },
    ...(stream ? { stream } : {}),
  };
}

/** Build the transport session layer over the app context: identity, sessions, replay windows, request-auth helpers. */
export function createTransportServer(ctx: AppContext) {
  const transportSessions = new Map<string, TransportSession>();

  // Secure identity tokens (docs/20): tokenHash → userId, mirrored in memory from the DAL. SEPARATE from
  // the cookie `sessions` map — a cookie token is NEVER a valid identity token, and vice versa.
  const identityTokens = new Map<string, string>();

  const TRANSPORT_SESSION_TTL_MS = 12 * 3_600_000;

  // How far a sealed request's sequence number may lag `maxSeq` and still be accepted — i.e. how much
  // reordering/concurrency the replay window tolerates. Browsers open only a handful of concurrent
  // connections per origin, so real reordering is tiny; this is generous headroom. A sequence at or
  // below `maxSeq - WINDOW` is refused as too old (indistinguishable from a replay of an evicted entry).
  const TRANSPORT_REPLAY_WINDOW = 1_024;

  // Hard cap on live sessions: the handshake endpoint is deliberately unauthenticated (it's the
  // bootstrap step before any session exists), so without a real bound a flood of handshakes from many
  // IPs could grow this map without limit even though each IP is individually rate-limited.
  const TRANSPORT_SESSION_CAP = ctx.options.transportSessionCap ?? 5_000;

  // Per-request session key, resolved once in onRequest and reused to decrypt the body (preValidation)
  // and encrypt the response (onSend). WeakMap so it's GC'd with the request — no manual cleanup.
  const transportRequestKeys = new WeakMap<FastifyRequest, string>();

  // The resolved transport session for a request, so `preValidation` can run the anti-replay window
  // against the same session `onRequest` authenticated. WeakMap → GC'd with the request.
  const transportRequestSessions = new WeakMap<FastifyRequest, TransportSession>();

  // The sealed request's authenticated sequence number `s` (docs/20 §9), stashed in preValidation so the
  // tunnel + resume handlers can BIND it into their sealed response descriptor — the client verifies the
  // response answers the exact `{ s, m, p }` it sent, defeating a cross-fed response under the tunnel's
  // constant AAD. WeakMap → GC'd with the request.
  const transportRequestSeq = new WeakMap<FastifyRequest, number>();

  // The node sync token a sealed request carried INSIDE its `{ s, b, tok }` envelope (docs/08) — the
  // authenticated, confidential channel for the `sync.token` bearer credential (never a wire header for a
  // sealed peer). `syncPeerAuthorized` reads it from here for a sealed request, falling back to the header
  // only on the plaintext path. WeakMap → GC'd with the request.
  const transportRequestSyncToken = new WeakMap<FastifyRequest, string>();

  // Per-boot secret proving a request is an internal re-dispatch from the transport tunnel handler
  // (`POST /api/transport/tunnel`, docs/08), not a real client socket. 256 bits of randomness compared
  // in constant time — an external request can't forge it, so the transport-enforcement bypass it
  // unlocks for internal requests is safe. Never leaves the process; regenerated every boot.
  const internalTunnelToken = randomBytes(32).toString("base64url");
  liveInternalTunnelTokens.add(internalTunnelToken);
  ctx.server.addHook("onClose", async () => {
    liveInternalTunnelTokens.delete(internalTunnelToken);
  });

  /** Whether a request is an internal tunnel re-dispatch (carries the valid per-boot internal token).
   * Such requests skip transport enforcement (they run plaintext inside the process) and the global
   * rate limiter (they're already bounded by the outer tunnel request that spawned them). */
  function isInternalTunnelRequest(request: FastifyRequest): boolean {
    const header = request.headers["x-loam-internal"];
    if (typeof header !== "string" || header.length !== internalTunnelToken.length) {
      return false;
    }
    try {
      return timingSafeEqual(Buffer.from(header), Buffer.from(internalTunnelToken));
    } catch {
      return false;
    }
  }

  /** The bound identity carried by a genuine internal tunnel re-dispatch, or `undefined`. The tunnel
   * handler sets `x-loam-user` to the tunnelling **bound** session's userId; we trust it ONLY when the
   * request also carries the unforgeable internal token (external `x-loam-user` is stripped in
   * `onRequest`, but gating on the token here is the real guarantee — a client can't produce it). This
   * is how a `bound` session (docs/20 §2) authenticates content: the un-sniffable session key is the
   * credential, resolved server-side to `session.userId`, never a cookie. An anonymous optional-mode
   * tunnel carries no `x-loam-user`, so this returns `undefined` and the caller falls back to cookie. */
  function tunnelBoundUserId(request: FastifyRequest): string | undefined {
    if (!isInternalTunnelRequest(request)) {
      return undefined;
    }
    const bound = request.headers["x-loam-user"];
    return typeof bound === "string" && bound.length > 0 ? bound : undefined;
  }

  /**
   * Anti-replay check for a sealed REST request's per-session sequence number (docs/08). Accepts a
   * sequence exactly once, tolerating up to `TRANSPORT_REPLAY_WINDOW` of reordering/concurrency:
   * a higher-than-seen sequence advances the window (and prunes entries that fall out of it); a
   * sequence still inside the window is accepted only if unseen; anything at/below the window floor,
   * a duplicate, or a non-positive/non-integer value is rejected. Returns `true` iff the request may
   * proceed. Mutates `session.maxSeq`/`session.seen`.
   */
  function acceptTransportSeq(session: TransportSession, seq: number): boolean {
    // isSafeInteger, not isInteger: a value past 2^53 loses precision, so a key-holding client could
    // otherwise submit an enormous sequence and poison its own replay window. The
    // client re-handshakes long before its counter approaches this, resetting the window.
    if (!Number.isSafeInteger(seq) || seq < 1) {
      return false;
    }

    if (seq > session.maxSeq) {
      session.maxSeq = seq;
      session.seen.add(seq);
      const floor = seq - TRANSPORT_REPLAY_WINDOW;
      for (const previous of session.seen) {
        if (previous <= floor) {
          session.seen.delete(previous);
        }
      }
      return true;
    }

    if (seq <= session.maxSeq - TRANSPORT_REPLAY_WINDOW || session.seen.has(seq)) {
      return false;
    }

    session.seen.add(seq);
    return true;
  }

  /** A base64url string (the shape every `TransportIdentity` key field must have — the crypto layer's
   * decoder throws on anything else). */
  const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

  /** Guard a value parsed from storage against the `TransportIdentity` shape before trusting it as the
   * host's transport keypair: both fields must be present, non-empty, base64url strings. A record that
   * merely happens to be a JS object (e.g. `{}`, or one with a missing/blank/non-string field from a
   * truncated write) would otherwise flow straight into the crypto layer and either throw or silently
   * mint an unusable identity. */
  function isValidTransportIdentity(value: unknown): value is TransportIdentity {
    if (!value || typeof value !== "object") {
      return false;
    }
    const candidate = value as Partial<TransportIdentity>;
    // Both fields must be well-formed base64url AND form a consistent keypair — the public key is
    // exactly the one derived from the secret. A truncated/mismatched persisted record that
    // merely passes the charset check would otherwise slip through and only surface later inside the
    // crypto at handshake time; caught here it's regenerated. `verifyTransportKeypair` also enforces the
    // 32-byte secret length and re-derives the (32-byte) public, so no separate length check is needed.
    return (
      typeof candidate.publicKey === "string" &&
      typeof candidate.secretKey === "string" &&
      BASE64URL_RE.test(candidate.publicKey) &&
      BASE64URL_RE.test(candidate.secretKey) &&
      verifyTransportKeypair(candidate.publicKey, candidate.secretKey)
    );
  }

  /** Load the host's persisted transport keypair (docs/08), or mint + persist one on first boot.
   * Idempotent; the secret is stored in the config table (encrypted at rest when the DB is). */
  function ensureTransportIdentity(): TransportIdentity {
    if (ctx.transportIdentity) {
      return ctx.transportIdentity;
    }
    const stored = ctx.store.getConfigValue("transportIdentity");
    if (stored) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (isValidTransportIdentity(parsed)) {
          ctx.transportIdentity = parsed;
          return ctx.transportIdentity;
        }
        // Parsed fine but isn't a well-formed identity — treat exactly like a corrupt record below.
      } catch {
        // Corrupt record — fall through and regenerate.
      }
    }
    ctx.transportIdentity = createTransportIdentity();
    ctx.store.setConfigValue("transportIdentity", JSON.stringify(ctx.transportIdentity));
    return ctx.transportIdentity;
  }

  /** Rotate to a fresh transport keypair (kill switch) — the old join QR stops working and every live
   * transport session is invalidated, matching the "emergency reset" intent (docs/08). */
  function rotateTransportIdentity(): void {
    ctx.transportIdentity = createTransportIdentity();
    ctx.store.setConfigValue("transportIdentity", JSON.stringify(ctx.transportIdentity));
    transportSessions.clear();
  }

  /** The transport session key a request presented via a valid, unexpired `x-loam-enc` header (the
   * session id), or undefined. */
  function transportSessionForRequest(request: FastifyRequest): TransportSession | undefined {
    const sid = request.headers["x-loam-enc"];
    if (typeof sid !== "string" || sid.length === 0) {
      return undefined;
    }
    const session = transportSessions.get(sid);
    if (!session || session.expiresAt <= Date.now()) {
      return undefined;
    }
    return session;
  }

  /** The live transport session for a WebSocket connection, taken from the `?enc=<sid>` query (browsers
   * can't set custom headers on a WS upgrade), or undefined. The session carries the key AND its
   * `authMode`/`userId`, so the WS can bind identity to a `bound` session (docs/20) rather than a cookie. */
  function wsTransportSession(url: string): TransportSession | undefined {
    const query = url.split("?")[1];
    if (!query) {
      return undefined;
    }
    const sid = new URLSearchParams(query).get("enc");
    if (!sid) {
      return undefined;
    }
    const session = transportSessions.get(sid);
    if (!session || session.expiresAt <= Date.now()) {
      return undefined;
    }
    return session;
  }

  /** Whether this **external** request is a content route that, under `required` mode, is reachable
   * ONLY through the internal tunnel dispatch (docs/20) — so a direct hit is refused (401) and a
   * captured session id / cookie is inert. Matched on the RESOLVED route pattern (`routeOptions.url`),
   * NOT the raw request URL — Fastify percent-decodes the path before routing, so string-matching the
   * raw URL would let `/%61pi/users` (→ `/api/users`) slip past enforcement. The only DIRECTLY reachable
   * `/api/` routes in required mode are the public bootstrap, health, the handshake, the sealed resume,
   * the sealed logout, the DIRECT cookie-clear (`/api/session/end` — unauthenticated + side-effect-only,
   * it mints nothing and only clears the caller's own presented cookie, so a device wipe can revoke a
   * legacy cookie that a bound session's `credentials:"omit"` requests never send, docs/20), and the
   * tunnel endpoint itself; everything else — including `/api/config`, which now returns `currentUser`
   * only for a bound session over the tunnel — is content. (Internal tunnel dispatches never reach this —
   * they return at the top of `onRequest`; the static shell + `/ws` are handled separately.) */
  function requiresTransportSession(request: FastifyRequest): boolean {
    const routeUrl = request.routeOptions?.url;
    if (!routeUrl || !routeUrl.startsWith("/api/")) {
      return false;
    }
    return (
      routeUrl !== "/api/bootstrap" &&
      routeUrl !== "/api/health" &&
      routeUrl !== "/api/transport/handshake" &&
      routeUrl !== "/api/session/resume" &&
      routeUrl !== "/api/session/logout" &&
      routeUrl !== "/api/session/end" &&
      routeUrl !== "/api/transport/tunnel"
    );
  }

  /**
   * The node-to-node sync content routes. Under `required` mode (or a bound session) user-facing content
   * is tunnel-only (`/api/transport/tunnel`), but these two are reachable via a DIRECT sealed request
   * instead: sync is authenticated by the shared `sync.token` (docs/11) — a node credential, not a user
   * identity, so there is nothing to bind or carry over `x-loam-user`, and the tunnel would neither
   * forward the token nor admit an unbound session (docs/20 §2). They still MUST be sealed in `required`
   * mode (a plaintext hit with no resolved transport session falls through to the 401 in `onRequest`), so
   * inter-node sync is encrypted end-to-end; they are only exempt from the tunnel/bound requirement, not
   * from encryption. Both carry public data only (DMs/private channels/shadow-banned authors never
   * export). See `sync-transport.ts` (the puller half).
   */
  // `/api/sync/link` (sync-links.ts) is the same kind of node-to-node call, sent by the same client.
  const DIRECT_SEALED_SYNC_ROUTES = new Set([
    "/api/sync/digest",
    "/api/sync/messages",
    "/api/sync/attachment",
    "/api/sync/link",
  ]);

  /**
   * The opportunistic-mesh transport BRIDGE routes (docs/16 §5, docs/17). These are an in-process
   * plumbing seam between the Android launcher's courier brain and the relay — the launcher polls them
   * over `127.0.0.1` and never over the LAN, and every blob they carry is ALREADY end-to-end sealed at
   * the `@loam/crypto` mesh layer (the wire below them adds nothing). Under `required` mode a direct
   * `/api/` hit with no resolved transport session would otherwise 401 (`requiresTransportSession`), which
   * would silently wedge the courier the moment an operator turns transport encryption up. They are exempt
   * from the transport-session requirement ONLY for an authorized bridge caller (loopback AND the launcher's
   * per-boot host token — `meshBridgeCallerAuthorized`), so the exemption can never widen LAN exposure.
   */
  // `/api/host/clients` (the share screen's "N phones connected"), `/api/host/invite` (its invite code) and
  // `/api/host/link-code` (its "Link a node" code) ride the same launcher-only channel.
  const MESH_LOOPBACK_BRIDGE_ROUTES = new Set(["/api/mesh/outbound", "/api/mesh/inbound", "/api/host/clients", "/api/host/invite", "/api/host/link-code"]);

  /**
   * Per-route semantic rate-limit config that ALSO counts internal tunnel re-dispatches.
   * Route configs inherit the global registration's `allowList`, which exempts tunnel dispatches —
   * correct for the blanket limiter (see above), but on the expensive routes it would silently lift the
   * tighter caps for any client using the encrypted tunnel (e.g. ~200 MB/min of upload attempts
   * inside the 300/min tunnel budget). Overriding the allowList here counts every arrival path; the
   * tunnel forwards the real caller's address (`remoteAddress: request.ip`), so the per-IP key is
   * the true client either way. Note a per-route config REPLACES the global limiter for that route
   * (they don't stack) — the route's own cap is its whole budget; tunnelled calls additionally cost
   * one outer tunnel request each against the global cap. Conservative defaults, tunable per route.
   */
  function semanticRateLimit(max: number): { config: { rateLimit: { max: number; timeWindow: string; allowList: () => boolean } } } {
    return { config: { rateLimit: { max, timeWindow: "1 minute", allowList: () => false } } };
  }

  /**
   * Whether a peer request may be served: true when sync runs open (no shared token), or the request
   * presents the matching token (constant-time). A missing/wrong token is treated exactly like sync
   * being disabled — a 404 — so a prober can't distinguish "token-guarded" from "feature off".
   */
  /**
   * True when a request arrived over the loopback interface. The opportunistic-mesh transport bridge
   * endpoints (`/api/mesh/outbound` + `/api/mesh/inbound`, docs/17) are for the **in-process** Android
   * launcher only — it fetches them over 127.0.0.1 to shuttle sealed blobs between the native
   * BLE/Wi-Fi-Aware radio and the already-built relay. Restricting them to loopback keeps a joiner on
   * the hotspot LAN from draining this node's sealed queue or injecting into it directly (that path
   * stays the token-guarded `/api/sync/*`). `trustProxy` is off by design (see the join-URL protocol
   * note above), so `request.ip` is the real socket peer and can't be spoofed via `x-forwarded-for`.
   */
  function requestFromLoopback(request: FastifyRequest): boolean {
    const ip = request.ip;
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  }

  /**
   * Who may drive the mesh transport bridge: ONLY a loopback caller presenting the launcher's per-boot
   * `hostToken`. The Android launcher's courier (`nodejs-project-template/main.js`) is the bridge's one real
   * caller and always sends it as `x-loam-host-token`. Loopback alone is never enough: on Android every
   * installed app (and `adb forward`) reaches 127.0.0.1, and on a desktop/Pi a same-host reverse proxy
   * or the Vite dev proxy makes EVERY LAN client arrive from loopback. So a host with no `hostToken` (the
   * plain `server.ts` entry) has no bridge at all: the routes 404 exactly as if mesh were off. `loamnet`
   * mints a token but never hands it out, and neither desktop entry has a radio courier.
   */
  function meshBridgeCallerAuthorized(request: FastifyRequest): boolean {
    return requestFromLoopback(request) && !!ctx.options.hostToken && ctx.presentsHostToken(request);
  }

  /** Whether a sync request presents the configured `sync.token` (sealed in the envelope on an encrypted session, header on plaintext). */
  function syncPeerAuthorized(request: FastifyRequest): boolean {
    const required = ctx.appConfig.sync.token;
    if (!required) {
      return true;
    }

    // An ENCRYPTED request (one that resolved a transport key) must authenticate ONLY via the token sealed
    // inside its `{ s, b, tok }` envelope — never a plaintext `x-loam-sync-token` header. Accepting the
    // header on a sealed session would let a captured token authorize an attacker's own encrypted session
    // by simply attaching it as a header, defeating the whole point of sealing it. The header is honoured
    // only on the plaintext (`off`-mode) path, which has no sealed channel to carry the token (docs/08).
    const encrypted = transportRequestKeys.has(request);
    const header = request.headers["x-loam-sync-token"];
    const provided = encrypted
      ? transportRequestSyncToken.get(request)
      : Array.isArray(header)
        ? header[0]
        : header;
    if (typeof provided !== "string") {
      return false;
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(required);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  return {
    internalTunnelToken,
    ensureTransportIdentity,
    acceptTransportSeq,
    DIRECT_SEALED_SYNC_ROUTES,
    meshBridgeCallerAuthorized,
    TRANSPORT_SESSION_CAP,
    isValidTransportIdentity,
    MESH_LOOPBACK_BRIDGE_ROUTES,
    TRANSPORT_REPLAY_WINDOW,
    transportRequestSyncToken,
    TRANSPORT_SESSION_TTL_MS,
    transportSessions,
    identityTokens,
    transportRequestSessions,
    transportRequestSeq,
    syncPeerAuthorized,
    BASE64URL_RE,
    requiresTransportSession,
    rotateTransportIdentity,
    semanticRateLimit,
    wsTransportSession,
    isInternalTunnelRequest,
    tunnelBoundUserId,
    transportSessionForRequest,
    requestFromLoopback,
    transportRequestKeys,
  };
}

/** Add the global transport hooks (decrypt/encrypt/enforce, security headers) and the global rate limiter. */
export async function registerTransportHooks(ctx: AppContext): Promise<void> {
  // Direct sealed requests whose authenticated envelope asked for a sequence-bound response (`r: 1`, docs/08
  // "Response binding"): onSend seals their response under `${METHOD} ${url}#${s}` rather than the bare
  // route aad, so a captured response can't be replayed as the answer to a later request on the same route.
  // WeakSet → GC'd with the request.
  const responseBoundRequests = new WeakSet<FastifyRequest>();

  /**
   * Run a sealed `{ s, r? }` envelope through the session's replay window and record it on the request:
   * its sequence for the handlers and response binding, and whether it asked for a bound response.
   * False when the sequence is missing, replayed or out of the window.
   */
  function acceptEnvelopeSequence(request: FastifyRequest, envelope: { s?: unknown; r?: unknown }): boolean {
    const activeSession = ctx.transportRequestSessions.get(request);
    if (!activeSession || typeof envelope.s !== "number" || !ctx.acceptTransportSeq(activeSession, envelope.s)) {
      return false;
    }
    ctx.transportRequestSeq.set(request, envelope.s);
    if (envelope.r === 1) {
      responseBoundRequests.add(request);
    }
    return true;
  }

  // Security headers on every response. A strict CSP is defense-in-depth behind the already-hardened
  // markdown sanitizer: the client is fully self-contained (its own JS/CSS, images from this origin,
  // ws:// to this host), so it needs no external origins. `nosniff` stops content-type confusion on
  // the user-uploaded images. `frame-ancestors 'none'` blocks clickjacking. No HSTS — LOAM runs on
  // plain-http LANs by design (docs/08), so forcing https would break it.
  // ---- Transport encryption (docs/08): transparently decrypt requests / encrypt responses ----------
  // With a live transport session (from POST /api/transport/handshake), the client sends request
  // bodies as { enc: <sealed> } and gets responses back the same way, so plain HTTP carries only
  // ciphertext for message/DM/config CONTENT. In `optional` mode a direct request's path + query stay
  // visible on the wire (and images are served in clear); in `required` mode — or for any `bound`
  // session — content goes through the path-hiding tunnel (`/api/transport/tunnel`), images included,
  // so only "a tunnel request happened" + ciphertext size/timing remain. All inert when the mode is `off`.
  ctx.server.addHook("onRequest", async (request, reply) => {
    // The kill switch's 503 gate: while a wipe is in flight, after it has handed off to the launcher for
    // a restart, or after it failed closed, this process must not serve anything from its in-memory
    // mirrors or surviving sessions. Checked before EVERYTHING else, including the internal tunnel bypass — the only
    // route that stays reachable is the liveness probe, so the Android launcher's readiness poll still
    // works. See `executeKillSwitchBody`.
    if (ctx.awaitingWipeRestart && request.routeOptions?.url !== "/api/health") {
      return reply.code(503).send(errorBody("This node is restarting after a kill switch reset."));
    }
    // An internal tunnel re-dispatch runs plaintext inside the process — never enforce/decrypt it
    // (its response is sealed by the outer tunnel request instead). Checked before anything else so
    // it holds in every mode.
    if (ctx.isInternalTunnelRequest(request)) {
      return; // trusted internal re-dispatch — its x-loam-internal/x-loam-user headers are legitimate
    }
    // Host allowlist: a request addressed to a name this node doesn't serve is refused
    // before anything else happens (no identity is minted, no content is read). On an internet-connected LAN
    // (Wi-Fi mode, `loamnet` on a home network) a DNS-rebinding page could otherwise point its own hostname at
    // this node and read public channels as a fresh identity. Every real client arrives by IP literal,
    // `localhost` (the Android host's own WebView), an mDNS `.local` name, or the advertised join host. The
    // internal tunnel re-dispatch above inherits the outer request's already-checked Host.
    if (!hostNameAllowed(hostHeaderName(request.headers.host), () => ctx.currentJoinHost())) {
      return reply.code(421).send(errorBody("This address isn't served by this LOAM node"));
    }
    // This request is EXTERNAL: strip the trusted internal headers so a client can never forge identity
    // or the tunnel bypass (docs/20 — defence in depth; the resolver already gates x-loam-user on the
    // internal token, but these must never reach a handler on an external request).
    delete request.headers["x-loam-internal"];
    delete request.headers["x-loam-user"];

    const mode = ctx.effectiveTransportEncryption();
    if (mode === "off") {
      return;
    }
    const activeSession = ctx.transportSessionForRequest(request);
    const presentedSessionId = request.headers["x-loam-enc"];
    if (activeSession) {
      ctx.transportRequestKeys.set(request, activeSession.key);
      ctx.transportRequestSessions.set(request, activeSession);
    } else if (typeof presentedSessionId === "string" && presentedSessionId.length > 0) {
      // The client presented a transport session that is unknown/expired (server restart or 12h TTL).
      // Refuse with 401 in BOTH modes so its re-handshake path fires, rather than silently serving or
      // accepting plaintext — which in `optional` mode would downgrade the wire while the client's UI
      // still shows "encrypted" (docs/08).
      return reply.code(401).send(errorBody("Transport session expired"));
    }

    // Content is reachable ONLY through the internal tunnel dispatch (which returned above) — so a DIRECT
    // external hit on a content route is refused, making a captured credential inert (docs/20). This fires
    // when EITHER the node globally requires encryption OR the resolved session is `bound` — the secure
    // rules key off session state, not just global mode (docs/20 §2), so a bound session on an `optional`
    // node is still tunnel-only (never serving its content directly / by cookie). Bootstrap/health/
    // handshake/resume/logout/tunnel stay directly reachable.
    const boundSession = activeSession?.authMode === "bound";
    if ((mode === "required" || boundSession) && ctx.requiresTransportSession(request)) {
      // Node-to-node sync is reachable via a DIRECT sealed request rather than the identity tunnel: it is
      // sync-token-authed public data with no user identity to bind (docs/08/11/20 — see
      // `DIRECT_SEALED_SYNC_ROUTES`). It still must be sealed — a sync route reached WITHOUT a resolved
      // transport session has no `activeSession` here and falls through to the 401, so plaintext sync is
      // still refused in `required` mode.
      if (activeSession && ctx.DIRECT_SEALED_SYNC_ROUTES.has(request.routeOptions?.url ?? "")) {
        return;
      }
      // The in-process mesh bridge (docs/17) is loopback + host-token only and carries blobs already sealed
      // at the mesh crypto layer, so it isn't the LAN-content this gate protects — let the launcher's courier
      // keep polling it when the operator turns transport encryption up. Gated on the SAME check the handlers
      // apply (loopback AND the launcher's per-boot token), so nobody else reaches it unsealed.
      if (ctx.MESH_LOOPBACK_BRIDGE_ROUTES.has(request.routeOptions?.url ?? "") && ctx.meshBridgeCallerAuthorized(request)) {
        return;
      }
      return reply.code(401).send(errorBody("This node requires an encrypted session. Scan the join QR to connect."));
    }
  });

  ctx.server.addHook("preValidation", async (request, reply) => {
    const key = ctx.transportRequestKeys.get(request);
    if (!key) {
      return;
    }
    // An encrypted request carries { enc: "<sealed>" }; a GET may carry no body (response-only sealing).
    const body = request.body as { enc?: unknown } | undefined;
    if (body && typeof body.enc === "string") {
      const opened = openTransport(key, body.enc, `${request.method} ${request.url}`);
      if (opened === null) {
        return reply.code(400).send(errorBody("Malformed encrypted request"));
      }
      // The sealed plaintext is a `{ s: <seq>, b?: <body> }` envelope (docs/08): `s` is a per-session
      // monotonic sequence for replay protection, `b` the actual request body (omitted for a bodyless
      // mutation). `s` lives INSIDE the AEAD, so it's authenticated — an attacker can't renumber a
      // replay to dodge the window without breaking the tag.
      let envelope: { s?: unknown; r?: unknown; b?: unknown; tok?: unknown };
      try {
        envelope = JSON.parse(opened) as { s?: unknown; r?: unknown; b?: unknown; tok?: unknown };
      } catch {
        return reply.code(400).send(errorBody("Malformed encrypted request"));
      }
      if (!acceptEnvelopeSequence(request, envelope)) {
        // Replayed, reordered beyond the window, or a missing/garbage sequence — refuse before the
        // handler runs. 409 (not 401) so a legitimate client doesn't mistake it for an expired session
        // and silently re-handshake+retry: a real client never reuses a sequence, so this fires only on
        // a captured-and-replayed request (docs/08).
        return reply.code(409).send(errorBody("Replayed or out-of-order encrypted request"));
      }
      // A sealed node-to-node sync request carries the `sync.token` INSIDE the envelope (docs/08) — stash it
      // (authenticated by the AEAD) for `syncPeerAuthorized`, which prefers it over any wire header.
      if (typeof envelope.tok === "string") {
        ctx.transportRequestSyncToken.set(request, envelope.tok);
      }
      request.body = envelope.b;
      return;
    }
    // A GET/HEAD carries no body, so its `{ s, r }` envelope (if any) rides the `x-loam-seq` header, sealed
    // under the same request aad: that gives it a sequence to bind its response to. Without the header (an
    // older client) it is answered under the bare route aad as before; nothing to enforce.
    const sealedSeq = request.headers["x-loam-seq"];
    if ((request.method === "GET" || request.method === "HEAD") && typeof sealedSeq === "string") {
      const openedSeq = openTransport(key, sealedSeq, `${request.method} ${request.url}`);
      let envelope: { s?: unknown; r?: unknown } | undefined;
      try {
        envelope = openedSeq === null ? undefined : (JSON.parse(openedSeq) as { s?: unknown; r?: unknown });
      } catch {
        envelope = undefined;
      }
      if (!envelope || typeof envelope !== "object") {
        return reply.code(400).send(errorBody("Malformed encrypted request"));
      }
      if (!acceptEnvelopeSequence(request, envelope)) {
        return reply.code(409).send(errorBody("Replayed or out-of-order encrypted request"));
      }
      return;
    }
    // A GET/HEAD may otherwise carry no body at all (response-only sealing) — nothing to enforce.
    // But a mutation (POST/PATCH/DELETE/PUT) presented under a resolved transport session MUST arrive
    // as a sealed envelope: without this, a request that carries a live/known session id (visible on
    // the wire in the `x-loam-enc` header) alongside a plain, attacker-supplied JSON body would just
    // run as-is — an active network attacker could inject or rewrite a mutation's body without ever
    // needing the session key, defeating the whole point of the encrypted session. The client always
    // seals mutations, including bodyless ones (an empty envelope), so a legitimate request is never
    // affected (docs/08).
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(400).send(errorBody("Encrypted session requires a sealed request body"));
    }
  });

  ctx.server.addHook("onSend", async (request, reply, payload) => {
    const key = ctx.transportRequestKeys.get(request);
    // Only seal string payloads (JSON) — binary bodies (images, static files) pass through, and can't
    // be app-decrypted by a browser <img> anyway (a documented Layer-1 limitation).
    if (!key || typeof payload !== "string") {
      return payload;
    }
    // Bind the RESPONSE to the request's authenticated sequence (docs/08, "Response binding"): sealing under
    // `${method} ${url}#${seq}` means a captured response can't be replayed or cross-fed to a different
    // request on the same route (the caller opens with the exact seq it sent). Always for the direct-sealed
    // sync routes (every sealed sync request carries a `{ s }` envelope); for any other direct request when
    // its envelope asked (`r: 1`, the browser client in `optional` mode). The tunnel binds its responses
    // inside the sealed descriptor instead, and resume/logout carry their own `{ s, m, p }`. A request refused
    // before its sequence was authenticated (a 429, a malformed body) has none, so it gets the bare aad.
    const seq = ctx.transportRequestSeq.get(request);
    const routeUrl = request.routeOptions?.url;
    const bindToSequence =
      seq !== undefined &&
      (responseBoundRequests.has(request) || (routeUrl !== undefined && ctx.DIRECT_SEALED_SYNC_ROUTES.has(routeUrl)));
    const responseAad = bindToSequence ? `${request.method} ${request.url}#${seq}` : `${request.method} ${request.url}`;
    const sealed = sealTransport(key, payload, responseAad);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("x-loam-enc", "1");
    return JSON.stringify({ enc: sealed });
  });

  ctx.server.addHook("onSend", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");

    // Only decorate the app shell / navigations, not API JSON or image bytes (those set their own).
    if (!request.url.startsWith("/api/") && request.url !== "/ws") {
      reply.header(
        "content-security-policy",
        [
          "default-src 'self'",
          // Inline styles: the client injects generated SVG (avatars, QR) with style attributes.
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "connect-src 'self' ws: wss:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
      );
      reply.header("referrer-policy", "no-referrer");
    }
  });

  // Blanket per-IP throttle for every HTTP route; the abuse-sensitive endpoints (claim, panic,
  // avatar upload) add their own tighter semantic limits on top.
  registerRateLimit(ctx.server, {
    max: 300,
    timeWindow: "1 minute",
    // Internal tunnel re-dispatches are exempt from the GLOBAL limiter only: the outer tunnel request
    // already counted once against it, so counting the inner dispatch would double-charge every
    // tunnelled call. The tighter per-route semantic caps below use `semanticRateLimit()`, which
    // deliberately does NOT inherit this exemption.
    allowList: (request) => ctx.isInternalTunnelRequest(request),
  });
}

/** Register the handshake, sealed resume, logout, and path-hiding tunnel routes. */
export function registerTransportRoutes(ctx: AppContext): void {
  /**
   * The transport session to evict when the session map is at its cap: the oldest anonymous one (a
   * handshake that never resumed an identity, which is all an unauthenticated flood can create), else the
   * oldest bound one. Undefined only when the map is empty.
   */
  function oldestEvictableTransportSession(): string | undefined {
    let oldestBound: string | undefined;
    for (const [id, session] of ctx.transportSessions) {
      if (session.authMode === "anonymous") {
        return id;
      }
      oldestBound ??= id;
    }
    return oldestBound;
  }

  // Transport handshake (docs/08): client sends its ephemeral X25519 public key; the host derives a
  // session key against its static transport key + a fresh ephemeral and returns its ephemeral public
  // + a session id (used in `x-loam-enc` on subsequent encrypted requests). Unauthenticated (it's
  // bootstrap, before any session), rate-limited, and 404 when transport encryption is off.
  ctx.server.post(
    "/api/transport/handshake",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (ctx.effectiveTransportEncryption() === "off") {
        return reply.code(404).send(errorBody("Not found"));
      }

      const body = TransportHandshakeRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid handshake request"));
      }

      const identity = ctx.ensureTransportIdentity();
      let accepted: { hostEphemeralPublic: string; sessionKey: string };
      try {
        accepted = transportServerAccept({
          hostSecret: identity.secretKey,
          clientEphemeralPublic: body.data.clientEphemeralPublic,
        });
      } catch {
        return reply.code(400).send(errorBody("Invalid handshake request"));
      }

      // Prune expired sessions on every handshake (cheap — handshakes are already rate-limited per
      // IP), then enforce a hard cap: if still at/over it, evict live sessions to make room rather than
      // letting the map grow without bound. The handshake is unauthenticated, so a flood of them must not
      // push out the people already using the node: the oldest ANONYMOUS session (one that never resumed an
      // identity) goes first, and a bound session only when no anonymous one is left. Map iteration order
      // is insertion order, and every session shares the same TTL, so within each kind the earliest-inserted
      // entry is also the earliest-expiring.
      const now = Date.now();
      for (const [id, existingSession] of ctx.transportSessions) {
        if (existingSession.expiresAt <= now) {
          ctx.transportSessions.delete(id);
          ctx.closeSocketsForTransportSession(id);
        }
      }
      while (ctx.transportSessions.size >= ctx.TRANSPORT_SESSION_CAP) {
        const victim = oldestEvictableTransportSession();
        if (victim === undefined) {
          break;
        }
        ctx.transportSessions.delete(victim);
        ctx.closeSocketsForTransportSession(victim);
      }

      const sessionId = randomUUID();
      ctx.transportSessions.set(sessionId, {
        key: accepted.sessionKey,
        expiresAt: Date.now() + ctx.TRANSPORT_SESSION_TTL_MS,
        maxSeq: 0,
        seen: new Set(),
        authMode: "anonymous",
      });
      return {
        sessionId,
        hostEphemeralPublic: accepted.hostEphemeralPublic,
        hostPublicKey: identity.publicKey,
      };
    },
  );

  // Sealed identity resume + session binding (docs/20). A DIRECT sealed endpoint (not tunnelled) so the
  // outer TransportSession is reachable while there's no user yet. It requires a live transport session
  // (onRequest resolves it; preValidation decrypts + replay-checks the sealed `{ s, b }` body into the
  // `{ token? }` payload), and binds identity to that SESSION — so the un-sniffable session key becomes
  // the credential. It NEVER accepts a legacy cookie token. The `{ currentUser, token }` response is
  // sealed by onSend, so the secure token only ever crosses the wire encrypted.
  ctx.server.post("/api/session/resume", async (request, reply) => {
    const activeSession = ctx.transportRequestSessions.get(request);
    if (!activeSession) {
      // Reachable only with a live, sealed session (its body was decrypted). A plaintext hit is refused.
      return reply.code(400).send(errorBody("Resume requires an encrypted session"));
    }

    // Idempotent: a fresh-sequence retry after a lost response returns the cached identity — never a
    // second mint, never a rebind to a different identity. Re-stamp the response's bound sequence `s` to
    // THIS request's sequence (docs/20 §9) so a retrying client's response-binding check passes — the
    // user + token are identical, only the sequence it answers differs. `m`/`p` are constant.
    // The user is read live, never from the cached result: the identity was bound with whatever the record
    // said then, and an admin claim or a join approval since would otherwise be undone on the client's next
    // boot pass (the host's own WebView looped back into the queue that way).
    // `resumeResult` is set in the same synchronous step that binds the session (below), and nothing else
    // binds one, so a cached result is exactly "this session is bound".
    if (activeSession.resumeResult) {
      const liveUser = ctx.data.users.find((user) => user.id === activeSession.userId);
      return {
        ...activeSession.resumeResult,
        ...(liveUser ? { currentUser: ctx.rolesVisibleUser(liveUser) } : {}),
        s: ctx.transportRequestSeq.get(request),
      };
    }

    const body = request.body as { token?: unknown } | undefined;
    const rawToken = body?.token;
    // A `token` that is present but not a string ({token:123}, {token:{}}, …) is a malformed request — a
    // hard 400, not a silent mint (which would fragment an incompatible client's identity, docs/20).
    if (rawToken !== undefined && typeof rawToken !== "string") {
      return reply.code(400).send(errorBody("Invalid identity token"));
    }
    // Absent or empty-string → mint (an empty string is never a real 256-bit token); a non-empty string →
    // resume. Empty is treated as "no token" rather than "nonempty invalid" so an odd client isn't 401-looped.
    const presentedToken = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : undefined;

    let userId: string;
    let token: string;
    let tokenHash: string;
    if (presentedToken !== undefined) {
      tokenHash = hashIdentityToken(presentedToken);
      const resumed = ctx.identityTokens.get(tokenHash);
      if (!resumed) {
        // A non-empty but unknown/revoked token is an explicit auth failure — NEVER silently mint (that
        // would let a client launder a stolen-then-revoked token into a fresh working identity).
        return reply.code(401).send(errorBody("Invalid identity token"));
      }
      userId = resumed;
      token = presentedToken;
    } else {
      // First contact on this device: mint a new anonymous identity + a fresh secure token (the per-IP
      // identity-mint budget bounds it, exactly like a cookie mint).
      if (!ctx.consumeIdentityBudget(request.ip)) {
        throw new IdentityLimitError();
      }
      userId = ctx.mintSessionUserId();
      token = makeIdentityToken();
      tokenHash = hashIdentityToken(token);
      ctx.identityTokens.set(tokenHash, userId);
      ctx.store.putIdentityToken(tokenHash, userId, Date.now());
    }

    const currentUser = ctx.ensureSessionUser(userId);
    // Bind identity to this transport session — `authMode:"bound"` is what activates the secure rules
    // (content only via the tunnel, no cookie, WS key-confirmation) for this session, independent of the
    // node's global mode.
    activeSession.authMode = "bound";
    activeSession.userId = userId;
    activeSession.identityTokenHash = tokenHash;
    // Bind the response to the request it answers (docs/20 §9). Resume's aad is the same for every resume
    // request, and the response carries the secret token, so the client MUST confirm this reply is for
    // the exact `{ s, m, p }` it sent before storing the token.
    const result = {
      s: ctx.transportRequestSeq.get(request),
      m: "POST",
      p: "/api/session/resume",
      currentUser: ctx.rolesVisibleUser(currentUser),
      token,
    };
    activeSession.resumeResult = result;
    return result;
  });

  // Sealed logout / device-wipe revocation (docs/20 §8). A DIRECT sealed endpoint (like resume) so it can
  // reach the outer bound session. Revokes THIS device's secure identity token — deletes its row, drops
  // the transport sessions it bound, and closes its sockets — so a later resume with the same token fails
  // (401) and the identity can't be rehydrated. The client calls this BEFORE wiping its local IndexedDB.
  ctx.server.post("/api/session/logout", async (request, reply) => {
    const activeSession = ctx.transportRequestSessions.get(request);
    if (!activeSession) {
      return reply.code(400).send(errorBody("Logout requires an encrypted session"));
    }
    // Only a bound session has a secure token to revoke; a cookie session logs out via /api/session/end.
    if (activeSession.authMode === "bound" && activeSession.identityTokenHash) {
      ctx.revokeIdentityToken(activeSession.identityTokenHash);
    }
    return { ok: true };
  });

  // Methods the tunnel may re-dispatch — the full set the REST API uses. Validated so the cast to
  // Fastify's inject method type is sound and no odd verb reaches `server.inject`.
  const TUNNELLABLE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

  // Transport tunnel (docs/08, "v2"): the strongest metadata-hiding mode. Instead of each request
  // going to its real path (leaking e.g. `/api/search?q=<plaintext>` or which channel is being read),
  // the client sends every post-handshake request as an opaque `POST /api/transport/tunnel` whose
  // sealed body is `{ m, p, body }` (method, real path+query, optional body). The server re-dispatches
  // it INTERNALLY via `server.inject` (carrying the caller's own cookie + the unforgeable internal
  // token, so authz is unchanged and the inner request skips transport enforcement) and returns the
  // inner response as a `{ status, contentType, bodyB64 }` descriptor — which the outer request's
  // `onSend` hook then seals, so status, headers, and body (base64 → binary images tunnel losslessly)
  // are all ciphertext on the wire. Replay protection rides the same `{ s, b }` envelope as any sealed
  // request (the `s` is checked in preValidation before this handler runs).
  ctx.server.post("/api/transport/tunnel", { bodyLimit: ctx.LARGE_BODY_LIMIT }, async (request, reply) => {
    // Only a request whose body was actually sealed (so preValidation resolved a session key) may
    // tunnel — refuse a plaintext hit so the endpoint can never dispatch on an attacker-supplied path
    // outside an authenticated session.
    if (!ctx.transportRequestKeys.has(request)) {
      return reply.code(400).send(errorBody("Tunnel requires an encrypted session"));
    }

    const payload = request.body as { m?: unknown; p?: unknown; body?: unknown } | undefined;
    const method = typeof payload?.m === "string" ? payload.m.toUpperCase() : undefined;
    const path = typeof payload?.p === "string" ? payload.p : undefined;
    // The target check MUST match how Fastify routes the path, not the raw string. `server.inject`
    // percent-decodes the path before routing, so a raw `startsWith`/`includes` check on `p` diverges
    // from the routed path — e.g. `/api/transp%6frt/tunnel` decodes to `/api/transport/tunnel`
    // (recursion into this handler) and `/api/%2e%2e/admin` decodes to a traversal, both slipping past a
    // raw check. So: reject an encoded slash outright (`%2f` restructures segments and Fastify won't
    // treat it as a separator — pure ambiguity, and LOAM's own API paths never contain one), then
    // validate the fully-DECODED path. The raw `path` is what's handed to `inject` (routed identically).
    let decodedPath: string | undefined;
    if (path !== undefined && !/%2f/i.test(path)) {
      try {
        decodedPath = decodeURIComponent(path.split("?", 1)[0]);
      } catch {
        decodedPath = undefined; // malformed %-escape
      }
    }
    if (
      !method ||
      !TUNNELLABLE_METHODS.has(method) ||
      !decodedPath ||
      !decodedPath.startsWith("/api/") ||
      decodedPath.startsWith("/api/transport/") ||
      decodedPath.includes("..")
    ) {
      return reply.code(400).send(errorBody("Invalid tunnel target"));
    }

    const hasBody = payload?.body !== undefined;
    const headers: Record<string, string> = { "x-loam-internal": ctx.internalTunnelToken };
    // Identity for the inner request depends on how this session authenticated (docs/20 §2):
    //  • bound  → carry `x-loam-user` (the session-key-proven identity); NEVER forward a cookie — a
    //    bound session's cookie is not a credential, so a sniffed one is inert.
    //  • anonymous → optional/off best-effort cookie-auth: forward the cookie as before. Under
    //    `required` mode an anonymous session may not tunnel content at all — it must resume first,
    //    else a captured cookie tunnelled through an attacker's own session would impersonate.
    const tunnelSession = ctx.transportRequestSessions.get(request);
    if (tunnelSession?.authMode === "bound" && tunnelSession.userId) {
      headers["x-loam-user"] = tunnelSession.userId;
    } else if (ctx.effectiveTransportEncryption() === "required") {
      return reply.code(401).send(errorBody("Resume an identity before tunnelling content"));
    } else if (typeof request.headers.cookie === "string") {
      headers.cookie = request.headers.cookie;
    }
    if (hasBody) {
      headers["content-type"] = "application/json";
    }

    const injected = await ctx.server.inject({
      method: method as "GET",
      url: path,
      headers,
      // Forward the real caller's address so the inner request's `request.ip` is the client's, not
      // loopback — otherwise every tunnelled request would share one IP for the per-IP identity-mint
      // budget and the claim/panic limiters (one client could exhaust them for everyone).
      remoteAddress: request.ip,
      payload: hasBody ? JSON.stringify(payload?.body) : undefined,
    });

    // Forward a freshly-minted session cookie on the OUTER response for an ANONYMOUS optional-mode tunnel
    // (identity bootstrap through the tunnel) — the browser must see Set-Cookie to store it. A bound
    // session's inner request mints no cookie (identity came via `x-loam-user`), so there's nothing to
    // forward there.
    // The inner request is never request-logged (it would print the hidden path — `loamLogController`),
    // which also silences its 5xx error line; keep a path-free trace of the failure on the outer request.
    if (injected.statusCode >= 500) {
      request.log.error({ method, status: injected.statusCode }, "A tunnelled request failed");
    }

    const setCookie = injected.headers["set-cookie"];
    if (setCookie !== undefined) {
      reply.header("set-cookie", setCookie);
    }

    // The onSend transport hook seals THIS descriptor (a JSON string) under the tunnel route's CONSTANT
    // aad, so the real status/content-type/body never appear in cleartext. Because the aad is the same
    // for every tunnel request, we BIND the response to the exact request it answers (docs/20 §9): the
    // authenticated sequence `s`, method `m`, and path `p` the client sealed. The client verifies these
    // before using the body — so an attacker can't cross-feed one in-flight response as another's. Body
    // is base64 for lossless binary.
    return {
      s: ctx.transportRequestSeq.get(request),
      m: method,
      p: path,
      status: injected.statusCode,
      contentType: injected.headers["content-type"] ?? "application/octet-stream",
      bodyB64: injected.rawPayload.toString("base64"),
    };
  });
}
