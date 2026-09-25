import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMeshIdentity, currentEpoch, mailboxTag, sealMailbox } from "@loam/crypto";
import { MeshIdentityCardSchema, type MeshIdentityCard } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import { openStore } from "./db.js";
import type { AppOptions } from "./types.js";

/**
 * Branch review 2026-09-25 (after cadf339): #2 — a peer bypassing the sealed-offer history (listing sealed
 * ids among PUBLIC messages, or re-advertising them with a later TTL once the first one lapsed) to learn
 * which blobs were delivered here; #3 — an in-flight sync edit undoing a moderator removal. Each test was
 * mutation-checked: with its fix reverted, it fails.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

const DAY_MS = 24 * 3_600_000;
const MESH_NO_RELAY = { enabled: true, relay: false, ttlMs: 3_600_000, hopLimit: 6, maxCarried: 1000, maxContacts: 1000 };

/** A fresh app on its own temp data dir (config.json + options), cleaned up after the test. */
async function makeApp(config: unknown, opts: Partial<AppOptions> = {}): Promise<{ app: LoamApp; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-review-race-"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
}

/** A fresh cookie session (the first one on a firstUser node is the admin). */
async function newSession(app: LoamApp): Promise<string> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  if (!cookie) {
    throw new Error("no session cookie");
  }
  return cookie;
}

type FakePeer = { url: string; requests: { path: string; body: unknown }[] };

