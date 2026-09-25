import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMeshIdentity,
  currentEpoch,
  mailboxTag,
  openTransport,
  sealMailbox,
  sealTransport,
  transportClientDerive,
  transportClientHello,
} from "@loam/crypto";
import { MeshIdentityCardSchema, TransportHandshakeResponseSchema } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import type { AppOptions } from "./types.js";

/**
 * Pre-release review 2026-09-25 — sync / mesh / kill-switch / transport fixes. Each security test here
 * was mutation-checked: with its fix reverted, it fails.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** A fresh app on its own temp data dir (optional config.json + options), cleaned up after the test. */
async function makeApp(config?: unknown, opts?: Partial<AppOptions>): Promise<{ app: LoamApp; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-review-0925-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
}

/** A fresh cookie session (the first one on a firstUser node is the admin). */
async function newSession(app: LoamApp): Promise<{ cookie: string; userId: string }> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  if (!cookie) {
    throw new Error("no session cookie");
  }
  return { cookie, userId: (response.json() as { currentUser: { id: string } }).currentUser.id };
}

describe("Emergency Reset sweeps preserve-recovery snapshots in every branch (#7)", () => {
  /** Plant a `.loam-recovery-*` snapshot dir (with an old DB copy) + the recovery anchor after boot. */
  function plantRecoveryArtifacts(dataDir: string): string[] {
    const snapshot = join(dataDir, ".loam-recovery-1700000000000-abcd");
    mkdirSync(join(snapshot, "avatars"), { recursive: true });
    writeFileSync(join(snapshot, "loam.db"), "old still-readable database");
    writeFileSync(join(snapshot, "avatars", "a.png"), "old avatar");
    const anchor = join(dataDir, ".loam-recovery-state");
    writeFileSync(anchor, ".loam-recovery-1700000000000-abcd");
    return [snapshot, anchor];
  }

  async function wipe(app: LoamApp): Promise<number> {
    const admin = await newSession(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    return res.statusCode;
  }

  it("plaintext (logical) wipe removes the snapshot dir and the anchor", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const planted = plantRecoveryArtifacts(dataDir);
    expect(await wipe(app)).toBe(200);
    for (const path of planted) {
      expect(existsSync(path)).toBe(false);
    }
  });

  it("ephemeral-key (cryptographic) wipe removes the snapshot dir and the anchor", async () => {
    const { app, dataDir } = await makeApp(
      { killSwitch: { enabled: true } },
      { ephemeralDbKey: true, dbEncryptionMode: "ephemeral" },
    );
    const planted = plantRecoveryArtifacts(dataDir);
    expect(await wipe(app)).toBe(200);
    for (const path of planted) {
      expect(existsSync(path)).toBe(false);
    }
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

describe("request logs never reveal tunnelled paths or query strings (#10)", () => {
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

  it("strips the query string from every logged request URL", async () => {
    const { app, logs } = await makeLoggedApp();
    expect((await app.server.inject({ method: "GET", url: "/api/health?probe=DIRECT_QUERY_SECRET" })).statusCode).toBe(200);
    const text = logs.join("");
    expect(text).toContain("/api/health");
    expect(text).not.toContain("DIRECT_QUERY_SECRET");
  });
});

// ---- Sync / mesh pulls against a scripted peer ---------------------------------------------------------

type PeerRequest = { path: string; headers: IncomingHttpHeaders; body: unknown };
type FakePeer = { url: string; requests: PeerRequest[] };

/** A scripted plaintext "peer": `respond(path, body)` returns the JSON (object or raw string) to serve, or
 *  `undefined` for a 404 (so `/api/bootstrap` 404s unless scripted → the puller's plaintext fallback). */
async function fakePeer(
  respond: (path: string, body: unknown) => unknown | Promise<unknown>,
): Promise<FakePeer> {
  const requests: PeerRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = undefined;
        }
        const path = req.url ?? "";
        requests.push({ path, headers: req.headers, body });
        const out = await respond(path, body);
        if (out === undefined) {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(typeof out === "string" ? out : JSON.stringify(out));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** Every id the puller asked the peer for, across all `/api/sync/messages` requests (with repeats). */
function requestedIds(peer: FakePeer): string[] {
  return peer.requests
    .filter((request) => request.path === "/api/sync/messages")
    .flatMap((request) => ((request.body as { ids?: string[] } | undefined)?.ids ?? []));
}

/** Force one sync round; returns the (single) peer's status. */
async function syncRound(app: LoamApp, cookie: string): Promise<{ lastError?: string; lastSuccessAt?: number; imported: number }> {
  const res = await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { peers: { status: { lastError?: string; lastSuccessAt?: number; imported: number } }[] }).peers[0]
    .status;
}

const DAY_MS = 24 * 3_600_000;
const peerAuthor = { id: "user.peerauthor", displayName: "Peer Author", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };

/** A public `general` post record as a peer would serve it. */
function peerPost(id: string, body = "hello from the peer", authorId = peerAuthor.id) {
  return { id, type: "channelPost", authorId, channelId: "general", body, createdAt: 1_000 };
}

/** A sealed record (canonical blob) addressed to `toTag`, sealed to `recipientKx` (or to a stranger). */
function sealedRecord(
  id: string,
  options: { toTag?: string; recipientKx?: string; ttlExpiresAt?: number; hopLimit?: number; plaintext?: string } = {},
) {
  const now = Date.now();
  const ttlExpiresAt = options.ttlExpiresAt ?? now + 3_600_000;
  const toTag = options.toTag ?? mailboxTag(createMeshIdentity().mailboxToken, currentEpoch(now, DAY_MS));
  const sender = createMeshIdentity();
  const sealed = sealMailbox({
    recipientKxPublic: options.recipientKx ?? createMeshIdentity().kxPublic,
    sender: { signPublic: sender.signPublic, signSecret: sender.signSecret, kxPublic: sender.kxPublic },
    plaintext: options.plaintext ?? "sealed hello",
    aad: `${toTag}|${ttlExpiresAt}`,
  });
  return { id, type: "sealed", authorId: "mesh.sealed", createdAt: now, toTag, sealed, ttlExpiresAt, hopLimit: options.hopLimit ?? 3 };
}

/** A peer serving a fixed set of records: the digest advertises them, `/api/sync/messages` returns the asked ones. */
function servingPeer(records: Record<string, unknown>[], users: unknown[] = [peerAuthor]): Promise<FakePeer> {
  return fakePeer((path, body) => {
    if (path === "/api/sync/digest") {
      return {
        channels: [],
        messages: records.filter((record) => record.type !== "sealed").map((record) => ({ id: record.id })),
        sealed: records
          .filter((record) => record.type === "sealed")
          .map(({ id, toTag, ttlExpiresAt, hopLimit }) => ({ id, toTag, ttlExpiresAt, hopLimit })),
      };
    }
    if (path === "/api/sync/messages") {
      const ids = new Set((body as { ids: string[] }).ids);
      return { messages: records.filter((record) => ids.has(record.id as string)), users };
    }
    return undefined;
  });
}

/** A puller node syncing from `peerUrl` (plus extra config), with its admin session. */
async function puller(peerUrl: string, config: Record<string, unknown> = {}) {
  const { app, dataDir } = await makeApp({ ...config, sync: { enabled: true, peers: [{ url: peerUrl }], ...(config.sync as object) } });
  const admin = await newSession(app);
  return { app, dataDir, admin };
}

const MESH_RELAY = { enabled: true, relay: true, ttlMs: 3_600_000, hopLimit: 6, maxCarried: 1000, maxContacts: 1000 };
const MESH_NO_RELAY = { ...MESH_RELAY, relay: false };

describe("sealed pulls: no refetch loop, no endpoint leak, sender-chosen TTL (#1 #4 #5 #6)", () => {
  it("a hop-1 blob a relay can't carry is fetched once, not every round", async () => {
    const hop1 = sealedRecord("seal_hop1", { hopLimit: 1 });
    const peer = await servingPeer([hop1]);
    const { app, admin } = await puller(peer.url, { mesh: MESH_RELAY });
    for (let round = 0; round < 3; round += 1) {
      await syncRound(app, admin.cookie);
    }
    expect(requestedIds(peer).filter((id) => id === "seal_hop1")).toHaveLength(1);
    expect(app.store.loadMessages().some((message) => message.id === "seal_hop1")).toBe(false);
  });

  it("with relaying OFF it pulls every offered blob, not just the ones addressed here — and delivers its own", async () => {
    // The puller first, so its user's card (mailbox token + kx) can address one of the blobs.
    let records: Record<string, unknown>[] = [];
    const peer = await fakePeer((path, body) => {
      if (path === "/api/sync/digest") {
        return {
          channels: [],
          messages: [],
          sealed: records.map(({ id, toTag, ttlExpiresAt, hopLimit }) => ({ id, toTag, ttlExpiresAt, hopLimit })),
        };
      }
      if (path === "/api/sync/messages") {
        const ids = new Set((body as { ids: string[] }).ids);
        return { messages: records.filter((record) => ids.has(record.id as string)), users: [] };
      }
      return undefined;
    });
    const { app, admin } = await puller(peer.url, { mesh: MESH_NO_RELAY });
    const card = MeshIdentityCardSchema.parse(
      (await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie: admin.cookie } })).json(),
    );
    const mine = sealedRecord("seal_mine", {
      toTag: mailboxTag(card.mailboxToken, currentEpoch(Date.now(), DAY_MS)),
      recipientKx: card.kx,
      plaintext: "addressed to this node",
    });
    const foreign = sealedRecord("seal_foreign");
    records = [mine, foreign];

    await syncRound(app, admin.cookie);
    // Both were fetched — what the serving peer sees no longer singles out the locally addressed blob.
    expect(new Set(requestedIds(peer))).toEqual(new Set(["seal_mine", "seal_foreign"]));
    // Ours was delivered; the foreign one was dropped (relaying is off), not stored.
    const stored = app.store.loadMessages();
    expect(stored.some((message) => message.type === "dm" && message.body === "addressed to this node")).toBe(true);
    expect(stored.some((message) => message.id === "seal_foreign")).toBe(false);

    // ...and the dropped blob is remembered: later rounds don't download it again.
    await syncRound(app, admin.cookie);
    await syncRound(app, admin.cookie);
    expect(requestedIds(peer).filter((id) => id === "seal_foreign")).toHaveLength(1);
  });

  it("recognises mail whose sender chose a longer TTL than this node's own mesh.ttlMs", async () => {
    let records: Record<string, unknown>[] = [];
    const peer = await fakePeer((path, body) => {
      if (path === "/api/sync/digest") {
        return {
          channels: [],
          messages: [],
          sealed: records.map(({ id, toTag, ttlExpiresAt, hopLimit }) => ({ id, toTag, ttlExpiresAt, hopLimit })),
        };
      }
      if (path === "/api/sync/messages") {
        const ids = new Set((body as { ids: string[] }).ids);
        return { messages: records.filter((record) => ids.has(record.id as string)), users: [] };
      }
      return undefined;
    });
    // This node keeps its OWN mail for a minute; a sender elsewhere sealed 3 days ago with a 6-day TTL.
    const { app, admin } = await puller(peer.url, { mesh: { ...MESH_NO_RELAY, ttlMs: 60_000 } });
    const card = MeshIdentityCardSchema.parse(
      (await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie: admin.cookie } })).json(),
    );
    const sentAt = Date.now() - 3 * DAY_MS;
    records = [
      sealedRecord("seal_old_but_live", {
        toTag: mailboxTag(card.mailboxToken, currentEpoch(sentAt, DAY_MS)),
        recipientKx: card.kx,
        ttlExpiresAt: sentAt + 6 * DAY_MS,
        plaintext: "sealed three days ago",
      }),
    ];
    await syncRound(app, admin.cookie);
    expect(app.store.loadMessages().some((message) => message.type === "dm" && message.body === "sealed three days ago")).toBe(true);
  });
});

