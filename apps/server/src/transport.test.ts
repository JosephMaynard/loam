import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openTransport, sealTransport, transportClientDerive, transportClientHello } from "@loam/crypto";
import { TransportHandshakeResponseSchema } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import {
  cleanups,
  type InjectResponse,
  makeApp,
  newSession,
  openTransport08,
  reopenApp,
  resumeIdentity,
  sealSeq,
  teardownApps,
  tunnelInner,
} from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("secure by default + Developer Mode", () => {
  const DEV_ENV = "LOAM_DEV_MODE";
  const NODE_ENV = "NODE_ENV";
  let savedDev: string | undefined;
  let savedNode: string | undefined;
  beforeEach(() => {
    savedDev = process.env[DEV_ENV];
    savedNode = process.env[NODE_ENV];
    delete process.env[DEV_ENV];
    delete process.env[NODE_ENV];
  });
  afterEach(() => {
    if (savedDev === undefined) delete process.env[DEV_ENV];
    else process.env[DEV_ENV] = savedDev;
    if (savedNode === undefined) delete process.env[NODE_ENV];
    else process.env[NODE_ENV] = savedNode;
  });

  it("a fresh node encrypts by default (transportEncryption 'optional', devMode false)", async () => {
    const app = await makeApp(); // no config → raw defaults
    const cfg = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string; transportPublicKey?: string; devMode: boolean };
    };
    expect(cfg.networkConfig.transportEncryption).toBe("optional");
    expect(cfg.networkConfig.devMode).toBe(false);
    // ...and the handshake works out of the box (optional advertises the host key).
    expect(cfg.networkConfig.transportPublicKey).toBeDefined();
    const hello = transportClientHello();
    const res = await app.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: hello.ephemeralPublic },
    });
    expect(res.statusCode).toBe(200);
  });

  it("every named profile encrypts: open + standard advertise 'optional' in plaintext /api/config", async () => {
    for (const profile of ["open", "standard"] as const) {
      const app = await makeApp({ security: { profile } });
      const cfg = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
        networkConfig: { transportEncryption: string };
      };
      expect(cfg.networkConfig.transportEncryption).toBe("optional");
    }
  });

  it("the hardened profile requires encryption: plaintext /api/config is 401'd", async () => {
    const app = await makeApp({ security: { profile: "hardened" } });
    const res = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(401);
  });

  it("LOAM_DEV_MODE forces plaintext + advertises devMode, overriding an encrypting config", async () => {
    process.env[DEV_ENV] = "1";
    // Even a hardened node is forced to plaintext in Developer Mode.
    const app = await makeApp({ security: { profile: "hardened" } });
    const cfg = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string; transportPublicKey?: string; devMode: boolean };
    };
    expect(cfg.networkConfig.devMode).toBe(true);
    expect(cfg.networkConfig.transportEncryption).toBe("off");
    expect(cfg.networkConfig.transportPublicKey).toBeUndefined();
    // The handshake is disabled (plaintext path), matching a real 'off' node.
    const res = await app.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: transportClientHello().ephemeralPublic },
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses to engage Developer Mode in a production build (NODE_ENV=production)", async () => {
    process.env[DEV_ENV] = "1";
    process.env[NODE_ENV] = "production";
    const app = await makeApp(); // defaults → optional, and dev mode must NOT downgrade it
    const cfg = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string; devMode: boolean };
    };
    expect(cfg.networkConfig.devMode).toBe(false);
    expect(cfg.networkConfig.transportEncryption).toBe("optional");
  });

  it("never bakes dev-mode plaintext into the persisted config (survives a non-dev reopen)", async () => {
    // Regression: a dev-mode override that MUTATED appConfig used to leak "off" into the stored config via a
    // later PATCH, so re-running that data dir without dev mode served silent plaintext (no banner). The
    // override is now a read-time projection, so appConfig (persisted) always carries operator intent.
    process.env[DEV_ENV] = "1";
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const dataDir = app.dataDir;
    const admin = await newSession(app);
    expect(admin.isAdmin).toBe(true);

    // Dev mode is active and forcing plaintext at runtime...
    const devCfg = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string; devMode: boolean };
    };
    expect(devCfg.networkConfig.devMode).toBe(true);
    expect(devCfg.networkConfig.transportEncryption).toBe("off");

    // ...and an admin PATCH that doesn't touch `security` (the exact trigger of the old bug).
    const patched = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { features: { enableReactions: false } },
    });
    expect(patched.statusCode).toBe(200);

    // Reopen the SAME data dir WITHOUT dev mode — a real, non-dev run.
    delete process.env[DEV_ENV];
    const reopened = await reopenApp(app, dataDir);
    const cfg = (await reopened.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string; devMode: boolean };
    };
    // Operator intent preserved — encrypted, not plaintext — and no dev mode.
    expect(cfg.networkConfig.devMode).toBe(false);
    expect(cfg.networkConfig.transportEncryption).toBe("optional");
  });
});

describe("transportEncryption off is Developer-Mode-only", () => {
  it("refuses PATCH security.transportEncryption 'off' (400, nothing persisted)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const res = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { profile: "custom", transportEncryption: "off" } },
    });
    expect(res.statusCode).toBe(400);
    const cfg = (await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).json() as {
      networkConfig: { transportEncryption: string };
    };
    expect(cfg.networkConfig.transportEncryption).toBe("optional");
  });

  it("coerces a config.json 'off' to 'optional' (and still boots)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "off" } });
    const cfg = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string; transportPublicKey?: string; devMode: boolean };
    };
    expect(cfg.networkConfig.transportEncryption).toBe("optional");
    expect(cfg.networkConfig.transportPublicKey).toBeDefined();
    expect(cfg.networkConfig.devMode).toBe(false);
  });

  it("coerces a persisted (DB) 'off' to 'optional' at load", async () => {
    const { app, dataDir } = await makeApp();
    app.store.setConfigValue("config", JSON.stringify({ security: { profile: "custom", transportEncryption: "off" } }));
    const reopened = await reopenApp(app, dataDir);
    const cfg = (await reopened.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string };
    };
    expect(cfg.networkConfig.transportEncryption).toBe("optional");
  });
});