/** A scripted plaintext peer: `respond` returns JSON, a Buffer (served raw), or undefined (404). */
async function fakePeer(respond: (path: string, body: unknown) => unknown): Promise<FakePeer> {
  const requests: FakePeer["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body: unknown = raw ? JSON.parse(raw) : undefined;
        const path = req.url ?? "";
        requests.push({ path, body });
        const out = await respond(path, body);
        if (out === undefined) {
          res.statusCode = 404;
          res.end("{}");
        } else if (Buffer.isBuffer(out)) {
          res.end(out);
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(out));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** Every id the puller asked for since `from` (an index into `peer.requests`). */
function requestedIds(peer: FakePeer, from = 0): string[] {
  return peer.requests
    .slice(from)
    .filter((request) => request.path === "/api/sync/messages")
    .flatMap((request) => (request.body as { ids?: string[] } | undefined)?.ids ?? []);
}

async function syncRound(app: LoamApp, cookie: string): Promise<void> {
  const res = await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  expect(res.statusCode).toBe(200);
}

type SealedRecord = { id: string; type: "sealed"; authorId: string; createdAt: number; toTag: string; sealed: string; ttlExpiresAt: number; hopLimit: number };

/** A sealed record (canonical blob) for `card`'s owner, or for a stranger. */
function sealedRecord(id: string, ttlExpiresAt: number, card?: MeshIdentityCard): SealedRecord {
  const now = Date.now();
  const stranger = createMeshIdentity();
  const toTag = mailboxTag(card?.mailboxToken ?? stranger.mailboxToken, currentEpoch(now, DAY_MS));
  const sender = createMeshIdentity();
  const sealed = sealMailbox({
    recipientKxPublic: card?.kx ?? stranger.kxPublic,
    sender: { signPublic: sender.signPublic, signSecret: sender.signSecret, kxPublic: sender.kxPublic },
    plaintext: `body of ${id}`,
    aad: `${toTag}|${ttlExpiresAt}`,
  });
  return { id, type: "sealed", authorId: "mesh.sealed", createdAt: now, toTag, sealed, ttlExpiresAt, hopLimit: 3 };
}

/** The replay key delivery tombstones beside the id (mesh.ts `sealedReplayKey`) — computable by any holder. */
function replayKey(record: SealedRecord): string {
  return `sealed.${createHash("sha256").update(record.sealed).update(`|${record.toTag}|${record.ttlExpiresAt}`).digest("hex")}`;
}

/**
 * The adversarial peer of review #2. `mode` picks what the next digest advertises: the records as sealed
 * offers (optionally with a rewritten TTL), their ids — plus the replay keys — among PUBLIC messages, or
 * their ids as public channels. `/api/sync/messages` returns whatever was asked for.
 */
async function probingPeer() {
  const state: { records: SealedRecord[]; mode: "sealed" | "public" | "channels"; ttl?: number } = { records: [], mode: "sealed" };
  const peer = await fakePeer((path, body) => {
    if (path === "/api/sync/digest") {
      const advertised = state.records.map((record) => (state.ttl === undefined ? record : { ...record, ttlExpiresAt: state.ttl }));
      if (state.mode === "public") {
        return { channels: [], messages: [...state.records.map(({ id }) => ({ id })), ...state.records.map((record) => ({ id: replayKey(record) }))] };
      }
      if (state.mode === "channels") {
        return {
          channels: state.records.map(({ id }) => ({
            id,
            name: id,
            visibility: "public",
            allowPosting: "everyone",
            allowReplies: true,
            discoverable: true,
            createdAt: 1,
          })),
          messages: [],
        };
      }
      return { channels: [], messages: [], sealed: advertised.map(({ id, toTag, ttlExpiresAt, hopLimit }) => ({ id, toTag, ttlExpiresAt, hopLimit })) };
    }
    if (path === "/api/sync/messages") {
      const ids = new Set((body as { ids: string[] }).ids);
      const advertised = state.records.map((record) => (state.ttl === undefined ? record : { ...record, ttlExpiresAt: state.ttl }));
      return { messages: advertised.filter((record) => ids.has(record.id)), users: [] };
    }
    return undefined;
  });
  return { peer, state };
}

/** A relay-off puller that got `seal_mine` (delivered) and `seal_foreign` (dropped) from the probing peer. */
async function deliveredAndDropped(opts: Partial<AppOptions> = {}) {
  const { peer, state } = await probingPeer();
  const config = { sync: { enabled: true, peers: [{ url: peer.url }], intervalMs: 3_600_000 }, mesh: MESH_NO_RELAY };
  const { app, dataDir } = await makeApp(config, opts);
  const cookie = await newSession(app);
  const card = MeshIdentityCardSchema.parse(
    (await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie } })).json(),
  );
  const expiry = Date.now() + 60_000;
  state.records = [sealedRecord("seal_mine", expiry, card), sealedRecord("seal_foreign", expiry)];
  await syncRound(app, cookie);
  expect(new Set(requestedIds(peer))).toEqual(new Set(["seal_mine", "seal_foreign"]));
  const stored = app.store.loadMessages();
  expect(stored.some((message) => message.type === "dm" && message.body === "body of seal_mine")).toBe(true);
  expect(stored.some((message) => message.id === "seal_foreign")).toBe(false);
  return { app, dataDir, cookie, peer, state, config, expiry };
}

