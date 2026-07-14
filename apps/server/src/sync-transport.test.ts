import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sealTransport } from "@loam/crypto";
import { SyncDigestSchema } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import { fetchPeerTransportPosture, handshakeWithPeer, sealedFetch } from "./sync-transport.js";

/**
 * Node-to-node sync transport encryption (docs/08). Two real `buildApp` instances wired over actual
 * HTTP: a REQUIRED-mode peer B (which 401s any plaintext `/api/*` content request) and a puller A.
 * These prove (a) A can sync a REQUIRED peer at all — the gap this branch closes — and that it only
 * works because the sync requests are sealed end-to-end; (b) the sealed sync request round-trips and is
 * AAD/session bound (a tampered aad or a bogus session is refused); (c) an `off`-mode peer still syncs
 * over the unchanged plaintext path; (d) puller-side sessions are cached (no re-handshake per call) and
 * re-established on a 401.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** A fresh temp data dir, cleaned up after the test. */
function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loam-sync-transport-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a partial config.json into a data dir (merged over defaults at boot). */
function writeConfig(dataDir: string, config: unknown): void {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
}

/** Build an app on a data dir (with a generous identity budget so shared-127.0.0.1 sessions never trip
 * the per-IP limiter), registering it for cleanup. */
async function buildOn(dataDir: string): Promise<LoamApp> {
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000 });
  cleanups.push(() => app.close());
  return app;
}

/** Have an app's Fastify server listen on an ephemeral loopback port; returns its base URL. */
async function listen(app: LoamApp): Promise<string> {
  return app.server.listen({ host: "127.0.0.1", port: 0 });
}

function sessionCookie(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = first?.split(";")[0];
  if (!cookie?.startsWith("loam_session=")) {
    throw new Error("No session cookie in response");
  }
  return cookie;
}

/** Post one public `general` channel message on a temporarily-opened node at `dataDir`, returning its
 * id. Opens the node in transport-`off` mode (so the seed post needs no handshake), then closes it —
 * the message persists in SQLite for a later required-mode reopen. */
async function seedPublicMessage(dataDir: string, body: string): Promise<string> {
  writeConfig(dataDir, {});
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000 });
  try {
    const cfg = await app.server.inject({ method: "GET", url: "/api/config" });
    const cookie = sessionCookie(cfg.headers["set-cookie"]);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId: "general", body },
    });
    if (res.statusCode !== 201) {
      throw new Error(`seed post failed: ${res.statusCode} ${res.body}`);
    }
    return (res.json() as { message: { id: string } }).message.id;
  } finally {
    await app.close();
  }
}

/** Post one public `general` message carrying a 1×1 PNG attachment on a temporarily-opened `off`-mode
 * node, returning the message id + the URL its attachment is served at. */
async function seedPublicMessageWithAttachment(dataDir: string): Promise<{ messageId: string; attachmentUrl: string }> {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  writeConfig(dataDir, {});
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000 });
  try {
    const cfg = await app.server.inject({ method: "GET", url: "/api/config" });
    const cookie = sessionCookie(cfg.headers["set-cookie"]);
    const up = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie },
      payload: { mimeType: "image/png", data: tinyPng, width: 1, height: 1 },
    });
    if (up.statusCode !== 201) {
      throw new Error(`seed attachment upload failed: ${up.statusCode} ${up.body}`);
    }
    const attachment = up.json() as { id: string; mimeType: string };
    const res = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attachment] },
    });
    if (res.statusCode !== 201) {
      throw new Error(`seed attachment post failed: ${res.statusCode} ${res.body}`);
    }
    return {
      messageId: (res.json() as { message: { id: string } }).message.id,
      attachmentUrl: `/api/attachments/${attachment.id}.png`,
    };
  } finally {
    await app.close();
  }
}

/** An admin session on a node (firstUser bootstrap → the first session is admin). */
async function adminSession(app: LoamApp): Promise<string> {
  const res = await app.server.inject({ method: "GET", url: "/api/config" });
  const cookie = sessionCookie(res.headers["set-cookie"]);
  const isAdmin = (res.json() as { currentUser: { isAdmin: boolean } }).currentUser.isAdmin;
  if (!isAdmin) {
    throw new Error("expected the first session to be admin");
  }
  return cookie;
}

