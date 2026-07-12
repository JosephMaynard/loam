import { createTransportIdentity, openTransport, sealTransport, transportServerAccept } from "@loam/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiUrl,
  clearStoredIdentityToken,
  encryptedFetch,
  encryptedImageUrl,
  ensureSession,
  fingerprint,
  getCachedHostPublicKey,
  getHostKeyMismatch,
  getSession,
  handleWsFrame,
  isTunnelActive,
  logoutSecureIdentity,
  resumeIdentity,
  resetTransportStateForTests,
  SERVER_URL_KEY,
  TransportNeedsQrError,
  wsUrl,
} from "./transport";

/** Simulates the server side of a handshake for a given host identity: parses the client's hello,
 * runs the real `transportServerAccept`, and returns the JSON body `/api/transport/handshake` sends. */
function handshakeResponseBody(
  hostSecretKey: string,
  hostPublicKey: string,
  requestBody: string,
): { status: number; json: unknown } {
  const { clientEphemeralPublic } = JSON.parse(requestBody) as { clientEphemeralPublic: string };
  const accepted = transportServerAccept({ hostSecret: hostSecretKey, clientEphemeralPublic });
  return {
    status: 200,
    json: { sessionId: "sess-1", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey },
  };
}

describe("transport", () => {
  beforeEach(() => {
    resetTransportStateForTests();
    localStorage.clear();
    window.location.hash = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = "";
  });

  describe("apiUrl", () => {
    it("is server-relative with no configured server override", () => {
      expect(apiUrl("/api/config")).toBe("/api/config");
    });

    it("prefixes a configured server origin override", () => {
      localStorage.setItem(SERVER_URL_KEY, "http://192.168.1.5:3001");
      expect(apiUrl("/api/config")).toBe("http://192.168.1.5:3001/api/config");
    });
  });

  describe("encryptedFetch (off mode / no session)", () => {
    it("is a byte-for-byte passthrough with no body", async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const response = await encryptedFetch("GET", "/api/channels");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("/api/channels", {
        method: "GET",
        credentials: "include",
        headers: undefined,
        signal: undefined,
        body: undefined,
      });
      expect(await response.json()).toEqual({ ok: true });
    });

    it("is a byte-for-byte passthrough with a JSON body", async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await encryptedFetch("POST", "/api/messages", { body: "hi" });

      expect(fetchMock).toHaveBeenCalledWith("/api/messages", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        signal: undefined,
        body: JSON.stringify({ body: "hi" }),
      });
    });
  });

  describe("ensureSession", () => {
    it("off mode never establishes a session", async () => {
      await ensureSession("off");
      expect(getSession()).toBeUndefined();
    });

    it("throws TransportNeedsQrError in required mode with no host key available", async () => {
      await expect(ensureSession("required")).rejects.toBeInstanceOf(TransportNeedsQrError);
      expect(getSession()).toBeUndefined();
    });

    it("optional mode with no host key silently leaves no session (no throw)", async () => {
      await expect(ensureSession("optional")).resolves.toBeUndefined();
      expect(getSession()).toBeUndefined();
    });

    it("optional mode performs a real handshake against the config host key when no QR key is present", async () => {
      const host = createTransportIdentity();
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
        return new Response(JSON.stringify(json), { status });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);

      const session = getSession();
      expect(session).toBeDefined();
      expect(session?.hostPublicKey).toBe(host.publicKey);
      expect(session?.sessionId).toBe("sess-1");
      expect(getHostKeyMismatch()).toBe(false);
    });

    it("required mode NEVER falls back to the config host key — only a QR-delivered key is trusted (docs/08)", async () => {
      // A MITM node can advertise any `transportPublicKey` it likes over `/api/config` — that channel
      // isn't out-of-band-authenticated. If `required` mode trusted it as a fallback, an active
      // attacker could hand out its own key and defeat the entire point of requiring the QR. This is
      // the regression test for that: even with a configHostKey present, no QR key means no session.
      const host = createTransportIdentity();
      const fetchMock = vi.fn(async () => {
        throw new Error("must not attempt a handshake without a QR-delivered key in required mode");
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(ensureSession("required", host.publicKey)).rejects.toBeInstanceOf(TransportNeedsQrError);

      expect(getSession()).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("required mode DOES establish a session once a QR key is available, ignoring a disagreeing config key", async () => {
      const host = createTransportIdentity();
      const impostor = createTransportIdentity();
      window.location.hash = `#k=${host.publicKey}`;

      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        // The server side only knows about `host`'s keypair — proof the QR key (not the impostor
        // config key) is what actually gets used for the handshake.
        const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
        return new Response(JSON.stringify(json), { status });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("required", impostor.publicKey);

      const session = getSession();
      expect(session?.hostPublicKey).toBe(host.publicKey);
      expect(getHostKeyMismatch()).toBe(true);
    });

    it("a QR key forces encryption even when config advertises \"off\" — defeats a MITM downgrade (docs/08)", async () => {
      // `/api/config` is unauthenticated, so its `transportEncryption` value is attacker-mutable: a
      // network MITM could flip it to "off" to strip encryption while the user believes their scanned
      // QR protected them. A present QR key (freshly scanned OR cached from a prior verified join) must
      // pin the join to an encrypted session regardless of the advertised mode.
      const host = createTransportIdentity();
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
        return new Response(JSON.stringify(json), { status });
      });
      vi.stubGlobal("fetch", fetchMock);

      // Freshly scanned QR (#k=) with a config that says "off": still handshakes, still encrypts.
      window.location.hash = `#k=${host.publicKey}`;
      await ensureSession("off", undefined);
      expect(getSession()?.hostPublicKey).toBe(host.publicKey);
      expect(getCachedHostPublicKey()).toBe(host.publicKey);

      // A later boot/reconnect with no fragment but a cached key and an "off" config must not downgrade.
      // The live session (bound to the QR key) is REUSED rather than re-handshaked (docs/20 — a blind
      // re-handshake would orphan a live WS), but it stays encrypted against the QR key: no downgrade.
      fetchMock.mockClear();
      await ensureSession("off", undefined);
      expect(fetchMock).not.toHaveBeenCalled(); // reused, not re-handshaked
      expect(getSession()?.hostPublicKey).toBe(host.publicKey); // still encrypted against the QR key

      // With no live session, a cached QR key still forces a fresh encrypted handshake (no downgrade).
      resetTransportStateForTests();
      localStorage.setItem(`loam.transportHostKey.${window.location.origin}`, host.publicKey);
      fetchMock.mockClear();
      await ensureSession("off", undefined);
      expect(fetchMock).toHaveBeenCalled();
      expect(getSession()?.hostPublicKey).toBe(host.publicKey);
    });

    it("prefers a QR-delivered (#k=) key over the config key and flags a mismatch when they disagree", async () => {
      const host = createTransportIdentity();
      const impostor = createTransportIdentity();
      window.location.hash = `#k=${host.publicKey}`;

      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        // The server side only knows about `host`'s keypair — the client trusts the QR key
        // regardless, which is exactly the property under test.
        const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
        return new Response(JSON.stringify(json), { status });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", impostor.publicKey);

      expect(getHostKeyMismatch()).toBe(true);
      expect(getSession()?.hostPublicKey).toBe(host.publicKey);
      // The QR key is cached for this origin and the fragment is stripped from the visible URL.
      expect(getCachedHostPublicKey()).toBe(host.publicKey);
      expect(window.location.hash).toBe("");
    });
  });

  describe("encryptedFetch (with a live session)", () => {
    it("seals the request body as { enc } and unseals a sealed { enc } response", async () => {
      const host = createTransportIdentity();
      let sessionKeyOnServer: string | undefined;
      let capturedRequestBody: unknown;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          const accepted = transportServerAccept({
            hostSecret: host.secretKey,
            clientEphemeralPublic: (JSON.parse(init.body as string) as { clientEphemeralPublic: string })
              .clientEphemeralPublic,
          });
          sessionKeyOnServer = accepted.sessionKey;
          return new Response(
            JSON.stringify({
              sessionId: "sess-42",
              hostEphemeralPublic: accepted.hostEphemeralPublic,
              hostPublicKey: host.publicKey,
            }),
            { status: 200 },
          );
        }

        // A content request: the wire body must be `{ enc }`, never the plaintext object.
        const wireBody = JSON.parse(init.body as string) as { enc: string };
        expect(wireBody.enc).toBeTypeOf("string");
        capturedRequestBody = wireBody;

        const aad = `${init.method} ${url}`;
        const opened = openTransport(sessionKeyOnServer!, wireBody.enc, aad);
        expect(opened).not.toBeNull();
        // The sealed plaintext is the `{ s, b }` anti-replay envelope: sequence 1 (first request on a
        // fresh session) carrying the body under `b`.
        expect(JSON.parse(opened!)).toEqual({ s: 1, b: { text: "hello" } });

        const sealedResponse = sealTransport(sessionKeyOnServer!, JSON.stringify({ id: "msg_1" }), aad);
        return new Response(JSON.stringify({ enc: sealedResponse }), {
          status: 200,
          headers: { "x-loam-enc": "1" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);
      const response = await encryptedFetch("POST", "/api/messages", { text: "hello" });

      expect(capturedRequestBody).toBeDefined();
      expect(await response.json()).toEqual({ id: "msg_1" });
    });

    it("assigns a strictly increasing per-session sequence to each sealed request (anti-replay)", async () => {
      const host = createTransportIdentity();
      let serverKey: string | undefined;
      const seqs: number[] = [];

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          const accepted = transportServerAccept({
            hostSecret: host.secretKey,
            clientEphemeralPublic: (JSON.parse(init.body as string) as { clientEphemeralPublic: string })
              .clientEphemeralPublic,
          });
          serverKey = accepted.sessionKey;
          return new Response(
            JSON.stringify({ sessionId: "s", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey }),
            { status: 200 },
          );
        }
        const wire = JSON.parse(init.body as string) as { enc: string };
        const opened = openTransport(serverKey!, wire.enc, `${init.method} ${url}`);
        seqs.push((JSON.parse(opened!) as { s: number }).s);
        return new Response(null, { status: 204 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);
      await encryptedFetch("POST", "/api/messages", { n: 1 });
      await encryptedFetch("POST", "/api/messages", { n: 2 });
      await encryptedFetch("DELETE", "/api/messages/x");

      expect(seqs).toEqual([1, 2, 3]);
    });
  });

  describe("re-handshake retry on a stale session", () => {
    /** A fresh handshake responder bound to a host identity — used both for the initial
     * `ensureSession` and for the transparent re-handshake `attemptFetch` triggers. */
    function handshakeResponder(host: ReturnType<typeof createTransportIdentity>) {
      return async (_url: string, init: RequestInit) => {
        const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
        return new Response(JSON.stringify(json), { status });
      };
    }

    it("re-handshakes exactly once on a 401 for an established session, then retries and succeeds", async () => {
      const host = createTransportIdentity();
      let contentCalls = 0;
      let handshakeCalls = 0;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          handshakeCalls += 1;
          return handshakeResponder(host)(url, init);
        }

        contentCalls += 1;

        if (contentCalls === 1) {
          // The session the server knew about has expired: reject the first content request.
          return new Response(null, { status: 401 });
        }

        // Retry after the transparent re-handshake succeeds — a real session is live again, so seal a
        // real response the same way the server would.
        const session = getSession();
        expect(session).toBeDefined();
        const aad = `${init.method} ${url}`;
        const opened = JSON.parse(init.body as string) as { enc: string };
        expect(openTransport(session!.key, opened.enc, aad)).not.toBeNull();
        const sealed = sealTransport(session!.key, JSON.stringify({ ok: true }), aad);
        return new Response(JSON.stringify({ enc: sealed }), { status: 200, headers: { "x-loam-enc": "1" } });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);
      expect(handshakeCalls).toBe(1);

      const response = await encryptedFetch("POST", "/api/messages", { text: "hi" });

      // Exactly one retry: two content attempts, and exactly one *additional* handshake (the
      // transparent re-handshake), never more.
      expect(contentCalls).toBe(2);
      expect(handshakeCalls).toBe(2);
      expect(await response.json()).toEqual({ ok: true });
      expect(getSession()).toBeDefined();
    });

    it("gives up after one retry — does not loop on a session that keeps failing", async () => {
      const host = createTransportIdentity();
      let contentCalls = 0;
      let handshakeCalls = 0;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          handshakeCalls += 1;
          return handshakeResponder(host)(url, init);
        }

        contentCalls += 1;
        // Every content request 401s, however many times it's retried.
        return new Response(null, { status: 401 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);
      expect(handshakeCalls).toBe(1);

      const response = await encryptedFetch("GET", "/api/channels");

      // Exactly one retry: two content attempts, one re-handshake — never an infinite loop.
      expect(contentCalls).toBe(2);
      expect(handshakeCalls).toBe(2);
      expect(response.status).toBe(401);
    });

    it("gives up after one retry when the response claims encryption but fails to decrypt twice", async () => {
      const host = createTransportIdentity();
      let contentCalls = 0;
      let handshakeCalls = 0;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          handshakeCalls += 1;
          return handshakeResponder(host)(url, init);
        }

        contentCalls += 1;
        // Claims to be sealed (`x-loam-enc: "1"`) but the payload can't be opened under any session
        // key the client holds — e.g. a server that rotated its own session state unexpectedly.
        return new Response(JSON.stringify({ enc: "not-a-real-sealed-payload" }), {
          status: 200,
          headers: { "x-loam-enc": "1" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);

      await expect(encryptedFetch("GET", "/api/channels")).rejects.toThrow("Transport session expired");

      expect(contentCalls).toBe(2);
      expect(handshakeCalls).toBe(2);
    });

    it("does NOT retry a decrypt failure on a mutating method — the server already applied it (docs/08)", async () => {
      // Unlike a 401 (refused before the handler ran), a response claiming `x-loam-enc: 1` means the
      // server's handler already executed and produced a reply — we just can't read it back. Retrying
      // a POST/PATCH/DELETE here would silently re-send (and the server would re-apply) the same
      // mutation. Only safe (GET/HEAD) methods may retry that case; this is the regression test.
      const host = createTransportIdentity();
      let contentCalls = 0;
      let handshakeCalls = 0;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          handshakeCalls += 1;
          return handshakeResponder(host)(url, init);
        }

        contentCalls += 1;
        return new Response(JSON.stringify({ enc: "not-a-real-sealed-payload" }), {
          status: 200,
          headers: { "x-loam-enc": "1" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);

      await expect(encryptedFetch("POST", "/api/messages", { text: "hi" })).rejects.toThrow(
        "Transport session expired",
      );

      // No retry at all: one content attempt, no additional (re-handshake) call.
      expect(contentCalls).toBe(1);
      expect(handshakeCalls).toBe(1);
    });

    it("concurrent 401s share ONE in-flight re-handshake (docs/20 §5.6/§9 — no multi-identity mint)", async () => {
      // Two parallel GETs both 401 on the same expired session. Without the in-flight guard each would
      // handshake independently (two fresh sessions/identities); with it they share one re-handshake.
      const host = createTransportIdentity();
      let handshakeCalls = 0;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          handshakeCalls += 1;
          return handshakeResponder(host)(url, init);
        }
        // Every content request 401s (unsealed → "transport expired"), so both fire their re-handshake.
        return new Response(null, { status: 401 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);
      expect(handshakeCalls).toBe(1);

      // Fire both concurrently: each 401s, each calls reHandshake — but they must coalesce into one.
      const [a, b] = await Promise.all([
        encryptedFetch("GET", "/api/channels"),
        encryptedFetch("GET", "/api/users"),
      ]);

      expect(a.status).toBe(401);
      expect(b.status).toBe(401);
      // Exactly one shared re-handshake for the burst: initial + 1, never initial + 2.
      expect(handshakeCalls).toBe(2);
    });
  });

  describe("mutations always carry a sealed envelope, even with no logical body (docs/08)", () => {
    it("seals an empty envelope for a bodyless mutation (POST/DELETE) under a live session", async () => {
      const host = createTransportIdentity();
      let capturedBody: unknown;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
          return new Response(JSON.stringify(json), { status });
        }

        capturedBody = init.body;
        return new Response(null, { status: 204 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);
      await encryptedFetch("POST", "/api/admin/sync/run", undefined);

      // A plaintext-injected mutation body is rejected server-side unless it's `{ enc }` — a bodyless
      // mutation must still carry a (empty) envelope, never a bare absent body, to pass that gate.
      expect(typeof capturedBody).toBe("string");
      const wire = JSON.parse(capturedBody as string) as { enc: string };
      expect(wire.enc).toBeTypeOf("string");

      const session = getSession();
      const opened = openTransport(session!.key, wire.enc, "POST /api/admin/sync/run");
      // A bodyless mutation still seals the `{ s }` anti-replay envelope (sequence only, no `b`).
      expect(JSON.parse(opened!)).toEqual({ s: 1 });
    });

    it("keeps a bodyless GET a pure passthrough under a live session (no envelope needed)", async () => {
      const host = createTransportIdentity();
      let capturedBody: unknown;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
          return new Response(JSON.stringify(json), { status });
        }

        capturedBody = init.body;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);
      await encryptedFetch("GET", "/api/channels");

      expect(capturedBody).toBeUndefined();
    });
  });

  describe("metadata-hiding tunnel (required mode, docs/08)", () => {
    it("routes every request through /api/transport/tunnel so the real path never hits the wire", async () => {
      const host = createTransportIdentity();
      // A QR key forces `required` mode → the tunnel.
      window.location.hash = `#k=${host.publicKey}`;
      let serverKey: string | undefined;
      let tunnelHits = 0;
      let capturedInner: { m: string; p: string; body?: unknown } | undefined;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          const accepted = transportServerAccept({
            hostSecret: host.secretKey,
            clientEphemeralPublic: (JSON.parse(init.body as string) as { clientEphemeralPublic: string })
              .clientEphemeralPublic,
          });
          serverKey = accepted.sessionKey;
          return new Response(
            JSON.stringify({ sessionId: "s", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey }),
            { status: 200 },
          );
        }
        // Anything else MUST be the opaque tunnel endpoint — never the real path.
        expect(url).toBe("/api/transport/tunnel");
        tunnelHits += 1;
        const wire = JSON.parse(init.body as string) as { enc: string };
        const opened = openTransport(serverKey!, wire.enc, "POST /api/transport/tunnel");
        const envelope = JSON.parse(opened!) as { s: number; b: { m: string; p: string; body?: unknown } };
        capturedInner = envelope.b;
        // Reply with a sealed { s, m, p, status, contentType, bodyB64 } descriptor (standard base64, as
        // the server sends). The s/m/p bind the response to the request (docs/20 §9); the client verifies.
        const descriptor = JSON.stringify({
          s: envelope.s,
          m: envelope.b.m,
          p: envelope.b.p,
          status: 200,
          contentType: "application/json",
          bodyB64: btoa(JSON.stringify({ ok: true, sawPath: envelope.b.p })),
        });
        return new Response(
          JSON.stringify({ enc: sealTransport(serverKey!, descriptor, "POST /api/transport/tunnel") }),
          { status: 200, headers: { "x-loam-enc": "1" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("required", host.publicKey);
      // A sensitive query string — the whole point of the tunnel is that `q=secret` never appears.
      const res = await encryptedFetch("GET", "/api/search?q=secret");

      expect(tunnelHits).toBe(1);
      expect(capturedInner).toEqual({ m: "GET", p: "/api/search?q=secret" });
      expect(await res.json()).toEqual({ ok: true, sawPath: "/api/search?q=secret" });
    });

    it("tunnels a mutation with its body sealed inside the envelope", async () => {
      const host = createTransportIdentity();
      window.location.hash = `#k=${host.publicKey}`;
      let serverKey: string | undefined;
      let capturedInner: { m: string; p: string; body?: unknown } | undefined;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          const accepted = transportServerAccept({
            hostSecret: host.secretKey,
            clientEphemeralPublic: (JSON.parse(init.body as string) as { clientEphemeralPublic: string })
              .clientEphemeralPublic,
          });
          serverKey = accepted.sessionKey;
          return new Response(
            JSON.stringify({ sessionId: "s", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey }),
            { status: 200 },
          );
        }
        expect(url).toBe("/api/transport/tunnel");
        const wire = JSON.parse(init.body as string) as { enc: string };
        const opened = openTransport(serverKey!, wire.enc, "POST /api/transport/tunnel");
        const envelope = JSON.parse(opened!) as { s: number; b: { m: string; p: string; body?: unknown } };
        capturedInner = envelope.b;
        const descriptor = JSON.stringify({
          s: envelope.s,
          m: envelope.b.m,
          p: envelope.b.p,
          status: 201,
          contentType: "application/json",
          bodyB64: btoa(JSON.stringify({ id: "msg_1" })),
        });
        return new Response(JSON.stringify({ enc: sealTransport(serverKey!, descriptor, "POST /api/transport/tunnel") }), {
          status: 200,
          headers: { "x-loam-enc": "1" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("required", host.publicKey);
      const res = await encryptedFetch("POST", "/api/messages", { type: "channelPost", channelId: "general", body: "hi" });

      // Method, path AND body all rode inside the sealed envelope — none on the wire path.
      expect(capturedInner).toEqual({ m: "POST", p: "/api/messages", body: { type: "channelPost", channelId: "general", body: "hi" } });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: "msg_1" });
    });

    it("surfaces a sealed non-descriptor tunnel reply as a 400 Response instead of crashing", async () => {
      const host = createTransportIdentity();
      window.location.hash = `#k=${host.publicKey}`;
      let serverKey: string | undefined;

      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          const accepted = transportServerAccept({
            hostSecret: host.secretKey,
            clientEphemeralPublic: (JSON.parse(init.body as string) as { clientEphemeralPublic: string })
              .clientEphemeralPublic,
          });
          serverKey = accepted.sessionKey;
          return new Response(
            JSON.stringify({ sessionId: "s", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey }),
            { status: 200 },
          );
        }
        // The tunnel endpoint's own guard reply: a sealed errorBody, NOT a { status, bodyB64 } descriptor.
        const sealedError = sealTransport(serverKey!, JSON.stringify({ error: { message: "Invalid tunnel target" } }), "POST /api/transport/tunnel");
        return new Response(JSON.stringify({ enc: sealedError }), { status: 200, headers: { "x-loam-enc": "1" } });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("required", host.publicKey);
      const res = await encryptedFetch("GET", "/api/whatever");
      expect(res.status).toBe(400); // no throw; readable error Response
      expect(await res.json()).toEqual({ error: { message: "Invalid tunnel target" } });
    });
  });

  describe("resumeIdentity (docs/20 sealed identity binding)", () => {
    const RESUME_AAD = "POST /api/session/resume";

    /** A mock node that handshakes and answers `/api/session/resume`. `resume(token)` returns what the
     *  server should reply with, given the token the client presented (undefined = first-contact mint). */
    function mockNode(
      host: ReturnType<typeof createTransportIdentity>,
      resume: (token: string | undefined, serverKey: string, seq: number) => Response,
    ) {
      let serverKey: string | undefined;
      return vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          const accepted = transportServerAccept({
            hostSecret: host.secretKey,
            clientEphemeralPublic: (JSON.parse(init.body as string) as { clientEphemeralPublic: string }).clientEphemeralPublic,
          });
          serverKey = accepted.sessionKey;
          return new Response(
            JSON.stringify({ sessionId: "s", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey }),
            { status: 200 },
          );
        }
        expect(url).toBe("/api/session/resume");
        const opened = openTransport(serverKey!, (JSON.parse(init.body as string) as { enc: string }).enc, RESUME_AAD);
        const envelope = JSON.parse(opened!) as { s: number; b: { token?: string } };
        return resume(envelope.b.token, serverKey!, envelope.s);
      });
    }

    function sealedReply(serverKey: string, body: unknown, status = 200): Response {
      return new Response(JSON.stringify({ enc: sealTransport(serverKey, JSON.stringify(body), RESUME_AAD) }), {
        status,
        headers: { "x-loam-enc": "1" },
      });
    }

    it("mints a fresh identity, stores the token, and returns currentUser (credentials omitted)", async () => {
      const host = createTransportIdentity();
      window.location.hash = `#k=${host.publicKey}`;
      let sawCredentials: RequestCredentials | undefined;
      const fetchMock = vi.fn(mockNode(host, (token, key, seq) => {
        expect(token).toBeUndefined(); // first contact: no stored token
        return sealedReply(key, { s: seq, m: "POST", p: "/api/session/resume", currentUser: { id: "user.aaaa" }, token: "tok-aaaa" });
      }));
      // Wrap to capture credentials on the resume call.
      const wrapped = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/session/resume") sawCredentials = init.credentials;
        return fetchMock(url, init);
      });
      vi.stubGlobal("fetch", wrapped);

      await ensureSession("required", host.publicKey);
      const { currentUser } = await resumeIdentity();
      expect(currentUser).toEqual({ id: "user.aaaa" });
      expect(sawCredentials).toBe("omit"); // the cookie is never sent on a bound resume
      // The stored token is presented on a subsequent resume.
      expect(getSession()?.bound).toBe(true);
    });

    it("rejects a response whose s/m/p don't match the request (response binding, docs/20 §9)", async () => {
      const host = createTransportIdentity();
      window.location.hash = `#k=${host.publicKey}`;
      const fetchMock = mockNode(host, (_token, key, seq) =>
        // Wrong sequence echoed back — a cross-fed reply. The client must refuse it.
        sealedReply(key, { s: seq + 99, m: "POST", p: "/api/session/resume", currentUser: { id: "x" }, token: "t" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("required", host.publicKey);
      await expect(resumeIdentity()).rejects.toThrow(/did not match/);
    });

    it("clears a rejected stored token and mints fresh exactly once", async () => {
      const host = createTransportIdentity();
      window.location.hash = `#k=${host.publicKey}`;
      // Seed a stored token for this origin so the first resume presents it.
      localStorage.setItem(`loam.identityToken.${window.location.origin}`, "stale-token");
      const presented: (string | undefined)[] = [];
      const fetchMock = mockNode(host, (token, key, seq) => {
        presented.push(token);
        if (token !== undefined) {
          // The stale token is rejected with a SEALED 401 (from the handler, after decrypt).
          return sealedReply(key, { error: { message: "Invalid identity token" } }, 401);
        }
        return sealedReply(key, { s: seq, m: "POST", p: "/api/session/resume", currentUser: { id: "user.new" }, token: "fresh" });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("required", host.publicKey);
      const { currentUser } = await resumeIdentity();
      expect(presented).toEqual(["stale-token", undefined]); // tried stale, then minted fresh
      expect(currentUser).toEqual({ id: "user.new" });
    });

    it("logoutSecureIdentity revokes server-side and clears the local token", async () => {
      const host = createTransportIdentity();
      window.location.hash = `#k=${host.publicKey}`;
      let serverKey: string | undefined;
      let logoutHits = 0;
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          const accepted = transportServerAccept({
            hostSecret: host.secretKey,
            clientEphemeralPublic: (JSON.parse(init.body as string) as { clientEphemeralPublic: string }).clientEphemeralPublic,
          });
          serverKey = accepted.sessionKey;
          return new Response(
            JSON.stringify({ sessionId: "s", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey }),
            { status: 200 },
          );
        }
        if (url === "/api/session/resume") {
          const opened = openTransport(serverKey!, (JSON.parse(init.body as string) as { enc: string }).enc, RESUME_AAD);
          const seq = (JSON.parse(opened!) as { s: number }).s;
          return sealedReply(serverKey!, { s: seq, m: "POST", p: "/api/session/resume", currentUser: { id: "u" }, token: "tok" });
        }
        expect(url).toBe("/api/session/logout");
        expect(init.credentials).toBe("omit");
        logoutHits += 1;
        return new Response(JSON.stringify({ enc: sealTransport(serverKey!, JSON.stringify({ ok: true }), "POST /api/session/logout") }), {
          status: 200,
          headers: { "x-loam-enc": "1" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("required", host.publicKey);
      await resumeIdentity();
      expect(localStorage.getItem(`loam.identityToken.${window.location.origin}`)).toBe("tok");

      await logoutSecureIdentity();
      expect(logoutHits).toBe(1);
      expect(localStorage.getItem(`loam.identityToken.${window.location.origin}`)).toBeNull();
    });

    it("clearStoredIdentityToken drops the per-origin token", async () => {
      localStorage.setItem(`loam.identityToken.${window.location.origin}`, "tok");
      clearStoredIdentityToken();
      expect(localStorage.getItem(`loam.identityToken.${window.location.origin}`)).toBeNull();
    });
  });

  describe("encryptedImageUrl", () => {
    it("is a raw same-origin passthrough when not tunnelling (no session)", async () => {
      expect(isTunnelActive()).toBe(false);
      expect(await encryptedImageUrl("/api/avatars/x.webp")).toBe("/api/avatars/x.webp");
    });

    it("reports the tunnel active only once a required-mode session exists", async () => {
      const host = createTransportIdentity();
      window.location.hash = `#k=${host.publicKey}`;
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
        return new Response(JSON.stringify(json), { status });
      });
      vi.stubGlobal("fetch", fetchMock);

      expect(isTunnelActive()).toBe(false);
      await ensureSession("required", host.publicKey);
      expect(isTunnelActive()).toBe(true);
    });

    it("FAILS CLOSED under the tunnel: a failed image fetch returns '' — never the raw plaintext URL (docs/20)", async () => {
      const host = createTransportIdentity();
      window.location.hash = `#k=${host.publicKey}`;
      let serverKey: string | undefined;
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          const accepted = transportServerAccept({
            hostSecret: host.secretKey,
            clientEphemeralPublic: (JSON.parse(init.body as string) as { clientEphemeralPublic: string }).clientEphemeralPublic,
          });
          serverKey = accepted.sessionKey;
          return new Response(
            JSON.stringify({ sessionId: "s", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey }),
            { status: 200 },
          );
        }
        // The tunnelled image GET fails at the server (e.g. transport session expired) — a sealed 404-ish
        // descriptor with a non-ok status, so the tunnel returns a non-ok Response.
        const opened = openTransport(serverKey!, (JSON.parse(init.body as string) as { enc: string }).enc, "POST /api/transport/tunnel");
        const envelope = JSON.parse(opened!) as { s: number; b: { m: string; p: string } };
        const descriptor = JSON.stringify({
          s: envelope.s,
          m: envelope.b.m,
          p: envelope.b.p,
          status: 404,
          contentType: "application/json",
          bodyB64: btoa(JSON.stringify({ error: { message: "gone" } })),
        });
        return new Response(JSON.stringify({ enc: sealTransport(serverKey!, descriptor, "POST /api/transport/tunnel") }), {
          status: 200,
          headers: { "x-loam-enc": "1" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("required", host.publicKey);
      expect(isTunnelActive()).toBe(true);
      // The image can't be fetched → empty src, NOT a downgraded direct GET to the plaintext URL.
      expect(await encryptedImageUrl("/api/avatars/x.webp")).toBe("");
    });
  });

  describe("wsUrl", () => {
    it("passes the base URL through unchanged with no session", () => {
      expect(wsUrl("ws://host/ws")).toBe("ws://host/ws");
    });

    it("appends ?enc=<sessionId> once a session is live", async () => {
      const host = createTransportIdentity();
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
        return new Response(JSON.stringify(json), { status });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);

      expect(wsUrl("ws://host/ws")).toBe(`ws://host/ws?enc=${encodeURIComponent("sess-1")}`);
      expect(wsUrl("ws://host/ws?foo=bar")).toBe(`ws://host/ws?foo=bar&enc=${encodeURIComponent("sess-1")}`);
    });
  });

  describe("handleWsFrame (docs/20 §7 key-confirmation + connection binding)", () => {
    const WS_CHALLENGE_AAD = "loam.ws.challenge.v1";
    const WS_PROOF_AAD = "loam.ws.proof.v1";
    const wsFrameAad = (connectionId: string) => `loam.ws.frame.v1 ${connectionId}`;

    async function liveSession(): Promise<string> {
      const host = createTransportIdentity();
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
        return new Response(JSON.stringify(json), { status });
      });
      vi.stubGlobal("fetch", fetchMock);
      await ensureSession("optional", host.publicKey);
      const key = getSession()?.key;
      expect(key).toBeDefined();
      // A new socket resets the per-connection challenge state.
      wsUrl("ws://host/ws");
      return key as string;
    }

    it("passes raw string frames through unchanged with no session", () => {
      expect(handleWsFrame("plain frame")).toEqual({ payload: "plain frame" });
      expect(handleWsFrame(42)).toEqual({ payload: "42" });
    });

    it("answers the challenge with a proof under the separate proof aad, then decodes app frames", async () => {
      const key = await liveSession();
      const connectionId = "conn-abc";
      const nonce = "nonce-xyz";

      // The server's challenge (sealed under the challenge aad).
      const challenge = sealTransport(key, JSON.stringify({ type: "challenge", connectionId, nonce }), WS_CHALLENGE_AAD);
      const answered = handleWsFrame(challenge);
      expect(answered.proof).toBeDefined();
      expect(answered.payload).toBeUndefined();
      // The proof opens under the PROOF aad (not the challenge aad — direction separation) and echoes it.
      const proofPlain = openTransport(key, answered.proof as string, WS_PROOF_AAD);
      expect(JSON.parse(proofPlain as string)).toEqual({ type: "proof", connectionId, nonce });

      // A connection-bound application frame `{ q, f }` now decodes to its inner payload.
      const frame = sealTransport(key, JSON.stringify({ q: 1, f: JSON.stringify({ type: "presence" }) }), wsFrameAad(connectionId));
      expect(handleWsFrame(frame)).toEqual({ payload: JSON.stringify({ type: "presence" }) });

      // A replayed (non-advancing) sequence is dropped.
      expect(handleWsFrame(frame)).toEqual({});
    });

    it("ignores frames before the challenge is answered and rejects a wrong-connection frame", async () => {
      const key = await liveSession();
      // An application frame arriving before any challenge (wrong aad for the pre-confirm state) is ignored.
      const stray = sealTransport(key, JSON.stringify({ q: 1, f: "x" }), wsFrameAad("conn-1"));
      expect(handleWsFrame(stray)).toEqual({});
      expect(handleWsFrame("garbage")).toEqual({});

      // Answer a challenge for conn-1, then a frame sealed for a DIFFERENT connection id won't open.
      const challenge = sealTransport(key, JSON.stringify({ type: "challenge", connectionId: "conn-1", nonce: "n" }), WS_CHALLENGE_AAD);
      expect(handleWsFrame(challenge).proof).toBeDefined();
      const otherConn = sealTransport(key, JSON.stringify({ q: 1, f: "y" }), wsFrameAad("conn-2"));
      expect(handleWsFrame(otherConn)).toEqual({});
    });
  });

  describe("fingerprint", () => {
    it("is undefined with no session and no explicit key", () => {
      expect(fingerprint()).toBeUndefined();
    });

    it("is defined for an explicit key, and defaults to the live session's host key", async () => {
      const host = createTransportIdentity();
      expect(fingerprint(host.publicKey)).toBeTypeOf("string");

      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const { status, json } = handshakeResponseBody(host.secretKey, host.publicKey, init.body as string);
        return new Response(JSON.stringify(json), { status });
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureSession("optional", host.publicKey);
      expect(fingerprint()).toBe(fingerprint(host.publicKey));
    });
  });
});