describe("sealed-offer history can't be bypassed to find delivered mail (#2)", () => {
  it("sealed ids (and their replay keys) re-listed as PUBLIC messages are requested for neither outcome — also after a restart", async () => {
    const { app, dataDir, cookie, peer, state } = await deliveredAndDropped();

    state.mode = "public";
    let mark = peer.requests.length;
    await syncRound(app, cookie);
    expect(requestedIds(peer, mark)).toEqual([]);

    await app.close();
    const reopened = await buildApp({ dataDir, logger: false });
    cleanups.push(() => reopened.close());
    mark = peer.requests.length;
    await syncRound(reopened, cookie);
    expect(requestedIds(peer, mark)).toEqual([]);
  });

  it("sealed ids listed as public CHANNELS are imported for neither outcome", async () => {
    const { app, cookie, state } = await deliveredAndDropped();
    state.mode = "channels";
    await syncRound(app, cookie);
    const channelIds = new Set(app.store.loadChannels().map((channel) => channel.id));
    expect(channelIds.has("seal_mine")).toBe(false);
    expect(channelIds.has("seal_foreign")).toBe(false);
  });

  it("re-advertising with a later TTL after the first one lapsed fetches neither — also after a restart", async () => {
    const { app, dataDir, cookie, peer, state, expiry } = await deliveredAndDropped();
    const later = expiry + 120_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    app.reapExpiredMessages(); // the reaper's seen-record prune, at the new clock

    state.ttl = later + 3_600_000; // forged: the ciphertext needn't open for the probe to work
    let mark = peer.requests.length;
    await syncRound(app, cookie);
    expect(requestedIds(peer, mark)).toEqual([]);
    state.mode = "public";
    await syncRound(app, cookie);
    expect(requestedIds(peer, mark)).toEqual([]);

    await app.close();
    const reopened = await buildApp({ dataDir, logger: false });
    cleanups.push(() => reopened.close());
    reopened.reapExpiredMessages();
    state.mode = "sealed";
    mark = peer.requests.length;
    await syncRound(reopened, cookie);
    expect(requestedIds(peer, mark)).toEqual([]);
  });

  it("records pushed unasked (or under the other list) are ignored, so they can't land a dropped id either", async () => {
    const { app, cookie, state } = await deliveredAndDropped();
    const decoy = { id: "decoy_post", type: "channelPost", authorId: "user.peer", channelId: "general", createdAt: 1_000, body: "decoy" };
    const posts = ["seal_mine", "seal_foreign"].map((id) => ({ ...decoy, id, body: `public ${id}` }));
    // A peer answering the decoy request with public posts under the sealed ids it never got asked for.
    const pusher = await fakePeer((path) => {
      if (path === "/api/sync/digest") {
        return { channels: [], messages: [{ id: decoy.id }] };
      }
      if (path === "/api/sync/messages") {
        return { messages: [decoy, ...posts, ...state.records], users: [] };
      }
      return undefined;
    });
    const patched = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { sync: { peers: [{ url: pusher.url }] } },
    });
    expect(patched.statusCode).toBe(200);
    await syncRound(app, cookie);
    expect(requestedIds(pusher)).toEqual([decoy.id]);
    const ids = new Set(app.store.loadMessages().map((message) => message.id));
    expect(ids.has(decoy.id)).toBe(true);
    expect(ids.has("seal_mine")).toBe(false);
    expect(ids.has("seal_foreign")).toBe(false);
  });

  it("the seen mark outlives the delivery tombstone, and afterwards both ids come back together", async () => {
    const horizon = 10 * 60_000;
    const { app, dataDir, cookie, peer, state, expiry } = await deliveredAndDropped({ tombstoneHorizonMs: horizon });
    const start = Date.now();

    // Past the tombstone horizon: the delivery tombstone is gone, the seen marks aren't — still neither.
    const afterHorizon = start + horizon + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(afterHorizon);
    app.reapExpiredMessages();
    expect(app.store.loadTombstones()).not.toContain("seal_mine");
    state.ttl = afterHorizon + 3_600_000;
    let mark = peer.requests.length;
    await syncRound(app, cookie);
    state.mode = "public";
    await syncRound(app, cookie);
    expect(requestedIds(peer, mark)).toEqual([]);

    // Across a restart too, then past the seen retention (horizon + 7-day TTL max + 2 epochs): both at once.
    await app.close();
    const reopened = await buildApp({ dataDir, logger: false, tombstoneHorizonMs: horizon });
    cleanups.push(() => reopened.close());
    const afterRetention = start + horizon + 9 * DAY_MS + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(afterRetention);
    reopened.reapExpiredMessages();
    expect(reopened.store.countSealedOffersSeen()).toBe(0);
    state.mode = "sealed";
    state.ttl = afterRetention + 3_600_000;
    mark = peer.requests.length;
    await syncRound(reopened, cookie);
    expect(new Set(requestedIds(peer, mark))).toEqual(new Set(["seal_mine", "seal_foreign"]));
    expect(expiry).toBeLessThan(afterRetention);
  });
});