/** Force one sync round on the puller and return whether the peer reported an error. */
async function runSync(app: LoamApp, cookie: string): Promise<string | undefined> {
  const res = await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  if (res.statusCode !== 200) {
    throw new Error(`sync run failed: ${res.statusCode} ${res.body}`);
  }
  const report = res.json() as { peers: { status?: { lastError?: string } }[] };
  return report.peers[0]?.status?.lastError;
}

function hasMessage(app: LoamApp, id: string): boolean {
  return app.store.loadMessages().some((message) => message.id === id);
}

/** The config that puts a node in REQUIRED transport mode and serves sync (no pulling of its own). */
function requiredPeerConfig(): unknown {
  return { sync: { enabled: true, peers: [] }, security: { transportEncryption: "required" } };
}

describe("sync transport encryption — REQUIRED peer", () => {
  it("(a) a puller syncs public messages from a REQUIRED-mode peer that refuses plaintext", async () => {
    const peerDir = makeDataDir();
    const seededId = await seedPublicMessage(peerDir, "hello from a required peer");

    writeConfig(peerDir, requiredPeerConfig());
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);

    // The gap this branch closes: a plaintext sync pull against a REQUIRED peer is refused outright.
    const plaintext = await fetch(`${peerUrl}/api/sync/digest`);
    expect(plaintext.status).toBe(401);

    // The puller (transport off itself) still syncs — only possible because it establishes a transport
    // session with the peer and seals the digest/messages requests end-to-end.
    const pullerDir = makeDataDir();
    writeConfig(pullerDir, { sync: { enabled: true, peers: [{ url: peerUrl }], intervalMs: 3_600_000 } });
    const puller = await buildOn(pullerDir);
    const cookie = await adminSession(puller);

    const error = await runSync(puller, cookie);
    expect(error).toBeUndefined();
    expect(hasMessage(puller, seededId)).toBe(true);
  });

  it("(b) a sealed sync request round-trips and is AAD/session bound", async () => {
    const peerDir = makeDataDir();
    const seededId = await seedPublicMessage(peerDir, "sealed round-trip");
    writeConfig(peerDir, requiredPeerConfig());
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);

    const posture = await fetchPeerTransportPosture(peerUrl);
    expect(posture.mode).toBe("required");
    expect(posture.publicKey).toBeTruthy();

    const session = await handshakeWithPeer(peerUrl, { expectedHostKey: posture.publicKey });

    // A correctly-sealed GET decrypts back into the peer's digest, which lists the seeded message.
    const digestResponse = await sealedFetch(session, peerUrl, "/api/sync/digest");
    expect(digestResponse.ok).toBe(true);
    const digest = SyncDigestSchema.parse(JSON.parse(digestResponse.text));
    expect(digest.messages.some((entry) => entry.id === seededId)).toBe(true);

    // A correctly-sealed POST body decrypts server-side and returns the requested message.
    const messagesResponse = await sealedFetch(session, peerUrl, "/api/sync/messages", { body: { ids: [seededId] } });
    expect(messagesResponse.ok).toBe(true);
    const payload = JSON.parse(messagesResponse.text) as { messages: { id: string }[] };
    expect(payload.messages.some((message) => message.id === seededId)).toBe(true);

    // AAD binding: a frame sealed for one route can't be replayed to another. Hand-seal a valid
    // messages body but bind it to the WRONG aad (`GET /api/sync/digest`) and present it at
    // `/api/sync/messages` — the peer opens with aad `POST /api/sync/messages`, the tag won't verify,
    // and it refuses with 400 rather than running the request.
    const tampered = sealTransport(session.key, JSON.stringify({ ids: [seededId] }), "GET /api/sync/digest");
    const tamperResponse = await fetch(`${peerUrl}/api/sync/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-loam-enc": session.sessionId },
      body: JSON.stringify({ enc: tampered }),
    });
    expect(tamperResponse.status).toBe(400);

    // A bogus/expired session id is refused (401) when no re-handshake is offered.
    const bogus = { sessionId: "not-a-real-session", key: session.key, hostPublicKey: session.hostPublicKey, seq: 0 };
    const refused = await sealedFetch(bogus, peerUrl, "/api/sync/digest");
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(401);

    // A pinned key that doesn't match the peer's advertised key fails the handshake closed.
    await expect(handshakeWithPeer(peerUrl, { expectedHostKey: "aGVsbG8td29ybGQ" })).rejects.toThrow();
  });

  it("(b2) a replayed sealed sync request is refused by the peer's {s,b} replay window (409)", async () => {
    const peerDir = makeDataDir();
    const seededId = await seedPublicMessage(peerDir, "replay protection");
    writeConfig(peerDir, requiredPeerConfig());
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);

    const session = await handshakeWithPeer(peerUrl);

    // Hand-seal a valid messages request with sequence 1 and send it directly. The first delivery is
    // accepted (fresh sequence advances the window); byte-for-byte replaying the SAME sealed envelope
    // reuses sequence 1, which the peer's sliding replay window rejects with 409 (docs/08) — proving the
    // {s,b} anti-replay envelope reconciled with the transport-hardening merge actually protects sync.
    const aad = "POST /api/sync/messages";
    const sealed = JSON.stringify({
      enc: sealTransport(session.key, JSON.stringify({ s: 1, b: { ids: [seededId] } }), aad),
    });
    const send = () =>
      fetch(`${peerUrl}/api/sync/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-loam-enc": session.sessionId },
        body: sealed,
      });

    const first = await send();
    expect(first.status).toBe(200);
    const replay = await send();
    expect(replay.status).toBe(409);
  });

  it("(b3) rejects an UNSEALED 2xx response rather than importing it as sync data (downgrade guard)", async () => {
    const peerDir = makeDataDir();
    await seedPublicMessage(peerDir, "downgrade guard");
    writeConfig(peerDir, requiredPeerConfig());
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);

    const session = await handshakeWithPeer(peerUrl);

    // A fetch that answers 200 with plaintext and NO `x-loam-enc: 1` — a downgrade (or an active MITM
    // returning attacker-chosen data). Over a live sealed session a genuine peer ALWAYS seals its reply,
    // so `sealedFetch` must refuse this rather than hand the plaintext back to be imported.
    const downgradeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ messages: [{ id: "poison" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(
      sealedFetch(session, peerUrl, "/api/sync/digest", { fetchImpl: downgradeFetch }),
    ).rejects.toThrow(/unauthenticated|unsealed/i);
  });

  it("(b4) authorizes a token-gated peer via the token SEALED in the envelope, never a wire header", async () => {
    const peerDir = makeDataDir();
    const seededId = await seedPublicMessage(peerDir, "sealed token");
    writeConfig(peerDir, {
      security: { transportEncryption: "required" },
      sync: { enabled: true, peers: [], token: "s3cr3t-sync-token" },
    });
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);
    const session = await handshakeWithPeer(peerUrl);

    // No token → the peer 404s (token required, none presented) — a tokenless digest is a sealed POST
    // carrying just `{ s }`, whose sealed reply is a 404.
    const noToken = await sealedFetch(session, peerUrl, "/api/sync/digest");
    expect(noToken.status).toBe(404);

    // With the token: it must ride INSIDE the sealed envelope, never as an `x-loam-sync-token` wire header
    // (that's the whole point — a bearer credential an observer must not be able to read).
    let sawTokenHeader = false;
    const spyFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.has("x-loam-sync-token")) {
        sawTokenHeader = true;
      }
      return fetch(input, init);
    };
    const withToken = await sealedFetch(session, peerUrl, "/api/sync/digest", {
      syncToken: "s3cr3t-sync-token",
      fetchImpl: spyFetch,
    });
    expect(sawTokenHeader).toBe(false);
    expect(withToken.ok).toBe(true);
    const digest = SyncDigestSchema.parse(JSON.parse(withToken.text));
    expect(digest.messages.some((entry) => entry.id === seededId)).toBe(true);
  });

  it("(b5) ignores a plaintext x-loam-sync-token header on an ENCRYPTED session (must be sealed)", async () => {
    const peerDir = makeDataDir();
    await seedPublicMessage(peerDir, "header ignored");
    writeConfig(peerDir, {
      security: { transportEncryption: "required" },
      sync: { enabled: true, peers: [], token: "header-ignored-token" },
    });
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);
    const session = await handshakeWithPeer(peerUrl);

    // Hand-seal a digest request with NO `tok` in the envelope but attach the CORRECT token as a wire
    // header. A sealed session must authenticate only via the sealed token, so the header is ignored → 404.
    const sealed = JSON.stringify({
      enc: sealTransport(session.key, JSON.stringify({ s: 1 }), "POST /api/sync/digest"),
    });
    const res = await fetch(`${peerUrl}/api/sync/digest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-loam-enc": session.sessionId,
        "x-loam-sync-token": "header-ignored-token",
      },
      body: sealed,
    });
    expect(res.status).toBe(404);
  });

  it("(b6) rejects a response bound to a DIFFERENT request sequence (no cross-feed / replay)", async () => {
    const peerDir = makeDataDir();
    await seedPublicMessage(peerDir, "response binding");
    writeConfig(peerDir, requiredPeerConfig());
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);
    const session = await handshakeWithPeer(peerUrl);

    // Capture the genuine sealed response to the first request (sequence 1).
    let captured = "";
    const captureFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      captured = await response.clone().text();
      return response;
    };
    const first = await sealedFetch(session, peerUrl, "/api/sync/digest", { fetchImpl: captureFetch });
    expect(first.ok).toBe(true);

    // A second request advances to sequence 2, but the peer "replays" the sequence-1 response. It was
    // sealed under `POST /api/sync/digest#1`, so opening it under `#2` fails and `sealedFetch` rejects it
    // rather than accepting a stale/cross-fed response (docs/08 / Sol round-2 #1).
    const replayFetch: typeof fetch = async () =>
      new Response(captured, { status: 200, headers: { "content-type": "application/json", "x-loam-enc": "1" } });
    await expect(
      sealedFetch(session, peerUrl, "/api/sync/digest", { fetchImpl: replayFetch }),
    ).rejects.toThrow();
  });

  it("(b7) a rate-limited digest surfaces as a clean 429, not 'session expired' + re-handshake churn", async () => {
    const peerDir = makeDataDir();
    await seedPublicMessage(peerDir, "rate limit");
    writeConfig(peerDir, requiredPeerConfig());
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);
    const session = await handshakeWithPeer(peerUrl);

    let reHandshakes = 0;
    const reHandshake = async () => {
      reHandshakes += 1;
      return handshakeWithPeer(peerUrl);
    };

    // The digest route is limited to 60/min. Fire past it; the request that trips the limiter gets a 429
    // sealed under the BASE aad (the limiter runs in `onRequest`, before the sequence is assigned). It must
    // surface as a clean 429 — not a decryption failure that reports "session expired" and churns a
    // re-handshake (docs/08 / Sol round-3 P2).
    let sawRateLimit = false;
    for (let i = 0; i < 65; i += 1) {
      const res = await sealedFetch(session, peerUrl, "/api/sync/digest", { reHandshake });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
      expect(res.ok).toBe(true);
    }
    expect(sawRateLimit).toBe(true);
    expect(reHandshakes).toBe(0);
  });

  it("(d) the puller re-handshakes once on a 401 and reuses one session across calls", async () => {
    const peerDir = makeDataDir();
    const seededId = await seedPublicMessage(peerDir, "cache and re-handshake");
    writeConfig(peerDir, requiredPeerConfig());
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);

    // A counting fetch that records every handshake attempt, delegating to the real fetch otherwise.
    let handshakeCalls = 0;
    const countingFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/transport/handshake")) {
        handshakeCalls += 1;
      }
      return fetch(input, init);
    };

    const session = await handshakeWithPeer(peerUrl, { fetchImpl: countingFetch });
    expect(handshakeCalls).toBe(1);

    // Two sealed calls reuse the one session — no per-call handshake.
    await sealedFetch(session, peerUrl, "/api/sync/digest", { fetchImpl: countingFetch });
    await sealedFetch(session, peerUrl, "/api/sync/messages", { body: { ids: [seededId] }, fetchImpl: countingFetch });
    expect(handshakeCalls).toBe(1);

    // Simulate an expired session (unknown id): the peer answers 401, so `sealedFetch` re-handshakes
    // exactly once via the callback and retries — the retry succeeds and decrypts the digest.
    const stale = { sessionId: "expired-session-id", key: session.key, hostPublicKey: session.hostPublicKey, seq: 0 };
    let reHandshakeCalls = 0;
    const retried = await sealedFetch(stale, peerUrl, "/api/sync/digest", {
      fetchImpl: countingFetch,
      reHandshake: async () => {
        reHandshakeCalls += 1;
        return handshakeWithPeer(peerUrl, { fetchImpl: countingFetch });
      },
    });
    expect(reHandshakeCalls).toBe(1);
    expect(handshakeCalls).toBe(2);
    expect(retried.ok).toBe(true);
    const digest = SyncDigestSchema.parse(JSON.parse(retried.text));
    expect(digest.messages.some((entry) => entry.id === seededId)).toBe(true);
  });

  it("(e) copies a public message's attachment across a REQUIRED peer via the sealed sync-attachment route", async () => {
    const peerDir = makeDataDir();
    const { messageId, attachmentUrl } = await seedPublicMessageWithAttachment(peerDir);
    writeConfig(peerDir, requiredPeerConfig());
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);

    // The tunnel-only binary route is 401 to a peer with no session — the reason a plain-fetch copy failed.
    expect((await fetch(`${peerUrl}${attachmentUrl}`)).status).toBe(401);

    const pullerDir = makeDataDir();
    writeConfig(pullerDir, { sync: { enabled: true, peers: [{ url: peerUrl }], intervalMs: 3_600_000 } });
    const puller = await buildOn(pullerDir);
    const cookie = await adminSession(puller);

    expect(await runSync(puller, cookie)).toBeUndefined();
    expect(hasMessage(puller, messageId)).toBe(true);

    // The attachment binary crossed too: the puller (off-mode) now serves it from its own store, which it
    // could only do if the base64-over-sealed-transport `/api/sync/attachment` fetch succeeded.
    const served = await puller.server.inject({ method: "GET", url: attachmentUrl });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.length).toBeGreaterThan(0);
  });
});