describe("transport encryption foundation", () => {
  it("404s the handshake and advertises no host key when transport encryption is off", async () => {
    // `off` is not a configurable posture any more; Developer Mode (here via the test-only option) is the
    // only way to run plaintext.
    const app = await makeApp(undefined, { devMode: true });
    const hello = transportClientHello();
    const res = await app.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: hello.ephemeralPublic },
    });
    expect(res.statusCode).toBe(404);

    const cfg = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string; transportPublicKey?: string };
    };
    expect(cfg.networkConfig.transportEncryption).toBe("off");
    expect(cfg.networkConfig.transportPublicKey).toBeUndefined();
  });

  it("completes a handshake and matches the host key advertised in /api/config", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const hello = transportClientHello();
    const res = await app.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: hello.ephemeralPublic },
    });
    expect(res.statusCode).toBe(200);
    const body = TransportHandshakeResponseSchema.parse(res.json());

    const cfg = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { transportEncryption: string; transportPublicKey?: string };
    };
    expect(cfg.networkConfig.transportEncryption).toBe("optional");
    expect(cfg.networkConfig.transportPublicKey).toBe(body.hostPublicKey);

    // The client can finish the handshake to a 32-byte session key.
    const key = transportClientDerive({
      clientEphemeralSecret: hello.ephemeralSecret,
      hostPublic: body.hostPublicKey,
      hostEphemeralPublic: body.hostEphemeralPublic,
    });
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A malformed client key is a clean 400, never a 500.
    const bad = await app.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: "!!!not-base64!!!" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("persists the host transport key across a restart (stable join QR)", async () => {
    const { app, dataDir } = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const keyOf = async (target: LoamApp) =>
      (
        (await target.server.inject({ method: "GET", url: "/api/config" })).json() as {
          networkConfig: { transportPublicKey?: string };
        }
      ).networkConfig.transportPublicKey;

    const before = await keyOf(app);
    expect(before).toBeTruthy();
    const reopened = await reopenApp(app, dataDir);
    expect(await keyOf(reopened)).toBe(before);
  });

  it("a named profile forces the transport axis (hardened → required)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: "/api/admin/config",
          headers: { cookie: admin.cookie },
          payload: { security: { profile: "hardened" } },
        })
      ).statusCode,
    ).toBe(200);
    // After the switch to `required`, `/api/config` is tunnel-only content (docs/20) — the forced axis
    // is read from the public, cookie-free bootstrap instead.
    const cfg = (
      await app.server.inject({ method: "GET", url: "/api/bootstrap" })
    ).json() as { networkConfig: { transportEncryption: string; transportPublicKey?: string } };
    expect(cfg.networkConfig.transportEncryption).toBe("required");
    expect(cfg.networkConfig.transportPublicKey).toBeTruthy(); // now advertised
  });

  const keyOf = async (target: LoamApp) =>
    (
      (await target.server.inject({ method: "GET", url: "/api/config" })).json() as {
        networkConfig: { transportPublicKey?: string };
      }
    ).networkConfig.transportPublicKey;

  it("regenerates the transport identity if the persisted record is unparsable JSON", async () => {
    const { app, dataDir } = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const before = await keyOf(app);
    expect(before).toBeTruthy();

    app.store.setConfigValue("transportIdentity", "{ this is not json");

    const reopened = await reopenApp(app, dataDir);
    const after = await keyOf(reopened);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    // The regenerated identity is actually usable for a real handshake, not just non-empty.
    const hello = transportClientHello();
    const hs = await reopened.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: hello.ephemeralPublic },
    });
    expect(hs.statusCode).toBe(200);
  });

  it("regenerates the transport identity if the persisted record parses but has the wrong shape", async () => {
    const { app, dataDir } = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const before = await keyOf(app);

    // Valid JSON, but not `{ publicKey, secretKey }` — e.g. a truncated write, or an empty key.
    app.store.setConfigValue("transportIdentity", JSON.stringify({ publicKey: "", secretKey: "" }));
    const reopenedA = await reopenApp(app, dataDir);
    const afterA = await keyOf(reopenedA);
    expect(afterA).toBeTruthy();
    expect(afterA).not.toBe(before);

    reopenedA.store.setConfigValue("transportIdentity", JSON.stringify({ unrelated: "shape" }));
    const reopenedB = await reopenApp(reopenedA, dataDir);
    const afterB = await keyOf(reopenedB);
    expect(afterB).toBeTruthy();
    expect(afterB).not.toBe(afterA);
  });

  it("bounds the live transport session map: the oldest sessions are evicted once at the cap", async () => {
    // A real 5,000-session cap would make this test slow, so it's configured down via
    // `transportSessionCap` (mirrors the existing `maxNewIdentitiesPerWindow` testability pattern).
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ security: { profile: "custom", transportEncryption: "optional" } }),
    );
    const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, transportSessionCap: 3 });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    async function handshake(): Promise<{ sessionId: string; key: string }> {
      const hello = transportClientHello();
      const res = await app.server.inject({
        method: "POST",
        url: "/api/transport/handshake",
        payload: { clientEphemeralPublic: hello.ephemeralPublic },
      });
      const body = TransportHandshakeResponseSchema.parse(res.json());
      return {
        sessionId: body.sessionId,
        key: transportClientDerive({
          clientEphemeralSecret: hello.ephemeralSecret,
          hostPublic: body.hostPublicKey,
          hostEphemeralPublic: body.hostEphemeralPublic,
        }),
      };
    }

    const first = await handshake();
    await handshake();
    await handshake();
    // The map is now at the cap (3). A 4th handshake must evict the oldest (`first`) to make room.
    await handshake();

    const user = await newSession(app);
    const usingFirst = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: user.cookie, "x-loam-enc": first.sessionId },
    });
    // The oldest session was evicted: its id is now unknown, refused exactly like any expired session.
    expect(usingFirst.statusCode).toBe(401);
  });

  it("evicts anonymous sessions before bound ones, so a handshake flood can't push out a signed-in device", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } }, { transportSessionCap: 3 });
    const signedIn = await openTransport08(app);
    expect((await resumeIdentity(app, signedIn, 1)).status).toBe(200);
    const flood: { sessionId: string; key: string }[] = [];
    for (let i = 0; i < 6; i += 1) {
      flood.push(await openTransport08(app));
    }

    // The bound session survives the flood and still reaches content through the tunnel...
    const users = await tunnelInner(app, signedIn, 2, { m: "GET", p: "/api/users" });
    expect(users.outerStatus).toBe(200);
    expect(users.status).toBe(200);
    // ...while the oldest anonymous ones made room for the newest.
    const evicted = await app.server.inject({
      method: "POST",
      url: "/api/session/resume",
      headers: { "x-loam-enc": flood[0]!.sessionId, "content-type": "application/json" },
      payload: { enc: sealSeq(flood[0]!.key, 1, "POST /api/session/resume", {}) },
    });
    expect(evicted.statusCode).toBe(401);
    expect((await resumeIdentity(app, flood[5]!, 1)).status).toBe(200);
  });

  it("answers a repeat resume on a bound session with the cached identity, never a second one", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openTransport08(app);
    const first = await resumeIdentity(app, session, 1);
    const again = await resumeIdentity(app, session, 2);
    expect(again.status).toBe(200);
    expect(again.currentUser.id).toBe(first.currentUser.id);
    expect(again.token).toBe(first.token);
  });
});