describe("sealed and public records live in separate id namespaces", () => {
  const peerUser = { id: "user.peer", type: "human", isAdmin: false, ephemeral: true, createdAt: 1, displayName: "Peer" };

  it("never requests a sealed offer without a seal_ id, nor a public record with one", async () => {
    const expiry = Date.now() + 60_000;
    const oddSealed = { ...sealedRecord("seal_placeholder", expiry), id: "msg_0123456789abcdef" };
    const sealedNamedPublic = { id: "seal_0123456789abcdef", type: "channelPost", authorId: "user.peer", channelId: "general", createdAt: 1000, body: "public under a sealed id" };
    const peer = await fakePeer((path, body) => {
      if (path === "/api/sync/digest") {
        return {
          channels: [],
          messages: [{ id: sealedNamedPublic.id }],
          sealed: [{ id: oddSealed.id, toTag: oddSealed.toTag, ttlExpiresAt: oddSealed.ttlExpiresAt, hopLimit: oddSealed.hopLimit }],
        };
      }
      if (path === "/api/sync/messages") {
        const ids = new Set((body as { ids: string[] }).ids);
        return { messages: [oddSealed, sealedNamedPublic].filter((record) => ids.has(record.id)), users: [peerUser] };
      }
      return undefined;
    });
    const { app } = await makeApp({ sync: { enabled: true, peers: [{ url: peer.url }], intervalMs: 3_600_000 }, mesh: MESH_NO_RELAY });
    const cookie = await newSession(app);
    await syncRound(app, cookie);
    expect(requestedIds(peer)).toEqual([]);
    const stored = app.store.loadMessages();
    expect(stored.some((message) => message.id === oddSealed.id || message.id === sealedNamedPublic.id)).toBe(false);
  });

  it("a sealed offer named after a public message can't keep the real message out", async () => {
    const post = { id: "msg_fedcba9876543210", type: "channelPost", authorId: "user.peer", channelId: "general", createdAt: 1000, body: "the real public post" };
    const squatter = { ...sealedRecord("seal_placeholder", Date.now() + 60_000), id: post.id };
    const state = { phase: "squat" as "squat" | "public" };
    const peer = await fakePeer((path, body) => {
      if (path === "/api/sync/digest") {
        return state.phase === "squat"
          ? { channels: [], messages: [], sealed: [{ id: squatter.id, toTag: squatter.toTag, ttlExpiresAt: squatter.ttlExpiresAt, hopLimit: squatter.hopLimit }] }
          : { channels: [], messages: [{ id: post.id }] };
      }
      if (path === "/api/sync/messages") {
        const ids = new Set((body as { ids: string[] }).ids);
        const pool = state.phase === "squat" ? [squatter] : [post];
        return { messages: pool.filter((record) => ids.has(record.id)), users: [peerUser] };
      }
      return undefined;
    });
    const { app } = await makeApp({ sync: { enabled: true, peers: [{ url: peer.url }], intervalMs: 3_600_000 }, mesh: MESH_NO_RELAY });
    const cookie = await newSession(app);
    await syncRound(app, cookie);
    expect(requestedIds(peer)).toEqual([]);

    state.phase = "public";
    await syncRound(app, cookie);
    expect(requestedIds(peer)).toEqual([post.id]);
    expect(app.store.loadMessages().some((message) => message.id === post.id && message.type === "channelPost")).toBe(true);
  });
});