describe("byte-budgeted sync batches (#2)", () => {
  it("splits a batch whose response blows the size cap, imports the rest, and skips an unusable record", async () => {
    const posts = ["msg.big1", "msg.big2", "msg.big3"].map((id) => peerPost(id, `body of ${id}`));
    const peer = await fakePeer((path, body) => {
      if (path === "/api/sync/digest") {
        return { channels: [], messages: [...posts, { id: "msg.broken" }].map((post) => ({ id: post.id })) };
      }
      if (path === "/api/sync/messages") {
        const ids = (body as { ids: string[] }).ids;
        if (ids.length > 1) {
          // More than the 8 MB plaintext cap — as 200 long CJK posts or a pile of 90 KB sealed blobs would be.
          return JSON.stringify({ messages: [], users: [], pad: "x".repeat(9 * 1024 * 1024) });
        }
        if (ids[0] === "msg.broken") {
          return { messages: [{ id: "msg.broken", type: "channelPost" }], users: [] }; // fails the schema
        }
        return { messages: posts.filter((post) => post.id === ids[0]), users: [peerAuthor] };
      }
      return undefined;
    });
    const { app, admin } = await puller(peer.url);

    const status = await syncRound(app, admin.cookie);
    expect(status.lastError).toBeUndefined();
    expect(status.lastSuccessAt).toBeTypeOf("number");
    const stored = new Set(app.store.loadMessages().map((message) => message.id));
    for (const post of posts) {
      expect(stored.has(post.id)).toBe(true);
    }

    // The unusable record is remembered; the next round asks for nothing at all.
    const before = requestedIds(peer).length;
    await syncRound(app, admin.cookie);
    expect(requestedIds(peer).length).toBe(before);
  });
});