describe("sync transport encryption — puller-side session cache (integration)", () => {
  it("(d) caches a live transport session across sync rounds and re-handshakes after the peer restarts", async () => {
    // A counting reverse proxy in front of the peer: it forwards every request and counts handshakes,
    // so the puller's real `fetchPeerJson` wiring can be observed end-to-end. Its backend can be
    // repointed when the peer restarts, keeping the peer URL the puller holds stable.
    let backend = "";
    let handshakeCount = 0;
    const proxy = createServer((req, res) => {
      if ((req.url ?? "") === "/api/transport/handshake") {
        handshakeCount += 1;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          try {
            const method = req.method ?? "GET";
            const bodyless = method === "GET" || method === "HEAD";
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(req.headers)) {
              if (typeof value === "string" && name !== "host" && name !== "content-length" && name !== "connection") {
                headers[name] = value;
              }
            }
            const upstream = await fetch(`${backend}${req.url ?? ""}`, {
              method,
              headers,
              body: bodyless ? undefined : Buffer.concat(chunks),
            });
            const outHeaders: Record<string, string> = {};
            const contentType = upstream.headers.get("content-type");
            const enc = upstream.headers.get("x-loam-enc");
            if (contentType) outHeaders["content-type"] = contentType;
            if (enc) outHeaders["x-loam-enc"] = enc;
            res.writeHead(upstream.status, outHeaders);
            res.end(Buffer.from(await upstream.arrayBuffer()));
          } catch {
            res.writeHead(502);
            res.end("proxy error");
          }
        })();
      });
    });
    const proxyUrl = await new Promise<string>((resolve) => {
      proxy.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`));
    });
    cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));

    const peerDir = makeDataDir();
    const id1 = await seedPublicMessage(peerDir, "first message");
    writeConfig(peerDir, requiredPeerConfig());
    const peer = await buildOn(peerDir);
    backend = await listen(peer);

    const pullerDir = makeDataDir();
    writeConfig(pullerDir, { sync: { enabled: true, peers: [{ url: proxyUrl }], intervalMs: 3_600_000 } });
    const puller = await buildOn(pullerDir);
    const cookie = await adminSession(puller);

    // First round: one handshake, first message imported.
    expect(await runSync(puller, cookie)).toBeUndefined();
    expect(hasMessage(puller, id1)).toBe(true);
    expect(handshakeCount).toBe(1);

    // Second round: the cached session is reused — no new handshake (autonomous ticks reuse it too, so
    // this is stable regardless of the 5s ticker).
    expect(await runSync(puller, cookie)).toBeUndefined();
    expect(handshakeCount).toBe(1);

    // Restart the peer: its RAM session map is cleared (the persisted static key is unchanged), so the
    // puller's cached session id is now unknown → 401 → exactly one re-handshake, then the new message
    // syncs.
    await peer.close();
    const id2 = await seedPublicMessage(peerDir, "second message");
    writeConfig(peerDir, requiredPeerConfig());
    const peer2 = await buildOn(peerDir);
    backend = await listen(peer2);

    expect(await runSync(puller, cookie)).toBeUndefined();
    expect(handshakeCount).toBe(2);
    expect(hasMessage(puller, id2)).toBe(true);
  });

  it("(d2) keeps a continuous replay sequence after a POST-leg re-handshake (token peer → digest is a POST)", async () => {
    // Same proxy indirection as (d), but the peer requires a sync token — so the token rides sealed and the
    // digest is a POST. When the peer restarts, the re-handshake now happens ON A POST leg, whose retry
    // consumes sequence 1. Regression guard for the split-session bug: before the fix the cache kept a
    // detached object at sequence 0, so the NEXT round's POST reused sequence 1 and the peer 409'd it.
    let backend = "";
    const proxy = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          try {
            const method = req.method ?? "GET";
            const bodyless = method === "GET" || method === "HEAD";
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(req.headers)) {
              if (typeof value === "string" && name !== "host" && name !== "content-length" && name !== "connection") {
                headers[name] = value;
              }
            }
            const upstream = await fetch(`${backend}${req.url ?? ""}`, {
              method,
              headers,
              body: bodyless ? undefined : Buffer.concat(chunks),
            });
            const outHeaders: Record<string, string> = {};
            const contentType = upstream.headers.get("content-type");
            const enc = upstream.headers.get("x-loam-enc");
            if (contentType) outHeaders["content-type"] = contentType;
            if (enc) outHeaders["x-loam-enc"] = enc;
            res.writeHead(upstream.status, outHeaders);
            res.end(Buffer.from(await upstream.arrayBuffer()));
          } catch {
            res.writeHead(502);
            res.end("proxy error");
          }
        })();
      });
    });
    const proxyUrl = await new Promise<string>((resolve) => {
      proxy.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`));
    });
    cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));

    const token = "shared-sync-token";
    const peerConfig = { security: { transportEncryption: "required" }, sync: { enabled: true, peers: [], token } };
    const peerDir = makeDataDir();
    const id1 = await seedPublicMessage(peerDir, "first");
    writeConfig(peerDir, peerConfig);
    const peer = await buildOn(peerDir);
    backend = await listen(peer);

    const pullerDir = makeDataDir();
    writeConfig(pullerDir, { sync: { enabled: true, peers: [{ url: proxyUrl }], intervalMs: 3_600_000, token } });
    const puller = await buildOn(pullerDir);
    const cookie = await adminSession(puller);

    expect(await runSync(puller, cookie)).toBeUndefined();
    expect(hasMessage(puller, id1)).toBe(true);

    // Restart the peer → its RAM sessions clear, so the next round's POST digest 401s and re-handshakes.
    await peer.close();
    const id2 = await seedPublicMessage(peerDir, "second");
    writeConfig(peerDir, peerConfig);
    const peer2 = await buildOn(peerDir);
    backend = await listen(peer2);

    // The post-restart round re-handshakes on the POST DIGEST leg (sequence 1), then fetches id2 with a
    // MESSAGES POST on the same session. Before the fix the cache held a detached object, so the messages
    // POST reused sequence 1 and the peer 409'd it — id2 would silently never import. With one shared
    // session object the sequence continues and id2 arrives.
    expect(await runSync(puller, cookie)).toBeUndefined();
    expect(hasMessage(puller, id2)).toBe(true);
  });
});