describe("transport encryption transparent round-trip", () => {
  /** Establish a transport session and return { sessionId, key } for encrypting requests. */
  async function openSession(app: LoamApp): Promise<{ sessionId: string; key: string }> {
    const hello = transportClientHello();
    const res = await app.server.inject({
      method: "POST",
      url: "/api/transport/handshake",
      payload: { clientEphemeralPublic: hello.ephemeralPublic },
    });
    const body = TransportHandshakeResponseSchema.parse(res.json());
    return {
      sessionId: body.sessionId,
      key: transportClientDerive({
        clientEphemeralSecret: hello.ephemeralSecret,
        hostPublic: body.hostPublicKey,
        hostEphemeralPublic: body.hostEphemeralPublic,
      }),
    };
  }

  /** Seal a request into the `{ s, b? }` envelope the server expects (docs/08), at an explicit
   * sequence number so replay/ordering tests can control it. `body` omitted → a bodyless envelope. */
  function sealRequest(key: string, seq: number, aad: string, body?: unknown): string {
    return sealTransport(key, JSON.stringify(body === undefined ? { s: seq } : { s: seq, b: body }), aad);
  }

  it("encrypts request bodies and responses transparently (content never on the wire)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);

    const method = "POST";
    const url = "/api/messages";
    const aad = `${method} ${url}`;
    const secret = "rendezvous at the old mill at dawn";
    const res = await app.server.inject({
      method,
      url,
      headers: { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealRequest(session.key, 1, aad, { type: "channelPost", channelId: "general", body: secret }) },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers["x-loam-enc"]).toBe("1");
    // The plaintext is NOWHERE in the raw response...
    expect(res.body).not.toContain("rendezvous");
    // ...but decrypts to the created message.
    const opened = openTransport(session.key, (res.json() as { enc: string }).enc, aad);
    expect(opened).not.toBeNull();
    expect((JSON.parse(opened as string) as { message: { body: string } }).message.body).toBe(secret);
  });

  it("binds a direct sealed response to the request's sequence when the envelope asks (r: 1)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    const headers = { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" };
    const enc = (res: InjectResponse) => (res.json() as { enc: string }).enc;

    // A GET carries its `{ s, r }` envelope in the x-loam-seq header; the answer opens only under `#s`.
    const getAad = "GET /api/channels";
    const listed = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { ...headers, "x-loam-seq": sealTransport(session.key, JSON.stringify({ s: 1, r: 1 }), getAad) },
    });
    expect(listed.statusCode).toBe(200);
    expect(openTransport(session.key, enc(listed), `${getAad}#1`)).not.toBeNull();
    expect(openTransport(session.key, enc(listed), getAad)).toBeNull();
    expect(openTransport(session.key, enc(listed), `${getAad}#2`)).toBeNull();

    // The same header again is a replay: refused before the handler, like a replayed body.
    const replayed = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { ...headers, "x-loam-seq": sealTransport(session.key, JSON.stringify({ s: 1, r: 1 }), getAad) },
    });
    expect(replayed.statusCode).toBe(409);
    // A header that doesn't open under the session key is malformed.
    const forged = await app.server.inject({ method: "GET", url: "/api/channels", headers: { ...headers, "x-loam-seq": "AAAA" } });
    expect(forged.statusCode).toBe(400);

    // A mutation asks in its body envelope.
    const postAad = "POST /api/messages";
    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers,
      payload: { enc: sealTransport(session.key, JSON.stringify({ s: 2, r: 1, b: { type: "channelPost", channelId: "general", body: "bound" } }), postAad) },
    });
    expect(posted.statusCode).toBe(201);
    expect(openTransport(session.key, enc(posted), `${postAad}#2`)).not.toBeNull();
    expect(openTransport(session.key, enc(posted), postAad)).toBeNull();

    // An envelope that doesn't ask (an older client) still gets the bare route aad, and so does a bare GET.
    const legacy = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers,
      payload: { enc: sealRequest(session.key, 3, postAad, { type: "channelPost", channelId: "general", body: "older client" }) },
    });
    expect(openTransport(session.key, enc(legacy), postAad)).not.toBeNull();
    const bareGet = await app.server.inject({ method: "GET", url: "/api/channels", headers });
    expect(openTransport(session.key, enc(bareGet), getAad)).not.toBeNull();
  });

  it("required mode: only the public bootstrap is directly reachable; all content is tunnel-only", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });

    // The public, cookie-free bootstrap + health are the ONLY directly-reachable routes (docs/20).
    expect((await app.server.inject({ method: "GET", url: "/api/bootstrap" })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);

    // `/api/config` is now CONTENT (returns `currentUser`), so a direct hit is refused — a bound client
    // reads it through the tunnel. This is the docs/20 tightening over docs/08.
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(401);

    // A content endpoint without a transport session is refused.
    const bare = await app.server.inject({ method: "GET", url: "/api/users" });
    expect(bare.statusCode).toBe(401);

    // A percent-encoded `/api/` prefix must NOT bypass enforcement: `/%61pi/users` routes to
    // `/api/users`, so matching the RESOLVED route (not the raw URL) still refuses it (regression).
    const encodedBypass = await app.server.inject({ method: "GET", url: "/%61pi/users" });
    expect(encodedBypass.statusCode).toBe(401);

    // Image endpoints are NOT exempt (docs/08 v2 / docs/20): a direct image GET is 401'd so the client
    // must fetch images through the tunnel (bytes come back sealed) instead of serving them in clear.
    const avatar = await app.server.inject({ method: "GET", url: "/api/avatars/avt_deadbeefdeadbeef.webp" });
    expect(avatar.statusCode).toBe(401);

    // A presented-but-unknown/expired transport session id is refused (both modes) so the client
    // re-handshakes rather than the wire silently downgrading to plaintext.
    const staleSession = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-loam-enc": "unknown-or-expired-session-id" },
    });
    expect(staleSession.statusCode).toBe(401);

    // KEY docs/20 invariant: a DIRECT sealed content request is refused EVEN WITH a live session — a
    // captured session id can't reach content off the tunnel. Content is reachable ONLY via the tunnel.
    const session = await openTransport08(app);
    const direct = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-loam-enc": session.sessionId },
    });
    expect(direct.statusCode).toBe(401);

    // Bind an identity over the sealed channel, then reach the same route through the tunnel: it works.
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.status).toBe(200);
    const inner = await tunnelInner(app, session, 2, { m: "GET", p: "/api/users" });
    expect(inner.status).toBe(200);
    const users = JSON.parse(inner.body.toString("utf8")) as { id: string }[];
    expect(users.some((u) => u.id === bound.currentUser.id)).toBe(true);
  });

  it("rejects a frame sealed for a different route (aad binding)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    // Seal a body under the WRONG route's aad; the server opens against the real route → 400.
    const res = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealTransport(session.key, JSON.stringify({ type: "channelPost", channelId: "general", body: "x" }), "POST /api/admin/kill-switch") },
    });
    expect(res.statusCode).toBe(400);
  });

  it("fails closed: rejects a mutation with a PLAINTEXT body under a presented transport session", async () => {
    // A valid session id (visible in the `x-loam-enc` header on the wire) does not by itself prove the
    // body was actually sealed — before this fix, a request that presented a real session id but a
    // plain, attacker-supplied JSON body would just run as-is, letting an active network attacker
    // inject/rewrite a mutation without ever needing the session key. This is the regression test.
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);

    const res = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" },
      // Plaintext, not `{ enc: "..." }` — must be refused, never processed as-is.
      payload: { type: "channelPost", channelId: "general", body: "injected in the clear" },
    });
    expect(res.statusCode).toBe(400);

    // Nothing was created: the plaintext body was never allowed to reach the route handler.
    expect(app.store.loadMessages().some((message) => "body" in message && message.body === "injected in the clear")).toBe(false);
  });

  it("fails closed: rejects a mutation with NO body at all under a presented transport session", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);

    const res = await app.server.inject({
      method: "DELETE",
      url: "/api/channels/general/members/ghost",
      headers: { cookie: user.cookie, "x-loam-enc": session.sessionId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("still allows a bodyless mutation once it carries a sealed EMPTY envelope (the client always seals mutations)", async () => {
    // The client-side fix pairs with the server's fail-closed check: a mutation with no logical
    // payload is sealed as an empty string rather than sent with no envelope at all, so legitimate
    // bodyless mutations (e.g. `POST /api/admin/users/:id/promote`) keep working under a session.
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const admin = await newSession(app);
    const member = await newSession(app);
    const session = await openSession(app);
    const aad = `POST /api/admin/users/${member.userId}/promote`;

    const res = await app.server.inject({
      method: "POST",
      url: `/api/admin/users/${member.userId}/promote`,
      headers: { cookie: admin.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealRequest(session.key, 1, aad) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a replayed sealed request within the session window (anti-replay)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    const aad = "POST /api/messages";
    const headers = { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" };
    // A captured ciphertext (fixed bytes) replayed verbatim reuses sequence 1.
    const enc = sealRequest(session.key, 1, aad, { type: "channelPost", channelId: "general", body: "once" });

    const first = await app.server.inject({ method: "POST", url: "/api/messages", headers, payload: { enc } });
    expect(first.statusCode).toBe(201);
    const replay = await app.server.inject({ method: "POST", url: "/api/messages", headers, payload: { enc } });
    expect(replay.statusCode).toBe(409);
    // The handler never ran the second time — exactly one message exists.
    expect(app.store.loadMessages().filter((message) => "body" in message && message.body === "once")).toHaveLength(1);
  });

  it("accepts reordered sequences inside the window but refuses a duplicate", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    const aad = "POST /api/messages";
    const headers = { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" };
    const send = (seq: number, body: string) =>
      app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers,
        payload: { enc: sealRequest(session.key, seq, aad, { type: "channelPost", channelId: "general", body }) },
      });

    expect((await send(3, "c")).statusCode).toBe(201); // advances the window to 3
    expect((await send(1, "a")).statusCode).toBe(201); // older but unseen + within window → accepted
    expect((await send(2, "b")).statusCode).toBe(201); // ditto
    expect((await send(2, "again")).statusCode).toBe(409); // a now-seen sequence → refused
  });

  it("refuses a sealed request that carries no sequence number", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    const aad = "POST /api/messages";
    // A pre-anti-replay envelope (the raw body, no `s`) must be refused, not run.
    const enc = sealTransport(session.key, JSON.stringify({ type: "channelPost", channelId: "general", body: "no seq" }), aad);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc },
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses a sealed request with a non-positive or non-integer sequence", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app);
    const session = await openSession(app);
    const aad = "POST /api/messages";
    const headers = { cookie: user.cookie, "x-loam-enc": session.sessionId, "content-type": "application/json" };
    // 0, negative, and fractional sequences are all outside a valid monotonic window → refused.
    for (const s of [0, -1, 1.5]) {
      const enc = sealTransport(session.key, JSON.stringify({ s, b: { type: "channelPost", channelId: "general", body: "x" } }), aad);
      const res = await app.server.inject({ method: "POST", url: "/api/messages", headers, payload: { enc } });
      expect(res.statusCode).toBe(409);
    }
  });

  // --- Transport tunnel (docs/08 v2: path + response fully hidden) ---
  const TUNNEL_AAD = "POST /api/transport/tunnel";

  /** Send a request through the tunnel on a BOUND session (docs/20): seal `{ s, b: { m, p, body } }`
   * to /api/transport/tunnel. No cookie — a bound session authenticates via its session key alone. */
  function tunnel(
    app: LoamApp,
    session: { sessionId: string; key: string },
    seq: number,
    inner: { m: string; p: string; body?: unknown },
  ): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/transport/tunnel",
      headers: {
        "x-loam-enc": session.sessionId,
        "content-type": "application/json",
      },
      payload: { enc: sealRequest(session.key, seq, TUNNEL_AAD, inner) },
    });
  }

  /** Unseal a tunnel response into its `{ status, contentType, body }` descriptor (body = raw bytes). */
  function openTunnel(session: { key: string }, res: InjectResponse): { status: number; contentType: string; body: Buffer } {
    const opened = openTransport(session.key, (res.json() as { enc: string }).enc, TUNNEL_AAD);
    expect(opened).not.toBeNull();
    const desc = JSON.parse(opened as string) as { status: number; contentType: string; bodyB64: string };
    return { status: desc.status, contentType: desc.contentType, body: Buffer.from(desc.bodyB64, "base64") };
  }

  it("tunnels a GET so the real path and response never appear on the wire", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    const bound = await resumeIdentity(app, session, 1); // bind identity before touching content

    const res = await tunnel(app, session, 2, { m: "GET", p: "/api/users" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-loam-enc"]).toBe("1");
    // Neither the real target nor the response content is anywhere in the cleartext wire body.
    expect(res.body).not.toContain("displayName");
    expect(res.body).not.toContain("/api/users");

    const inner = openTunnel(session, res);
    expect(inner.status).toBe(200);
    const users = JSON.parse(inner.body.toString("utf8")) as { id: string }[];
    expect(users.some((u) => u.id === bound.currentUser.id)).toBe(true);
  });

  it("tunnels a POST mutation end-to-end (creates a message; response tunnelled back)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    await resumeIdentity(app, session, 1);

    const res = await tunnel(app, session, 2, {
      m: "POST",
      p: "/api/messages",
      body: { type: "channelPost", channelId: "general", body: "via tunnel" },
    });
    expect(res.statusCode).toBe(200); // outer tunnel status; inner status is in the sealed descriptor
    const inner = openTunnel(session, res);
    expect(inner.status).toBe(201);
    expect(app.store.loadMessages().some((m) => "body" in m && m.body === "via tunnel")).toBe(true);
  });

  it("carries response bytes losslessly (base64 body → binary images tunnel intact)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    await resumeIdentity(app, session, 1);
    // A JSON response proves the base64 body is byte-exact; the same path carries image bytes.
    const res = await tunnel(app, session, 2, { m: "GET", p: "/api/config" });
    const inner = openTunnel(session, res);
    expect(inner.status).toBe(200);
    const parsed = JSON.parse(inner.body.toString("utf8")) as { nodeName: string };
    expect(typeof parsed.nodeName).toBe("string");
  });

  it("refuses to tunnel the transport bootstrap or non-API paths — including percent-encoded evasions", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    await resumeIdentity(app, session, 1);

    const refused = [
      "/api/transport/handshake",
      "/api/transport/tunnel",
      "/",
      "/index.html",
      "/api/../admin",
      // Percent-encoded evasions: a raw string check would pass these, but they decode-and-route to
      // the transport bootstrap (recursion) or a traversal. The check now validates the DECODED path.
      "/api/transp%6frt/tunnel", // %6f = 'o' → /api/transport/tunnel
      "/api/transport%2ftunnel", // encoded slash → refused outright
      "/api/%2e%2e/admin", // %2e%2e = '..' → traversal
      "/%61pi/transport/handshake", // %61 = 'a' → /api/transport/handshake
    ];
    for (const [i, p] of refused.entries()) {
      const res = await tunnel(app, session, i + 2, { m: "GET", p }); // seq 1 consumed by resume
      expect(res.statusCode, `expected 400 for tunnel target ${p}`).toBe(400);
    }
  });

  it("does not let a forged internal-token header bypass required-mode enforcement", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    // A real client that guesses/sets x-loam-internal must NOT gain the internal bypass — the token is
    // a per-boot secret it can't know (and onRequest strips a client-supplied one), so a content request
    // without a session is still refused.
    const forged = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-loam-internal": "not-the-real-token" },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("does not let a forged x-loam-user header impersonate an identity", async () => {
    // The internal tunnel sets `x-loam-user`, trusted only behind the unforgeable `x-loam-internal`.
    // A client that sets `x-loam-user` (with or without a guessed internal token) on an EXTERNAL request
    // must gain nothing — onRequest strips both, so this is just an unauthenticated content hit → 401.
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const forged = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-loam-user": "user.deadbeef", "x-loam-internal": "not-the-real-token" },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("binds a fresh identity through the sealed resume — no cookie is ever minted", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    // First contact with no token: resume mints a new identity + a 256-bit secure token, sealed. The
    // secure token replaces the cookie entirely — the resume response must NOT set a session cookie.
    const res = await app.server.inject({
      method: "POST",
      url: "/api/session/resume",
      headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealRequest(session.key, 1, "POST /api/session/resume", {}) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    const opened = openTransport(session.key, (res.json() as { enc: string }).enc, "POST /api/session/resume");
    const body = JSON.parse(opened as string) as { currentUser: { id: string }; token: string };
    expect(body.currentUser.id).toMatch(/^user\./);
    expect(body.token.length).toBeGreaterThanOrEqual(43); // 256-bit base64url
  });

  it("serves images only through the tunnel in required mode (image encryption)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openSession(app);
    await resumeIdentity(app, session, 1);
    // A direct <img>-style GET can't carry the session header → refused, so bytes never serve in clear.
    const direct = await app.server.inject({
      method: "GET",
      url: "/api/avatars/avt_missing.webp",
    });
    expect(direct.statusCode).toBe(401);
    // Through the tunnel it reaches the avatar route internally (404 for a missing file, NOT 401) —
    // i.e. a real image would come back as sealed bytes.
    const res = await tunnel(app, session, 2, { m: "GET", p: "/api/avatars/avt_missing.webp" });
    expect(res.statusCode).toBe(200);
    expect(openTunnel(session, res).status).toBe(404);
  });
});