describe("refused new messages are remembered per peer, not refetched every round (#6)", () => {
  it("a reply to a deleted post and an over-cap body are each fetched once", async () => {
    let parentId = "";
    const oversized = peerPost("msg.oversized", "x".repeat(300 * 1024));
    const records = () => [
      { id: "msg.orphan", type: "channelReply", authorId: peerAuthor.id, channelId: "general", parentMessageId: parentId, body: "late reply", createdAt: 2_000 },
      oversized,
    ];
    const peer = await fakePeer((path, body) => {
      if (path === "/api/sync/digest") {
        return { channels: [], messages: records().map((record) => ({ id: record.id })) };
      }
      if (path === "/api/sync/messages") {
        const ids = new Set((body as { ids: string[] }).ids);
        return { messages: records().filter((record) => ids.has(record.id)), users: [peerAuthor] };
      }
      return undefined;
    });
    const { app, admin } = await puller(peer.url);
    // A local post, then deleted — its id is tombstoned here, so replies to it are refused.
    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "soon gone" },
    });
    parentId = (post.json() as { message: { id: string } }).message.id;
    expect(
      (await app.server.inject({ method: "DELETE", url: `/api/messages/${parentId}`, headers: { cookie: admin.cookie } })).statusCode,
    ).toBeLessThan(300);

    for (let round = 0; round < 3; round += 1) {
      await syncRound(app, admin.cookie);
    }
    const asked = requestedIds(peer);
    expect(asked.filter((id) => id === "msg.orphan")).toHaveLength(1);
    expect(asked.filter((id) => id === "msg.oversized")).toHaveLength(1);
    const stored = new Set(app.store.loadMessages().map((message) => message.id));
    expect(stored.has("msg.orphan")).toBe(false);
    expect(stored.has("msg.oversized")).toBe(false);
  });
});