describe("sync transport encryption — OFF peer", () => {
  it("(c) an off-mode peer still syncs over the unchanged plaintext path", async () => {
    const peerDir = makeDataDir();
    const seededId = await seedPublicMessage(peerDir, "plaintext peer message");
    // Off transport, but sync enabled so it serves the digest/messages endpoints.
    writeConfig(peerDir, { sync: { enabled: true, peers: [] } });
    const peer = await buildOn(peerDir);
    const peerUrl = await listen(peer);

    // The peer advertises `off`, and its sync digest is reachable in plaintext (no handshake needed).
    const posture = await fetchPeerTransportPosture(peerUrl);
    expect(posture.mode).toBe("off");
    expect((await fetch(`${peerUrl}/api/sync/digest`)).status).toBe(200);
    // A required node exposes no plaintext digest; an off node does — proving the puller takes the
    // plaintext branch here.
    expect((await fetch(`${peerUrl}/api/transport/handshake`, { method: "POST" })).status).toBe(404);

    const pullerDir = makeDataDir();
    writeConfig(pullerDir, { sync: { enabled: true, peers: [{ url: peerUrl }], intervalMs: 3_600_000 } });
    const puller = await buildOn(pullerDir);
    const cookie = await adminSession(puller);

    expect(await runSync(puller, cookie)).toBeUndefined();
    expect(hasMessage(puller, seededId)).toBe(true);
  });
});
