import { afterEach, describe, expect, it, vi } from "vitest";

import { openTransport, sealTransport, transportClientDerive, transportClientHello } from "@loam/crypto";
import { TransportHandshakeResponseSchema } from "@loam/schema";

import type { LoamApp } from "./app.js";
import { type InjectResponse, makeApp, newSession, teardownApps } from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("security hardening", () => {
  it("GET /api/health returns ok without minting a session or consuming firstUser admin", async () => {
    const app = await makeApp();

    const health = await app.server.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect(health.headers["set-cookie"]).toBeUndefined();

    const first = await newSession(app);
    expect(first.isAdmin).toBe(true);
  });

  it("sets security headers (nosniff always, CSP on the app shell only)", async () => {
    const app = await makeApp();

    const api = await app.server.inject({ method: "GET", url: "/api/health" });
    expect(api.headers["x-content-type-options"]).toBe("nosniff");
    expect(api.headers["content-security-policy"]).toBeUndefined();

    const shell = await app.server.inject({ method: "GET", url: "/" });
    expect(shell.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(shell.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  });

  it("blocks a banned user from editing their profile", async () => {
    const app = await makeApp({ identity: { allowUserDisplayNameEdit: true } });
    const admin = await newSession(app);
    const target = await newSession(app);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const edit = await app.server.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie: target.cookie },
      payload: { displayName: "Ban Evader" },
    });
    expect(edit.statusCode).toBe(403);
  });

  it("rejects an over-long message body but keeps normal ones", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    const huge = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "x".repeat(8001) },
    });
    expect(huge.statusCode).toBe(400);

    const ok = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "x".repeat(8000) },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("does not mark the session cookie Secure on the plain-http LAN", async () => {
    // The injected request is plain http (no TLS socket, trustProxy off), so the cookie must NOT be
    // Secure — a Secure cookie would be dropped by the browser and break the session. The flag
    // flips only when request.protocol is genuinely https (a self-hoster behind a TLS proxy enables
    // trustProxy for that); we deliberately don't trust a spoofable x-forwarded-proto header.
    const app = await makeApp();

    const plain = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(String(plain.headers["set-cookie"])).toContain("loam_session=");
    expect(String(plain.headers["set-cookie"])).not.toContain("Secure");
  });
});

describe("request validation and error bodies", () => {
  async function post(app: LoamApp, cookie: string, payload: Record<string, unknown>): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  it("answers a repeated search param with a 400, and any 5xx with a generic body (detail only logged)", async () => {
    const app = await makeApp();
    app.server.get("/api/test-boom", async () => {
      throw new Error("secret internal detail");
    });
    app.server.get("/api/test-teapot", async () => {
      throw Object.assign(new Error("short and stout"), { statusCode: 418 });
    });
    const user = await newSession(app);

    const dup = await app.server.inject({ method: "GET", url: "/api/search?q=a&q=b", headers: { cookie: user.cookie } });
    expect(dup.statusCode).toBe(400);
    expect(dup.json()).toMatchObject({ code: "invalid_request" });
    expect(dup.body).not.toContain("trim");

    const boom = await app.server.inject({ method: "GET", url: "/api/test-boom" });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: "Internal server error", code: "internal_error" });
    expect(boom.body).not.toContain("secret");

    // A 4xx keeps Fastify's default handling (its message is part of the contract there).
    const teapot = await app.server.inject({ method: "GET", url: "/api/test-teapot" });
    expect(teapot.statusCode).toBe(418);
    expect(teapot.body).toContain("short and stout");
  });

  it("rejects an over-long id at the request boundary (schema 400, not a lookup miss)", async () => {
    const app = await makeApp();
    const user = await newSession(app);
    const res = await post(app, user.cookie, { type: "reaction", targetMessageId: "m".repeat(129), reaction: "👍" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_message_request" });
  });
});

describe("rate limiter housekeeping", () => {
  it("prunes expired per-IP rate-limiter entries so the maps stay bounded", async () => {
    // setupCode bootstrap so a claim attempt populates the claim limiter; minting a session
    // populates the identity budget. Both key on the caller IP.
    const app = await makeApp({ admin: { bootstrap: "setupCode" } });
    await newSession(app);
    const rejected = await app.server.inject({
      method: "POST",
      url: "/api/admin/claim",
      payload: { secret: "wrong" },
    });
    expect(rejected.statusCode).toBe(403);

    const before = app.rateLimiterEntryCounts();
    expect(before.identity).toBeGreaterThan(0);
    expect(before.claim).toBeGreaterThan(0);

    // Advance the clock past both windows (claim 5 min, identity 10 min), then prune. Expired entries
    // must be dropped, not linger one-per-IP forever.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      app.pruneExpiredRateLimiters();
    } finally {
      vi.useRealTimers();
    }

    const after = app.rateLimiterEntryCounts();
    expect(after.identity).toBe(0);
    expect(after.claim).toBe(0);
  });
});

