// The live-event layer: connected sockets, audience filtering, sealed WebSocket frames, presence, and
// the `/ws` route with its reflection-safe key-confirmation. Extracted verbatim from app.ts
// (2026-09-04 split) over the shared AppContext.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { openTransport, sealTransport } from "@loam/crypto";
import type { StreamEvent } from "@loam/schema";
import type { AppContext } from "./app-context.js";
import { errorBody } from "./errors.js";
import type { ClientEvent, SocketClient, SocketSession } from "./types.js";

/** Direction-separated AADs for the reflection-safe WS key-confirmation (docs/20 §7): the challenge
 * and the proof seal under DIFFERENT constants, so a keyless attacker can't reflect the server's
 * challenge ciphertext back as a valid proof. Application frames bind to the connection id. */
const WS_CHALLENGE_AAD = "loam.ws.challenge.v1";
const WS_PROOF_AAD = "loam.ws.proof.v1";
const WS_FRAME_AAD_PREFIX = "loam.ws.frame.v1";
/** How long an encrypted socket has to answer the key-confirmation challenge before it's dropped. */
const WS_CHALLENGE_TIMEOUT_MS = 10_000;
/** Cap on simultaneously-unconfirmed encrypted sockets (anti-flood on the pre-auth path, docs/20 §7). */
const WS_UNCONFIRMED_CAP = 128;
/** Tighter PER-IP cap on unconfirmed sockets, so a few LAN hosts can't exhaust the global pool and lock
 * everyone out. A real client confirms in milliseconds, so it never holds more than one or two at once. */
const WS_UNCONFIRMED_PER_IP_CAP = 8;
/**
 * Largest client→server WebSocket frame the server will assemble (review 2026-09-04). The only frame a
 * client ever legitimately sends is the ~200-byte sealed key-confirmation proof (confirmed sockets are
 * ignored, plaintext sockets register no listener) — but `ws` still buffers every inbound frame in full
 * before emitting it, and its default cap is 100 MiB, so an admitted socket could push several of those
 * at a Pi/phone host concurrently. 16 KiB leaves generous headroom for the proof envelope.
 */
export const WS_MAX_INBOUND_FRAME_BYTES = 16 * 1024;