describe("peer users: only accepted authors, no reserved ids, no mesh keys minted for them (#3 #8)", () => {
  it("imports just the author of an accepted message and refuses mesh.* / bot-id records and authors", async () => {
    const peerKey = createMeshIdentity();
    const author = {
      ...peerAuthor,
      identityKey: { alg: "ed25519", sign: peerKey.signPublic, kx: peerKey.kxPublic, kxSig: peerKey.kxSig },
    };
    const bystander = { ...peerAuthor, id: "user.bystander", displayName: "Never posted" };
    const meshSender = { ...peerAuthor, id: "mesh.aaaaaaaaaaaaaaaaaaaaaaaaaa", displayName: "Pre-named sender" };
    const bot = { ...peerAuthor, id: "llm.ollama.gemma4", displayName: "Not your bot", type: "bot" };
    const records = [
      peerPost("msg.fine"),
      peerPost("msg.by-mesh", "spoofed mesh sender", meshSender.id),
      peerPost("msg.by-bot", "spoofed assistant", bot.id),
    ];
    const peer = await servingPeer(records, [author, bystander, meshSender, bot]);
    const { app, dataDir, admin } = await puller(peer.url, { mesh: MESH_NO_RELAY });

    await syncRound(app, admin.cookie);
    const users = new Map(app.store.loadUsers().map((user) => [user.id, user]));
    expect(users.has(author.id)).toBe(true);
    expect(users.has(bystander.id)).toBe(false);
    expect(users.has(meshSender.id)).toBe(false);
    expect(users.has(bot.id)).toBe(false);
    const stored = new Set(app.store.loadMessages().map((message) => message.id));
    expect(stored.has("msg.fine")).toBe(true);
    expect(stored.has("msg.by-mesh")).toBe(false);
    expect(stored.has("msg.by-bot")).toBe(false);

    // A restart runs ensureAllMeshIdentities: it must not mint a secret keypair for the imported user nor
    // overwrite the key their home node published.
    await app.close();
    const reopened = await buildApp({ dataDir, logger: false });
    cleanups.push(() => reopened.close());
    expect(reopened.store.loadMeshIdentities().some((row) => row.userId === author.id)).toBe(false);
    expect(reopened.store.loadUsers().find((user) => user.id === author.id)?.identityKey?.sign).toBe(peerKey.signPublic);
  });

  it("boot drops a mesh identity an older build minted for a synced user, and strips the forged key", async () => {
    const peer = await servingPeer([peerPost("msg.fine")]);
    const { app, dataDir, admin } = await puller(peer.url, { mesh: MESH_NO_RELAY });
    await syncRound(app, admin.cookie);
    // What the old ensureAllMeshIdentities left behind: a local secret for the synced user, published as theirs.
    const forged = createMeshIdentity();
    app.store.upsertMeshIdentity(peerAuthor.id, JSON.stringify(forged));
    const synced = app.store.loadUsers().find((user) => user.id === peerAuthor.id)!;
    app.store.upsertUser({ ...synced, identityKey: { alg: "ed25519", sign: forged.signPublic, kx: forged.kxPublic, kxSig: forged.kxSig } });

    await app.close();
    const reopened = await buildApp({ dataDir, logger: false });
    cleanups.push(() => reopened.close());
    // The row is DELETED, not overwritten with a placeholder.
    expect(reopened.store.loadMeshIdentities().some((entry) => entry.userId === peerAuthor.id)).toBe(false);
    expect(reopened.store.loadUsers().find((user) => user.id === peerAuthor.id)?.identityKey).toBeUndefined();
  });
});