/** Handshake + bind a transport session (docs/08 + docs/20) — the first identity on a firstUser node is its
 *  admin — and return a sender for requests through the sealed tunnel. */
async function boundTunnel(app: LoamApp): Promise<(method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>> {
  const hello = transportClientHello();
  const handshake = TransportHandshakeResponseSchema.parse(
    (
      await app.server.inject({
        method: "POST",
        url: "/api/transport/handshake",
        payload: { clientEphemeralPublic: hello.ephemeralPublic },
      })
    ).json(),
  );
  const key = transportClientDerive({
    clientEphemeralSecret: hello.ephemeralSecret,
    hostPublic: handshake.hostPublicKey,
    hostEphemeralPublic: handshake.hostEphemeralPublic,
  });
  let seq = 0;
  const sealed = (path: string, body: unknown) =>
    app.server.inject({
      method: "POST",
      url: path,
      headers: { "x-loam-enc": handshake.sessionId, "content-type": "application/json" },
      payload: { enc: sealTransport(key, JSON.stringify({ s: ++seq, b: body }), `POST ${path}`) },
    });
  expect((await sealed("/api/session/resume", {})).statusCode).toBe(200);
  return async (method, path, body) => {
    const res = await sealed("/api/transport/tunnel", { m: method, p: path, ...(body === undefined ? {} : { body }) });
    const opened = openTransport(key, (res.json() as { enc: string }).enc, "POST /api/transport/tunnel");
    const descriptor = JSON.parse(opened as string) as { status: number; bodyB64: string };
    const text = Buffer.from(descriptor.bodyB64, "base64").toString("utf8");
    return { status: descriptor.status, json: text ? (JSON.parse(text) as unknown) : undefined };
  };
}

describe("request logs never reveal tunnelled paths or query strings", () => {
  /** An app whose logs are captured line-by-line. */
  async function makeLoggedApp(): Promise<{ app: LoamApp; logs: string[] }> {
    const logs: string[] = [];
    const { app } = await makeApp(undefined, { logger: true, logStream: { write: (line) => void logs.push(line) } });
    return { app, logs };
  }

  it("a tunnelled request's real path + query never reach the log; the outer tunnel request does", async () => {
    const { app, logs } = await makeLoggedApp();
    const tunnel = await boundTunnel(app);
    expect((await tunnel("GET", "/api/search?q=TUNNELLED_SECRET_TERM")).status).toBe(200);
    const text = logs.join("");
    expect(text).toContain("/api/transport/tunnel");
    expect(text).not.toContain("TUNNELLED_SECRET_TERM");
    expect(text).not.toContain("/api/search");
  });

  it("Fastify's own double-send warning doesn't name the (tunnelled) path or its query", async () => {
    const { app, logs } = await makeLoggedApp();
    // Tunnelled: the path itself is secret. Direct: the path is on the wire anyway, the query isn't logged.
    for (const path of ["/api/test/double-send-PATH_SECRET", "/api/test/double-send"]) {
      app.server.get(path, (_request, reply) => {
        void reply.send({ first: true });
        void reply.send({ second: true });
      });
    }
    const tunnel = await boundTunnel(app);
    expect((await tunnel("GET", "/api/test/double-send-PATH_SECRET?q=TUNNEL_QUERY_SECRET")).status).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/test/double-send?q=DIRECT_QUERY_SECRET" })).statusCode).toBe(200);
    const text = logs.join("");
    expect(text).toContain("Reply was already sent");
    expect(text).not.toContain("PATH_SECRET");
    expect(text).not.toContain("QUERY_SECRET");
  });

  it("strips the query string from every logged request URL", async () => {
    const { app, logs } = await makeLoggedApp();
    expect((await app.server.inject({ method: "GET", url: "/api/health?probe=DIRECT_QUERY_SECRET" })).statusCode).toBe(200);
    const text = logs.join("");
    expect(text).toContain("/api/health");
    expect(text).not.toContain("DIRECT_QUERY_SECRET");
  });
});