describe("transport encryption WebSocket frames", () => {
  // Wire constants for the reflection-safe key-confirmation (docs/20 §7). Hardcoded here (not imported)
  // so the test pins the on-the-wire AADs — a server-side rename must break these deliberately.
  const WS_CHALLENGE_AAD = "loam.ws.challenge.v1";
  const WS_PROOF_AAD = "loam.ws.proof.v1";
  const wsFrameAad = (connectionId: string) => `loam.ws.frame.v1 ${connectionId}`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  type RawWebSocket = {
    addEventListener: (event: string, listener: (event: unknown) => void) => void;
    send: (data: string) => void;
    close: () => void;
  };
  const openWs = (url: string, cookie?: string): RawWebSocket =>
    new (WebSocket as unknown as new (url: string, opts?: unknown) => RawWebSocket)(
      url,
      cookie ? { headers: { cookie } } : undefined,
    );

  /** Connect an encrypted WS, auto-answer the docs/20 §7 challenge, and collect decoded application
   *  frames (the inner `f` of each `{ q, f }` connection-bound envelope) plus their sequences. */
  async function connectConfirmed(
    baseUrl: string,
    sessionId: string,
    key: string,
    cookie?: string,
  ): Promise<{ socket: RawWebSocket; connectionId(): string; payloads: string[]; seqs: number[]; raw: string[] }> {
    const raw: string[] = [];
    const payloads: string[] = [];
    const seqs: number[] = [];
    let connectionId = "";
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=${sessionId}`, cookie);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
    });
    socket.addEventListener("message", (event) => {
      const text = String((event as MessageEvent).data);
      raw.push(text);
      if (!connectionId) {
        const challenge = openTransport(key, text, WS_CHALLENGE_AAD);
        if (challenge) {
          const c = JSON.parse(challenge) as { connectionId: string; nonce: string };
          connectionId = c.connectionId;
          socket.send(sealTransport(key, JSON.stringify({ type: "proof", connectionId: c.connectionId, nonce: c.nonce }), WS_PROOF_AAD));
          return;
        }
      }
      const frame = openTransport(key, text, wsFrameAad(connectionId));
      if (frame) {
        const env = JSON.parse(frame) as { q: number; f: string };
        seqs.push(env.q);
        payloads.push(env.f);
      }
    });
    const deadline = Date.now() + 3_000;
    while (!connectionId && Date.now() < deadline) {
      await sleep(25);
    }
    return { socket, connectionId: () => connectionId, payloads, seqs, raw };
  }

  it("seals outbound WS frames, connection-bound, only after the client confirms the key", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1); // bind identity → WS uses session.userId

    const client = await connectConfirmed(baseUrl, session.sessionId, session.key);
    try {
      expect(client.connectionId()).not.toBe(""); // the challenge was answered

      // Post through the tunnel as the bound user; the broadcast should reach the confirmed socket.
      await tunnelInner(app, session, 2, {
        m: "POST",
        p: "/api/messages",
        body: { type: "channelPost", channelId: "general", body: "over-the-wire secret" },
      });

      const deadline = Date.now() + 3_000;
      while (!client.payloads.some((f) => f.includes("over-the-wire secret")) && Date.now() < deadline) {
        await sleep(25);
      }
    } finally {
      client.socket.close();
    }

    expect(bound.currentUser.id).toMatch(/^user\./);
    // No frame is plaintext...
    for (const frame of client.raw) {
      expect(frame).not.toContain("over-the-wire secret");
    }
    // ...but an application frame decrypts (connection-bound aad) to the broadcast event.
    expect(client.payloads.some((value) => value.includes("over-the-wire secret"))).toBe(true);
    // Frame sequences are monotonic per connection (docs/20 §7 replay window).
    expect(client.seqs).toEqual([...client.seqs].sort((a, b) => a - b));
  });

  it("withholds all frames until the challenge is answered; a reflected challenge never confirms", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const session = await openTransport08(app);
    await resumeIdentity(app, session, 1);

    const raw: string[] = [];
    let appFrames = 0;
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=${session.sessionId}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
      });
      socket.addEventListener("message", (event) => {
        const text = String((event as MessageEvent).data);
        raw.push(text);
        // REFLECTION ATTACK: bounce the challenge ciphertext straight back as the "proof". A keyless
        // attacker can only echo bytes; the server opens it under the proof aad → fails → never confirms.
        socket.send(text);
        // Any frame that opens under a frame aad would be an application frame leaking pre-confirmation.
        // We can't know the connectionId (never revealed to a keyless attacker), but the challenge is the
        // only thing that opens under the challenge aad — count anything that ISN'T the challenge.
        if (!openTransport(session.key, text, WS_CHALLENGE_AAD)) {
          appFrames += 1;
        }
      });

      // Give the reflection a moment, then trigger a broadcast: a confirmed socket would receive it.
      await sleep(100);
      await tunnelInner(app, session, 2, {
        m: "POST",
        p: "/api/messages",
        body: { type: "channelPost", channelId: "general", body: "must-not-arrive" },
      });
      await sleep(300);
    } finally {
      socket.close();
    }

    // Exactly the challenge was ever sent; no application frame arrived (the socket was never admitted).
    expect(raw.length).toBe(1);
    expect(appFrames).toBe(0);
    expect(raw.every((f) => !f.includes("must-not-arrive"))).toBe(true);
  });

  it("binds application frames to the connection: two sockets get distinct connection ids", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const session = await openTransport08(app);
    await resumeIdentity(app, session, 1);

    const a = await connectConfirmed(baseUrl, session.sessionId, session.key);
    const b = await connectConfirmed(baseUrl, session.sessionId, session.key);
    try {
      expect(a.connectionId()).not.toBe("");
      expect(b.connectionId()).not.toBe("");
      // Same transport session, but a fresh, distinct connection id per socket — so a frame sealed for A
      // cannot be opened under B's connection-bound aad (aad binding is already proven in the crypto
      // suite; here we prove the SERVER issues a distinct id per connection).
      expect(a.connectionId()).not.toBe(b.connectionId());

      await tunnelInner(app, session, 2, {
        m: "POST",
        p: "/api/messages",
        body: { type: "channelPost", channelId: "general", body: "fan-out" },
      });
      const deadline = Date.now() + 3_000;
      while (
        (!a.payloads.some((f) => f.includes("fan-out")) || !b.payloads.some((f) => f.includes("fan-out"))) &&
        Date.now() < deadline
      ) {
        await sleep(25);
      }
      // A raw frame captured on A does not open under B's connection-bound aad.
      const aFrame = a.raw.find((f) => openTransport(session.key, f, wsFrameAad(a.connectionId()))?.includes("fan-out"));
      expect(aFrame).toBeDefined();
      expect(openTransport(session.key, aFrame as string, wsFrameAad(b.connectionId()))).toBeNull();
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });

  it("a ban closes a socket that is still mid-challenge", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const adminS = await openTransport08(app);
    const admin = await resumeIdentity(app, adminS, 1);
    expect(admin.currentUser.isAdmin).toBe(true);
    const memberS = await openTransport08(app);
    const member = await resumeIdentity(app, memberS, 1);

    // Open the member's WS but DELIBERATELY do NOT answer the challenge — it stays mid-confirmation.
    let closed = false;
    let received = 0;
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=${memberS.sessionId}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
      });
      socket.addEventListener("message", () => (received += 1)); // only the challenge should ever arrive
      socket.addEventListener("close", () => (closed = true));
      await sleep(50); // let the challenge arrive; we never answer it

      // Admin bans the member while their socket is still unconfirmed.
      const banned = await tunnelInner(app, adminS, 2, {
        m: "PATCH",
        p: `/api/moderation/users/${member.currentUser.id}`,
        body: { banned: true },
      });
      expect(banned.status).toBe(200);

      const deadline = Date.now() + 2_000;
      while (!closed && Date.now() < deadline) {
        await sleep(25);
      }
    } finally {
      socket.close();
    }

    // The ban reached the mid-challenge socket and closed it — it never got a chance to confirm and be
    // admitted post-ban. Only the challenge frame was ever delivered (no events).
    expect(closed).toBe(true);
    expect(received).toBe(1);
  });

  it("rejects a WebSocket presenting an unknown/expired enc — no silent plaintext downgrade", async () => {
    // A stale QR-bound client keeps its `?enc=`; if it no longer resolves, the socket must be REFUSED, not
    // downgraded to a plaintext cookie socket (which would attribute the connection to a cookie user and
    // send events in the clear). Optional mode is the exposed case (required would refuse anyway).
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app); // a cookie identity exists — the tempting fallback
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    let closed = false;
    let sawExpired = false;
    let appFrames = 0;
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=nonexistent-session-id`, user.cookie);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
      });
      socket.addEventListener("message", (event) => {
        const text = String((event as MessageEvent).data);
        if (text.includes("expired")) sawExpired = true;
        else appFrames += 1;
      });
      socket.addEventListener("close", () => (closed = true));

      // Trigger a broadcast: a wrongly-admitted plaintext socket would receive this in the clear.
      await sleep(50);
      await app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: user.cookie },
        payload: { type: "channelPost", channelId: "general", body: "must-not-leak" },
      });
      const deadline = Date.now() + 2_000;
      while (!closed && Date.now() < deadline) {
        await sleep(25);
      }
    } finally {
      socket.close();
    }

    expect(sawExpired).toBe(true); // told to re-handshake
    expect(closed).toBe(true); // refused, not admitted
    expect(appFrames).toBe(0); // never received the broadcast in the clear
  });

  it("closes a confirmed socket when its transport session is evicted", async () => {
    // A confirmed socket must not outlive its session key. Drive the session cap low, confirm a socket,
    // then open (and bind, since anonymous sessions are evicted first) enough fresh sessions to evict its
    // (oldest) session — the socket should be closed.
    const app = await makeApp(
      { security: { profile: "custom", transportEncryption: "required" } },
      { transportSessionCap: 2 },
    );
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const session = await openTransport08(app);
    await resumeIdentity(app, session, 1);

    const client = await connectConfirmed(baseUrl, session.sessionId, session.key);
    let closed = false;
    client.socket.addEventListener("close", () => (closed = true));
    try {
      expect(client.connectionId()).not.toBe(""); // confirmed and admitted

      // Each new handshake prunes+evicts; with cap 2 and only bound sessions in the map, the socket's
      // (oldest) session is evicted quickly.
      for (let i = 0; i < 4; i += 1) {
        await resumeIdentity(app, await openTransport08(app), 1);
      }
      const deadline = Date.now() + 2_000;
      while (!closed && Date.now() < deadline) {
        await sleep(25);
      }
    } finally {
      client.socket.close();
    }

    expect(closed).toBe(true); // the confirmed socket was torn down with its evicted session
  });

  it("fails closed on a presented enc even on an OFF node, and on a bare ?enc=", async () => {
    // A node switched to `off` still must refuse a stale key-pinned client's `?enc=` rather than admit a
    // plaintext downgrade; and a bare `?enc=` (present but empty) is refused too (keyed on param presence).
    const app = await makeApp(); // default: transport encryption OFF
    const user = await newSession(app); // a cookie identity for the legitimate plaintext socket
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    async function expectRefused(query: string): Promise<void> {
      let closed = false;
      let admitted = 0;
      const socket = openWs(`${baseUrl.replace("http", "ws")}/ws${query}`);
      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve());
          socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
        });
        socket.addEventListener("message", (event) => {
          if (!String((event as MessageEvent).data).includes("expired")) admitted += 1;
        });
        socket.addEventListener("close", () => (closed = true));
        const deadline = Date.now() + 1_500;
        while (!closed && Date.now() < deadline) {
          await sleep(25);
        }
      } finally {
        socket.close();
      }
      expect(closed).toBe(true);
      expect(admitted).toBe(0);
    }

    await expectRefused("?enc=stale-session-id"); // off node + presented enc → refused
    await expectRefused("?enc="); // bare, empty enc → refused (param presence, not value length)

    // Sanity: a plaintext client with a cookie identity and NO ?enc= is still admitted on an off node.
    const plain = openWs(`${baseUrl.replace("http", "ws")}/ws`, user.cookie);
    let plainClosed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        plain.addEventListener("open", () => resolve());
        plain.addEventListener("error", () => reject(new Error("ws failed to connect")));
      });
      plain.addEventListener("close", () => (plainClosed = true));
      await sleep(100);
    } finally {
      plain.close();
    }
    expect(plainClosed).toBe(false); // admitted (not refused) — legitimate off-node plaintext socket
  });

  it("counts unconfirmed sockets per IPv6 /64, like the HTTP limiter, so cycling addresses buys none", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openTransport08(app);
    await resumeIdentity(app, session, 1);

    /** Open an encrypted socket from `address` (never answering its challenge) and return its first frame. */
    async function firstFrameFrom(address: string): Promise<string> {
      let first!: Promise<string>;
      const socket = await app.server.injectWS(
        `/ws?enc=${session.sessionId}`,
        { headers: { host: "127.0.0.1" }, socket: { remoteAddress: address } } as never,
        {
          // Listen before the upgrade completes: the server speaks first.
          onInit: (ws) => {
            first = new Promise<string>((resolve) => ws.once("message", (data: Buffer) => resolve(data.toString())));
          },
        },
      );
      cleanups.push(() => socket.terminate());
      return first;
    }

    // Eight sockets from eight addresses in one /64 fill that host's share of the pre-auth pool.
    for (let host = 1; host <= 8; host += 1) {
      const frame = await firstFrameFrom(`2001:db8:1:2::${host}`);
      expect(openTransport(session.key, frame, WS_CHALLENGE_AAD)).toBeTruthy();
    }
    // A ninth address in the same /64 is refused; one in another /64 is not.
    expect(await firstFrameFrom("2001:db8:1:2::9")).toContain("Too many pending connections");
    expect(openTransport(session.key, await firstFrameFrom("2001:db8:1:3::1"), WS_CHALLENGE_AAD)).toBeTruthy();
  });
});