describe("a kill switch mid attachment fetch leaves no pre-wipe work item (#9)", () => {
  it("does not record a missing-attachment row into the fresh post-wipe store", async () => {
    let sawAttachmentRequest!: () => void;
    const attachmentRequested = new Promise<void>((resolve) => (sawAttachmentRequest = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const withAttachment = {
      ...peerPost("msg.with-image", ""),
      attachments: [{ id: "att_0123456789abcdef", mimeType: "image/png", width: 1, height: 1 }],
    };
    const peer = await fakePeer(async (path, body) => {
      if (path === "/api/sync/digest") {
        return { channels: [], messages: [{ id: withAttachment.id }] };
      }
      if (path === "/api/sync/messages") {
        void body;
        return { messages: [withAttachment], users: [peerAuthor] };
      }
      if (path.startsWith("/api/attachments/")) {
        sawAttachmentRequest();
        await gate;
        return undefined; // 404 → the fetch fails → the catch path that records a work item
      }
      return undefined;
    });
    const { app, admin } = await puller(peer.url, { killSwitch: { enabled: true, requireConfirmation: false } });

    const round = app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: admin.cookie } });
    await attachmentRequested;
    try {
      const wipe = await app.server.inject({ method: "POST", url: "/api/admin/kill-switch", headers: { cookie: admin.cookie }, payload: {} });
      expect(wipe.statusCode).toBe(200);
    } finally {
      release();
    }
    await round;
    expect(app.store.loadDueMissingAttachments(Date.now() + 365 * DAY_MS, 100)).toEqual([]);
  });
});