describe("the seen-offer record's bounds", () => {
  it("keeps a live mark's first stamp, re-arms only a lapsed one, and counts per source", () => {
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    store.markSealedOfferSeen("seal_a", 1_000, "peer-1", 0);
    store.markSealedOfferSeen("seal_a", 9_000, "peer-2", 500); // live: unchanged
    expect(store.isSealedOfferSeen("seal_a", 999)).toBe(true);
    expect(store.isSealedOfferSeen("seal_a", 1_000)).toBe(false);
    expect(store.countSealedOffersSeen(0, "peer-1")).toBe(1);
    expect(store.countSealedOffersSeen(0, "peer-2")).toBe(0);
    store.markSealedOfferSeen("seal_a", 9_000, "peer-2", 1_000); // lapsed: re-armed
    expect(store.isSealedOfferSeen("seal_a", 5_000)).toBe(true);
    expect(store.countSealedOffersSeen(0, "peer-2")).toBe(1);
    expect(store.countSealedOffersSeen(9_000)).toBe(0); // lapsed rows don't count
    store.pruneSealedOffersSeen(9_000);
    expect(store.countSealedOffersSeen()).toBe(0);
  });

  it("a peer that filled its own quota stops only its own sealed pulls", async () => {
    const one = await probingPeer();
    const two = await probingPeer();
    const config = { sync: { enabled: true, peers: [{ url: one.peer.url }, { url: two.peer.url }], intervalMs: 3_600_000 }, mesh: { ...MESH_NO_RELAY, relay: true } };
    const { app } = await makeApp(config);
    const cookie = await newSession(app);
    const expiry = Date.now() + 3_600_000;
    one.state.records = [sealedRecord("seal_from_one", expiry)];
    two.state.records = [sealedRecord("seal_from_two", expiry)];
    app.store.transaction(() => {
      for (let index = 0; index < 50_000; index += 1) {
        app.store.markSealedOfferSeen(`junk_${index}`, expiry + DAY_MS, one.peer.url, Date.now());
      }
    });
    await syncRound(app, cookie);
    expect(requestedIds(one.peer)).toEqual([]);
    expect(requestedIds(two.peer)).toEqual(["seal_from_two"]);
  });
});