describe("transport auth-binding", () => {
  const TUNNEL_AAD = "POST /api/transport/tunnel";

  it("impersonation defeated: a captured session id without the key can't tunnel, resume, or rebind", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const victim = await openTransport08(app);
    const bound = await resumeIdentity(app, victim, 1); // victim binds an identity on session `victim`
    expect(bound.status).toBe(200);

    // An attacker sniffs the victim's SESSION ID but not the key. Their own handshake yields a different
    // key; sealing a tunnel request under it while presenting the victim's session id fails AEAD open.
    const attacker = await openTransport08(app);
    const forgedTunnel = await app.server.inject({
      method: "POST",
      url: "/api/transport/tunnel",
      headers: { "x-loam-enc": victim.sessionId, "content-type": "application/json" },
      payload: { enc: sealTransport(attacker.key, JSON.stringify({ s: 2, b: { m: "GET", p: "/api/users" } }), TUNNEL_AAD) },
    });
    expect(forgedTunnel.statusCode).toBe(400); // undecryptable under the victim session's real key

    // The attacker can't resume as the victim either: the victim's session is already bound, so a resume
    // attempt returns the victim's own cached identity (never the attacker's), and never rebinds.
    const rebindAttempt = await resumeIdentity(app, victim, 3);
    expect(rebindAttempt.status).toBe(200);
    expect(rebindAttempt.currentUser.id).toBe(bound.currentUser.id); // unchanged — no rebind
  });

  it("legacy-token separation: a cookie session token is rejected at resume", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const user = await newSession(app); // optional mode → a real cookie session token exists
    const cookieToken = user.cookie.replace(/^loam_session=/, "");

    const session = await openTransport08(app);
    const res = await resumeIdentity(app, session, 1, cookieToken);
    // The cookie namespace and the identity-token namespace never mix (docs/20 §3) → hard 401.
    expect(res.status).toBe(401);
  });

  it("resume semantics: mint, resume-on-fresh-session, invalid→401, idempotent no-rebind", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });

    // MINT: no token → a new identity + a fresh secure token.
    const s1 = await openTransport08(app);
    const minted = await resumeIdentity(app, s1, 1);
    expect(minted.status).toBe(200);
    expect(minted.token.length).toBeGreaterThanOrEqual(43);

    // RESUME on a brand-new session with that token → the SAME user.
    const s2 = await openTransport08(app);
    const resumed = await resumeIdentity(app, s2, 1, minted.token);
    expect(resumed.status).toBe(200);
    expect(resumed.currentUser.id).toBe(minted.currentUser.id);

    // INVALID token → 401, never a silent mint.
    const s3 = await openTransport08(app);
    const invalid = await resumeIdentity(app, s3, 1, "not-a-real-token");
    expect(invalid.status).toBe(401);

    // IDEMPOTENT no-rebind: a fresh-sequence resume on the already-bound s2, presenting a DIFFERENT
    // token, must NOT rebind — it returns the cached identity from the first bind.
    const other = await resumeIdentity(app, s2, 2, minted.token);
    expect(other.currentUser.id).toBe(resumed.currentUser.id);
  });

  it("a repeat resume on a bound session reports the user as they are now, not as they were bound", async () => {
    // The Android host's WebView binds as a pending newcomer on an approval-only network, claims admin with
    // the host token, and resumes again on its next boot pass. That resume used to replay the snapshot
    // taken at bind time (pending, not admin), sending the host back to the queue.
    const hostToken = "host-token-resume-0123456789abcdefghijklmnopq";
    const app = await makeApp({ security: { profile: "hardened" } }, { hostToken });
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.currentUser.pending).toBe(true);

    const claim = await app.server.inject({
      method: "POST",
      url: "/api/transport/tunnel",
      headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: {
        enc: sealSeq(session.key, 2, TUNNEL_AAD, { m: "POST", p: "/api/admin/claim", body: { secret: hostToken } }),
      },
    });
    expect(claim.statusCode).toBe(200);

    const again = await resumeIdentity(app, session, 3);
    expect(again.currentUser.id).toBe(bound.currentUser.id);
    expect(again.currentUser.isAdmin).toBe(true);
    expect(again.currentUser.pending).toBe(false);
    expect(again.token).toBe(bound.token);
  });

  it("response binding: the tunnel descriptor echoes the exact { s, m, p } it answers", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openTransport08(app);
    await resumeIdentity(app, session, 1);

    const res = await app.server.inject({
      method: "POST",
      url: "/api/transport/tunnel",
      headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealSeq(session.key, 2, TUNNEL_AAD, { m: "GET", p: "/api/users" }) },
    });
    expect(res.statusCode).toBe(200);
    const opened = openTransport(session.key, (res.json() as { enc: string }).enc, TUNNEL_AAD);
    const desc = JSON.parse(opened as string) as { s: number; m: string; p: string; status: number };
    expect(desc.s).toBe(2);
    expect(desc.m).toBe("GET");
    expect(desc.p).toBe("/api/users");
  });

  it("logout revokes the secure token: a later resume with it fails", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);

    const logout = await app.server.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealSeq(session.key, 2, "POST /api/session/logout", {}) },
    });
    expect(logout.statusCode).toBe(200);

    // The token is gone: a fresh session presenting it is refused (never rehydrates the identity).
    const fresh = await openTransport08(app);
    const afterLogout = await resumeIdentity(app, fresh, 1, bound.token);
    expect(afterLogout.status).toBe(401);
  });

  it("device wipe clears a LEGACY COOKIE independently of the secure token, even in required mode", async () => {
    // A browser can hold BOTH a bound secure identity AND a legacy `loam_session` cookie. The sealed logout
    // uses `credentials:"omit"`, so it revokes only the token — the cookie must be cleared independently via
    // the DIRECT `session/end`, which is reachable in required mode and clears the presented cookie's
    // server-side row (otherwise the cookie could rehydrate the wiped identity on an optional/off node).
    const app = await makeApp(); // off by default → firstUser admin + a mintable cookie
    const admin = await newSession(app);
    const cookieToken = admin.cookie.replace(/^loam_session=/, "");
    expect(app.store.loadSessions().some((s) => s.token === cookieToken)).toBe(true);

    // Switch the node to `required` (the mode where the cookie couldn't be cleared before).
    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { profile: "custom", transportEncryption: "required" } },
    });
    expect(patch.statusCode).toBe(200);

    // A bare, direct `session/end` carrying the cookie is REACHABLE in required mode (not tunnel-only) and
    // clears the cookie — both the Set-Cookie deletion header and the server-side session row.
    const end = await app.server.inject({
      method: "POST",
      url: "/api/session/end",
      headers: { cookie: admin.cookie },
    });
    expect(end.statusCode).toBe(200);
    expect(String(end.headers["set-cookie"])).toContain("Max-Age=0");
    expect(app.store.loadSessions().some((s) => s.token === cookieToken)).toBe(false); // row gone
  });

  it("kill switch clears secure tokens: none can be resumed afterwards", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" }, killSwitch: { enabled: true } });
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.currentUser.isAdmin).toBe(true); // first user → admin, so it may fire the kill switch

    // Fire the kill switch through the tunnel (the bound admin authorises it).
    const fired = await tunnelInner(app, session, 2, {
      m: "POST",
      p: "/api/admin/kill-switch",
      body: { confirm: "wipe" },
    });
    expect(fired.status).toBe(200);

    // Every secure token is gone; the old one can't be resumed on a fresh (post-rotation) session.
    const fresh = await openTransport08(app);
    const afterWipe = await resumeIdentity(app, fresh, 1, bound.token);
    expect(afterWipe.status).toBe(401);
  });

  it("ban tears down the banned user's bound transport session", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const adminS = await openTransport08(app);
    const admin = await resumeIdentity(app, adminS, 1);
    expect(admin.currentUser.isAdmin).toBe(true);

    const memberS = await openTransport08(app);
    const member = await resumeIdentity(app, memberS, 1);
    expect(member.currentUser.isAdmin).toBe(false);

    // Admin bans the member through the tunnel.
    const banned = await tunnelInner(app, adminS, 2, {
      m: "PATCH",
      p: `/api/moderation/users/${member.currentUser.id}`,
      body: { banned: true },
    });
    expect(banned.status).toBe(200);

    // The member's bound transport session was torn down: presenting its (now-unknown) id is refused, so
    // they can't keep tunnelling as the banned identity.
    const afterBan = await app.server.inject({
      method: "POST",
      url: "/api/transport/tunnel",
      headers: { "x-loam-enc": memberS.sessionId, "content-type": "application/json" },
      payload: { enc: sealSeq(memberS.key, 3, TUNNEL_AAD, { m: "GET", p: "/api/users" }) },
    });
    expect(afterBan.statusCode).toBe(401); // transport session expired/gone
  });

  it("session-state binding: a bound session on an OPTIONAL node still enforces the secure rules", async () => {
    // Global mode is `optional`, but a client that completes a sealed resume is `bound` — so it must
    // reach content through the tunnel and its cookie is not a credential (docs/20 §2).
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.status).toBe(200);

    // Content via the tunnel on the bound session works and is the bound identity.
    const inner = await tunnelInner(app, session, 2, { m: "GET", p: "/api/config" });
    expect(inner.status).toBe(200);
    const cfg = JSON.parse(inner.body.toString("utf8")) as { currentUser: { id: string } };
    expect(cfg.currentUser.id).toBe(bound.currentUser.id);

    // NEGATIVE case (docs/20 §2): the SAME bound session hitting a content route DIRECTLY (sealed, not
    // via the tunnel) is refused — the secure rules key off session `authMode`, not the node's global
    // mode, so a bound session is tunnel-only even on an `optional` node.
    const direct = await app.server.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-loam-enc": session.sessionId },
    });
    expect(direct.statusCode).toBe(401);
  });

  it("empty-string resume token mints a fresh identity (treated as no token, not invalid)", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openTransport08(app);
    // `{ token: "" }` is not a real 256-bit token — the server treats it as "mint", not a 401.
    const res = await resumeIdentity(app, session, 1, "");
    expect(res.status).toBe(200);
    expect(res.currentUser.id).toMatch(/^user\./);
    expect(res.token.length).toBeGreaterThanOrEqual(43);
  });

  it("rejects a malformed (non-string) resume token with 400, not a silent mint", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const session = await openTransport08(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/session/resume",
      headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
      payload: { enc: sealSeq(session.key, 1, "POST /api/session/resume", { token: 123 }) },
    });
    expect(res.statusCode).toBe(400);
    // The session was NOT bound — a subsequent well-formed resume still mints (not the idempotent path).
    const after = await resumeIdentity(app, session, 2);
    expect(after.status).toBe(200);
    expect(after.currentUser.id).toMatch(/^user\./);
  });
});