export function createRealtime(ctx: AppContext) {
  const sockets = new Set<SocketSession>();

  // Encrypted sockets that have connected but not yet passed the key-confirmation challenge (docs/20 §7).
  // `unconfirmedSocketCount` is the global cap; `unconfirmedByIp` is a tighter per-IP cap so a couple of
  // LAN hosts can't hold the whole global pool and lock everyone else out (the pre-auth path is
  // unauthenticated). `pendingSockets` lets revocation (ban/logout/kill-switch) reach a socket that is
  // still mid-challenge — otherwise it exists only as closures and could confirm AFTER being revoked.
  let unconfirmedSocketCount = 0;

  const unconfirmedByIp = new Map<string, number>();

  const pendingSockets = new Set<{ userId: string; close: () => void }>();

  /** Close CONFIRMED sockets (those in the live `sockets` set) riding a transport session that is being
   * pruned/evicted (docs/20 §7), so a socket can't keep receiving frames after its session key is gone. The
   * per-socket expiry timer covers natural expiry; this covers an ABRUPT removal (cap eviction) before that
   * timer fires. A socket still MID-CHALLENGE for that session isn't in `sockets` yet, but it can't slip
   * through: the confirm-time `stillValid` check re-reads `transportSessions.get(sid)`, which no longer
   * matches the evicted session, so its late proof is refused. */
  function closeSocketsForTransportSession(sid: string): void {
    for (const socketSession of [...sockets]) {
      if (socketSession.transportSessionId === sid) {
        socketSession.socket.close();
        sockets.delete(socketSession);
      }
    }
  }

  function socketCanReceiveEvent(userId: string, event: ClientEvent): boolean {
    const recipient = ctx.data.users.find((candidate) => candidate.id === userId);

    // A banned recipient hears nothing (their sockets are closed on ban; this also covers a racing
    // reconnect). A pending (unapproved) recipient only hears about their own approval and
    // node-level notices — no content until a greeter lets them in, matching the REST gates.
    if (recipient?.banned) {
      return false;
    }

    if (recipient?.pending) {
      return (
        event.type === "wipe" ||
        event.type === "configUpdated" ||
        (event.type === "userUpserted" && event.user.id === userId)
      );
    }

    if (event.type === "configUpdated" || event.type === "wipe") {
      return true;
    }

    if (event.type === "userUpserted") {
      // Banned and pending identities are hidden from the REST roster (visibleUsers), so their
      // upserts are only announced to themselves and to the people who can act on them.
      const subject = event.user;

      if (!subject.banned && !subject.pending) {
        return true;
      }

      return userId === subject.id || (!!recipient && (ctx.canModerate(recipient) || ctx.canGreet(recipient)));
    }

    if (event.type === "channelUpserted") {
      // Public channel upserts go to all sockets (`GET /api/channels` returns them to everyone);
      // a private channel — including its member list — is only ever sent to its members.
      return ctx.canAccessChannel(event.channel, userId);
    }

    if (event.type === "channelRemoved") {
      // Targeted notice (a member losing access) — delivered via sendEventToUsers, never broadcast.
      return false;
    }

    if (event.type === "presence") {
      // Contains only visible users' ids; the banned/pending recipient gates above already ran.
      return true;
    }

    if (event.type === "typing") {
      // Never echo the typist their own signal. Channel typing goes to anyone who can access the channel;
      // DM typing goes only to the other participant.
      if (userId === event.userId) {
        return false;
      }
      // A shadow-banned user is hidden from everyone but themselves — their "typing…" must not leak either
      // (it would reveal they're active), matching how their messages are withheld.
      const typist = ctx.data.users.find((candidate) => candidate.id === event.userId);
      if (typist?.shadowBanned) {
        return false;
      }
      if (event.channelId) {
        const channel = ctx.ensureChannel(event.channelId);
        return !!channel && ctx.canAccessChannel(channel, userId);
      }
      return userId === event.dmUserId;
    }

    const message = event.message;

    // Shadow ban: a message whose author is currently shadow-banned is delivered only back to the
    // author, so their own UI still shows it while nobody else ever sees it. Layered on top of the
    // DM-audience filtering below (a shadow-banned DM is only ever seen by its author). This must
    // cover messageDeleted too — those events carry the full message body, so an unfiltered delete
    // (author, admin, or the retention reaper) would hand the hidden text to the whole audience.
    if (event.type === "messageCreated" || event.type === "messageUpdated" || event.type === "messageDeleted") {
      const author = ctx.data.users.find((candidate) => candidate.id === message.authorId);

      if (author?.shadowBanned && userId !== message.authorId) {
        return false;
      }
    }

    const audience = ctx.messageAudienceUserIds(message);
    return !audience || audience.has(userId);
  }

  /** Send one already-serialized frame to a socket. For an encrypted, key-confirmed socket the frame is
   * sealed under a CONNECTION-BOUND aad (`loam.ws.frame.v1 <connectionId>`, docs/20 §7) and wrapped in a
   * `{ q, f }` envelope carrying a monotonic per-connection sequence `q`, so the client rejects a frame
   * replayed from another connection or re-sent on this one. A plaintext socket (transport off) sends the
   * raw payload. Callers keep their own readyState + audience checks. */
  function wsSend(session: SocketSession, payload: string): void {
    if (session.transportKey && session.connectionId) {
      session.frameSeq = (session.frameSeq ?? 0) + 1;
      const aad = `${WS_FRAME_AAD_PREFIX} ${session.connectionId}`;
      session.socket.send(sealTransport(session.transportKey, JSON.stringify({ q: session.frameSeq, f: payload }), aad));
      return;
    }
    session.socket.send(payload);
  }

  function broadcast(event: ClientEvent): void {
    if (event.type === "userUpserted") {
      // Two shapes: `roles` (moderator/greeter) reach only the subject (so their own client can gate
      // its moderation UI) and moderators (who manage roles); everyone else gets the fully-public
      // record. `shadowBanned` is never on the wire in EITHER shape — not even to self or moderators
      // (they read it via /api/moderation/users). The ban still takes full effect server-side.
      const subject = event.user;
      const strippedPayload = JSON.stringify({ ...event, user: ctx.publicUser(subject) });
      const rolesPayload = JSON.stringify({ ...event, user: ctx.rolesVisibleUser(subject) });

      for (const session of sockets) {
        if (session.socket.readyState !== session.socket.OPEN || !socketCanReceiveEvent(session.userId, event)) {
          continue;
        }
        const recipient = ctx.data.users.find((candidate) => candidate.id === session.userId);
        const seesRoles = session.userId === subject.id || (!!recipient && ctx.canModerate(recipient));
        wsSend(session, seesRoles ? rolesPayload : strippedPayload);
      }
      return;
    }

    const payload = JSON.stringify(event);
    for (const session of sockets) {
      if (session.socket.readyState === session.socket.OPEN && socketCanReceiveEvent(session.userId, event)) {
        wsSend(session, payload);
      }
    }
  }

  /** User ids with at least one open socket, restricted to visible (non-banned/-pending) users. */
  function onlineUserIds(): string[] {
    const online = new Set<string>();

    for (const { socket, userId } of sockets) {
      if (socket.readyState === socket.OPEN) {
        online.add(userId);
      }
    }

    return [...online].filter((id) => {
      const user = ctx.data.users.find((candidate) => candidate.id === id);
      return !!user && !user.banned && !user.pending;
    });
  }

  /**
   * Tell everyone who is connected right now (online dots). No-op when `enablePresence` is off —
   * high-risk deployments disable it, since presence reveals exactly who is reachable at this
   * moment. Sent on every connect/disconnect; at LAN scale that needs no debouncing.
   */
  function broadcastPresence(): void {
    if (!ctx.appConfig.features.enablePresence) {
      return;
    }

    broadcast({ type: "presence", onlineUserIds: onlineUserIds() });
  }

  /**
   * Send an event to the sockets of the given users only, bypassing the broadcast audience filter.
   * Used for targeted notices such as `channelRemoved`, whose recipient is by definition no longer
   * in the event's natural audience.
   */
  function sendEventToUsers(audience: Set<string>, event: ClientEvent): void {
    const payload = JSON.stringify(event);

    for (const session of sockets) {
      if (session.socket.readyState === session.socket.OPEN && audience.has(session.userId)) {
        wsSend(session, payload);
      }
    }
  }

  /**
   * Send a streaming event to the sockets of the given users only.
   *
   * @param audience - User ids allowed to receive the event (e.g. the two DM participants)
   * @param event - The stream event to deliver
   */
  function broadcastStreamEvent(audience: Set<string>, event: StreamEvent): void {
    const payload = JSON.stringify(event);

    for (const session of sockets) {
      if (session.socket.readyState === session.socket.OPEN && audience.has(session.userId)) {
        wsSend(session, payload);
      }
    }
  }

  /** Register the `/ws` route (after the websocket plugin is registered). */
  function registerWebSocketRoute(): void {
    ctx.server.get("/ws", { websocket: true }, (connection: SocketClient, request) => {
      const mode = ctx.effectiveTransportEncryption();
      const transportSession = mode === "off" ? undefined : ctx.wsTransportSession(request.url);
      const transportKey = transportSession?.key;
      // The presented transport session id (used at confirm-time to detect a mid-challenge revocation:
      // ban/logout/kill-switch/eviction deletes the session from `transportSessions`).
      const wsParams = new URLSearchParams(request.url.split("?")[1] ?? "");
      const encPresent = wsParams.has("enc");
      const sid = wsParams.get("enc") ?? "";

      // FAIL CLOSED on a presented-but-unresolved session (docs/20). Distinguish "no `?enc=` at all" (fine —
      // a plaintext socket on off/optional) from "`?enc=` was supplied but doesn't resolve to a live
      // session": the latter is REFUSED in EVERY mode — INCLUDING `off` (`transportSession` is always
      // undefined there). A legitimate plaintext client never sends `?enc=`, so only a stale key-pinned
      // client would; refusing it stops that client from silently downgrading to a plaintext cookie socket
      // (wrong-user attribution + cleartext) after the node was switched to `off` or its session expired. We
      // key on parameter PRESENCE (`has`), so even a bare `?enc=` (empty value) fails closed.
      if (encPresent && !transportSession) {
        connection.send(JSON.stringify({ type: "error", ...errorBody("Transport session expired") }));
        connection.close();
        return;
      }

      // Identity: a `bound` transport session's userId is the WS identity (docs/20) — the session key is
      // the credential, proven below by the key-confirmation challenge; the plaintext cookie is not used.
      // For an anonymous session (optional/off) the cookie identity applies, as before.
      const boundUserId =
        transportSession?.authMode === "bound" && transportSession.userId ? transportSession.userId : undefined;
      const userId = boundUserId ?? ctx.getSessionUserIdFromRequest(request);

      if (!userId) {
        connection.send(JSON.stringify({ type: "error", ...errorBody("Unauthenticated websocket") }));
        connection.close();
        return;
      }

      // Under `required` mode the socket must ride a `bound` transport session — an anonymous session (or
      // none) can't reach the live feed, mirroring the tunnel-only content rule.
      if (mode === "required" && !boundUserId) {
        connection.send(JSON.stringify({ type: "error", ...errorBody("This node requires an encrypted session") }));
        connection.close();
        return;
      }

      // A banned identity keeps its session mapping (so the ban stays pinned to it — see
      // invalidateUserSessions) but must not be readmitted to the live feed by a reconnect.
      // Pending users may connect: the broadcast filter limits them to their own approval notice.
      const user = ctx.data.users.find((candidate) => candidate.id === userId);

      if (user?.banned) {
        connection.send(JSON.stringify({ type: "error", ...errorBody("This session is no longer valid") }));
        connection.close();
        return;
      }

      // A plaintext socket (transport off, or an anonymous optional session with no key) is admitted
      // directly — there is no session key to confirm. Its frames go out in the clear (documented).
      if (!transportKey) {
        const socketSession: SocketSession = { socket: connection, userId };
        sockets.add(socketSession);
        broadcastPresence();
        connection.on("close", () => {
          sockets.delete(socketSession);
          broadcastPresence();
        });
        return;
      }

      // Encrypted socket: a visible session id is NOT proof of the key (docs/20 §7). Withhold everything
      // — presence, events, admission to `sockets` — until the client answers a reflection-safe
      // challenge. Cap simultaneously-unconfirmed sockets both globally AND per-IP so this pre-auth path
      // can't be flooded (a few LAN hosts mustn't lock everyone out), and time out a socket that never proves.
      const ip = request.ip;
      if (unconfirmedSocketCount >= WS_UNCONFIRMED_CAP || (unconfirmedByIp.get(ip) ?? 0) >= WS_UNCONFIRMED_PER_IP_CAP) {
        connection.send(JSON.stringify({ type: "error", ...errorBody("Too many pending connections; try again") }));
        connection.close();
        return;
      }

      const connectionId = randomUUID();
      const nonce = randomBytes(32).toString("base64url");
      let confirmed = false;
      let settled = false; // guards the unconfirmed counters against a double decrement (confirm then close)
      unconfirmedSocketCount += 1;
      unconfirmedByIp.set(ip, (unconfirmedByIp.get(ip) ?? 0) + 1);

      /** Release the unconfirmed-socket reservation exactly once (on confirm, timeout, or close). */
      function releaseUnconfirmed(): void {
        if (settled) {
          return;
        }
        settled = true;
        unconfirmedSocketCount -= 1;
        const remaining = (unconfirmedByIp.get(ip) ?? 1) - 1;
        if (remaining <= 0) {
          unconfirmedByIp.delete(ip);
        } else {
          unconfirmedByIp.set(ip, remaining);
        }
      }

      const socketSession: SocketSession = {
        socket: connection,
        userId,
        transportKey,
        connectionId,
        frameSeq: 0,
        transportSessionId: sid,
      };
      // Closes the socket when its transport session reaches `expiresAt`, so a confirmed socket can't keep
      // receiving frames past the session key's lifetime (docs/20 §7). Set on confirm, cleared on close.
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      // Register the mid-challenge socket so ban/logout/kill-switch can reach and close it — otherwise it
      // exists only as closures and could complete its proof AFTER being revoked and slip into the feed.
      const pending = { userId, close: () => connection.close() };
      pendingSockets.add(pending);

      const timer = setTimeout(() => {
        if (!confirmed) {
          connection.close();
        }
      }, WS_CHALLENGE_TIMEOUT_MS);
      // node:timers `unref` so a pending challenge never keeps the process alive in tests; guarded since
      // the WS mock in unit tests may not return a real Timeout.
      (timer as { unref?: () => void }).unref?.();

      connection.on("message", (raw: unknown) => {
        if (confirmed) {
          return; // the client has no reason to speak again; ignore late/extra frames
        }
        const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const opened = openTransport(transportKey, text, WS_PROOF_AAD);
        if (opened === null) {
          return; // undecryptable under the proof aad — a reflected challenge lands here and is ignored
        }
        let proof: { type?: unknown; connectionId?: unknown; nonce?: unknown };
        try {
          proof = JSON.parse(opened) as typeof proof;
        } catch {
          return;
        }
        // The proof must echo THIS connection's id + nonce, sealed under the proof aad. A reflected
        // challenge fails (wrong aad → openTransport null above); a stale/other-connection proof fails the
        // constant-time nonce+id comparison.
        const nonceOk =
          typeof proof.nonce === "string" &&
          Buffer.byteLength(proof.nonce) === Buffer.byteLength(nonce) &&
          timingSafeEqual(Buffer.from(proof.nonce), Buffer.from(nonce));
        if (proof.type !== "proof" || proof.connectionId !== connectionId || !nonceOk) {
          return;
        }

        // Re-check revocation AND expiry at CONFIRM time (docs/20 §8): a ban / logout / kill-switch (or an
        // evicted transport session) may have landed during the up-to-10s challenge window, and the session
        // may have crossed `expiresAt` in that window. Ban is only checked at connect otherwise, and a
        // revocation/expiry that fired mid-challenge must not be undone by a late proof.
        const stillValid =
          ctx.transportSessions.get(sid) === transportSession &&
          transportSession.expiresAt > Date.now() &&
          !ctx.data.users.find((candidate) => candidate.id === userId)?.banned;
        if (!stillValid) {
          connection.close();
          return;
        }

        confirmed = true;
        clearTimeout(timer);
        releaseUnconfirmed();
        pendingSockets.delete(pending);
        sockets.add(socketSession);
        // Bound the socket's life to its session key's expiry (docs/20 §7).
        expiryTimer = setTimeout(() => connection.close(), Math.max(0, transportSession.expiresAt - Date.now()));
        (expiryTimer as { unref?: () => void }).unref?.();
        broadcastPresence();
      });

      connection.on("close", () => {
        clearTimeout(timer);
        if (expiryTimer) {
          clearTimeout(expiryTimer);
        }
        releaseUnconfirmed();
        pendingSockets.delete(pending);
        sockets.delete(socketSession);
        broadcastPresence();
      });

      // Kick off the challenge. Sealed under the challenge aad; the client replies under the proof aad.
      connection.send(
        sealTransport(transportKey, JSON.stringify({ type: "challenge", connectionId, nonce }), WS_CHALLENGE_AAD),
      );
    });
  }

  return {
    sendEventToUsers,
    broadcastStreamEvent,
    sockets,
    socketCanReceiveEvent,
    broadcastPresence,
    wsSend,
    onlineUserIds,
    pendingSockets,
    closeSocketsForTransportSession,
    unconfirmedByIp,
    broadcast,
    registerWebSocketRoute,
  };
}