describe("an in-flight sync import can't undo a moderator removal (#3)", () => {
  const peerAuthor = { id: "user.peer", type: "human", isAdmin: false, ephemeral: true, createdAt: 1, displayName: "Peer" };
  const attachment = { id: "att_0123456789abcdef", mimeType: "text/plain", size: 7, name: "file.txt" };

  /** A peer serving `records()`, whose attachment responses wait on a gate the test releases. */
  async function gatedPeer(records: () => Record<string, unknown>[]) {
    let release!: () => void;
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const peer = await fakePeer(async (path, body) => {
      if (path === "/api/sync/digest") {
        return { channels: [], messages: records().map((record) => ({ id: record.id, editedAt: record.editedAt })) };
      }
      if (path === "/api/sync/messages") {
        const ids = new Set((body as { ids: string[] }).ids);
        return { messages: records().filter((record) => ids.has(record.id as string)), users: [peerAuthor] };
      }
      if (path.startsWith("/api/attachments/")) {
        entered();
        await gate;
        return Buffer.from("content");
      }
      return undefined;
    });
    return { peer, arrived, release };
  }

  async function puller(peerUrl: string) {
    const { app, dataDir } = await makeApp({ sync: { enabled: true, peers: [{ url: peerUrl }], intervalMs: 3_600_000 } });
    const cookie = await newSession(app);
    return { app, cookie, attachmentsDir: join(dataDir, "attachments") };
  }

  function withTimeout(promise: Promise<void>): Promise<void> {
    return Promise.race([promise, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("attachment fetch never started")), 5_000))]);
  }

  function attachmentFiles(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(attachment.id)) : [];
  }

  it("a newer edit released after the removal leaves the body blank, the flag set and no file behind", async () => {
    let post: Record<string, unknown> = { id: "peer_post", type: "channelPost", authorId: peerAuthor.id, channelId: "general", createdAt: 1_000, body: "original" };
    const { peer, arrived, release } = await gatedPeer(() => [post]);
    const { app, cookie, attachmentsDir } = await puller(peer.url);
    await syncRound(app, cookie);
    expect(app.store.loadMessages().some((message) => message.id === "peer_post")).toBe(true);

    post = { ...post, body: "restored despite removal", editedAt: Date.now() + 60_000, attachments: [attachment] };
    const inFlight = syncRound(app, cookie);
    await withTimeout(arrived);
    const removed = await app.server.inject({
      method: "POST",
      url: "/api/moderation/messages/peer_post/remove",
      headers: { cookie },
      payload: {},
    });
    expect(removed.statusCode).toBe(200);
    release();
    await inFlight;

    const stored = app.store.loadMessages().find((message) => message.id === "peer_post");
    expect(stored && "body" in stored ? stored.body : undefined).toBe("");
    expect(stored?.meta?.removedByModerator).toBe(true);
    expect(stored && "attachments" in stored ? (stored.attachments ?? []) : []).toEqual([]);
    expect(attachmentFiles(attachmentsDir)).toEqual([]);
    expect(app.store.loadMissingAttachments()).toEqual([]);
  });

  it("the missing-attachment retry never fetches a file back for a moderator-removed message", async () => {
    let serveFile = false;
    const post = { id: "peer_post", type: "channelPost", authorId: peerAuthor.id, channelId: "general", createdAt: 1_000, body: "with file", attachments: [attachment] };
    const peer = await fakePeer((path, body) => {
      if (path === "/api/sync/digest") {
        return { channels: [], messages: [{ id: post.id }] };
      }
      if (path === "/api/sync/messages") {
        const ids = new Set((body as { ids: string[] }).ids);
        return { messages: ids.has(post.id) ? [post] : [], users: [peerAuthor] };
      }
      if (path.startsWith("/api/attachments/")) {
        return serveFile ? Buffer.from("content") : undefined;
      }
      return undefined;
    });
    const { app, cookie, attachmentsDir } = await puller(peer.url);
    await syncRound(app, cookie);
    expect(app.store.loadMissingAttachments()).toHaveLength(1); // the first copy failed: a work item

    const removed = await app.server.inject({
      method: "POST",
      url: "/api/moderation/messages/peer_post/remove",
      headers: { cookie },
      payload: {},
    });
    expect(removed.statusCode).toBe(200);
    serveFile = true;
    const before = peer.requests.filter((request) => request.path.startsWith("/api/attachments/")).length;
    await app.retryMissingAttachments();
    expect(peer.requests.filter((request) => request.path.startsWith("/api/attachments/")).length).toBe(before);
    expect(attachmentFiles(attachmentsDir)).toEqual([]);
    expect(app.store.loadMissingAttachments()).toEqual([]);
  });

  it("a NEW reply whose parent is removed mid-flight is not imported and leaves no file behind", async () => {
    const parent = { id: "peer_parent", type: "channelPost", authorId: peerAuthor.id, channelId: "general", createdAt: 1_000, body: "parent" };
    let records: Record<string, unknown>[] = [parent];
    const { peer, arrived, release } = await gatedPeer(() => records);
    const { app, cookie, attachmentsDir } = await puller(peer.url);
    await syncRound(app, cookie);
    expect(app.store.loadMessages().some((message) => message.id === "peer_parent")).toBe(true);

    records = [
      parent,
      {
        id: "peer_reply",
        type: "channelReply",
        authorId: peerAuthor.id,
        channelId: "general",
        parentMessageId: "peer_parent",
        createdAt: 2_000,
        body: "reply under a post about to be removed",
        attachments: [attachment],
      },
    ];
    const inFlight = syncRound(app, cookie);
    await withTimeout(arrived);
    const removed = await app.server.inject({
      method: "POST",
      url: "/api/moderation/messages/peer_parent/remove",
      headers: { cookie },
      payload: {},
    });
    expect(removed.statusCode).toBe(200);
    release();
    await inFlight;

    expect(app.store.loadMessages().some((message) => message.id === "peer_reply")).toBe(false);
    expect(attachmentFiles(attachmentsDir)).toEqual([]);
    expect(app.store.loadMissingAttachments()).toEqual([]);
  });
});