describe("tunnelled requests count against the search cap", () => {
  it("counts tunnelled requests against the per-route semantic caps (search: 60/min)", async () => {
    const app = await makeApp();
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.status).toBe(200);

    // 61 tunnelled searches: the first 60 pass, the 61st trips the route's semantic cap — the cap
    // the tunnel used to bypass entirely (internal dispatches inherited the global allowList).
    let okCount = 0;
    let limited = 0;

    for (let i = 0; i < 61; i += 1) {
      const inner = await tunnelInner(app, session, 2 + i, { m: "GET", p: "/api/search?q=x" });
      expect(inner.outerStatus).toBe(200);

      if (inner.status === 429) {
        limited += 1;
      } else {
        expect(inner.status).toBe(200);
        okCount += 1;
      }
    }

    expect(okCount).toBe(60);
    expect(limited).toBe(1);
  });
});

describe("tunnelled requests count against the claim and panic caps", () => {
  async function post(app: LoamApp, cookie: string, payload: Record<string, unknown>): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  it("counts tunnelled requests against the admin-claim route cap (10/min)", async () => {
    const app = await makeApp({ admin: { bootstrap: "setupCode" } });
    const session = await openTransport08(app);
    expect((await resumeIdentity(app, session, 1)).status).toBe(200);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      // An invalid body is a 400 BEFORE the semantic claim limiter, so only the route cap can 429 here.
      const inner = await tunnelInner(app, session, 2 + i, { m: "POST", p: "/api/admin/claim", body: {} });
      expect(inner.outerStatus).toBe(200);
      statuses.push(inner.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("counts tunnelled requests against the panic route cap: the 11th call can't fire the wipe", async () => {
    const panicToken = "p".repeat(24);
    const app = await makeApp({ killSwitch: { enabled: true, requireConfirmation: true, panicToken } });
    const admin = await newSession(app);
    const created = await post(app, admin.cookie, { type: "channelPost", channelId: "general", body: "keep me" });
    expect(created.statusCode).toBe(201);
    const session = await openTransport08(app);
    expect((await resumeIdentity(app, session, 1)).status).toBe(200);

    for (let i = 0; i < 10; i += 1) {
      // Schema-invalid bodies 404 before the semantic panic limiter; only the route cap counts them.
      const inner = await tunnelInner(app, session, 2 + i, { m: "POST", p: "/api/panic", body: {} });
      expect(inner.status).toBe(404);
    }
    const fired = await tunnelInner(app, session, 12, { m: "POST", p: "/api/panic", body: { token: panicToken } });
    expect(fired.status).toBe(404);
    expect(app.store.loadMessages().some((message) => message.type === "channelPost" && message.body === "keep me")).toBe(true);
  });
});