describe("the sync token never goes out in plaintext; no silent downgrade (#13)", () => {
  it("a REQUIRED node refuses to pull from a plaintext peer at all, and says why", async () => {
    const peer = await servingPeer([peerPost("msg.fine")]);
    // A required node serves its admin only through the tunnel, so drive the sync run through one.
    const { app } = await makeApp({
      sync: { enabled: true, peers: [{ url: peer.url }] },
      security: { profile: "custom", transportEncryption: "required" },
    });
    const tunnel = await boundTunnel(app);
    const run = await tunnel("POST", "/api/admin/sync/run", {});
    expect(run.status).toBe(200);
    const status = (run.json as { peers: { status: { lastError?: string } }[] }).peers[0].status;
    expect(status.lastError).toMatch(/requires transport encryption/);
    expect(peer.requests.some((request) => request.path.startsWith("/api/sync/"))).toBe(false);
  });

  it("an OPTIONAL node pulls a plaintext peer without presenting the sync token", async () => {
    const peer = await servingPeer([peerPost("msg.fine")]);
    const { app, admin } = await puller(peer.url, { sync: { token: "shared-node-secret" } });
    await syncRound(app, admin.cookie);
    const syncRequests = peer.requests.filter((request) => request.path.startsWith("/api/sync/"));
    expect(syncRequests.length).toBeGreaterThan(0);
    for (const request of syncRequests) {
      expect(request.headers["x-loam-sync-token"]).toBeUndefined();
      expect(JSON.stringify(request.body ?? "")).not.toContain("shared-node-secret");
    }
  });

  it("refuses a plaintext fallback for a peer that negotiated encryption earlier (downgrade)", async () => {
    // A real LOAM peer behind a switchable front: first a transparent proxy, then a plaintext impostor that
    // hides `/api/bootstrap` (what an on-path attacker would do to force the plaintext path).
    const { app: real } = await makeApp({ sync: { enabled: true, peers: [] } });
    const realUrl = await real.server.listen({ host: "127.0.0.1", port: 0 });
    let impostor = false;
    const front = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          const path = req.url ?? "";
          if (impostor) {
            if (path.startsWith("/api/sync/")) {
              impostorSyncHits += 1;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ channels: [], messages: [] }));
              return;
            }
            res.statusCode = 404;
            res.end("{}");
            return;
          }
          const headers: Record<string, string> = {};
          for (const name of ["content-type", "x-loam-enc", "x-loam-sync-token"]) {
            const value = req.headers[name];
            if (typeof value === "string") {
              headers[name] = value;
            }
          }
          const body = Buffer.concat(chunks);
          const upstream = await fetch(`${realUrl}${path}`, {
            method: req.method,
            headers,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
          });
          res.statusCode = upstream.status;
          for (const name of ["content-type", "x-loam-enc"]) {
            const value = upstream.headers.get(name);
            if (value) {
              res.setHeader(name, value);
            }
          }
          res.end(Buffer.from(await upstream.arrayBuffer()));
        })();
      });
    });
    let impostorSyncHits = 0;
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => front.close(() => resolve())));
    const frontUrl = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;

    const { app, admin } = await puller(frontUrl);
    const first = await syncRound(app, admin.cookie);
    expect(first.lastError).toBeUndefined(); // an encrypted round through the transparent front

    impostor = true;
    // A config edit drops cached transport sessions, forcing the next round to re-resolve the posture.
    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { peers: [{ url: frontUrl }] } },
    });
    expect(patch.statusCode).toBe(200);
    const second = await syncRound(app, admin.cookie);
    expect(second.lastError).toMatch(/negotiated encryption earlier/);
    expect(impostorSyncHits).toBe(0);
  });
});
