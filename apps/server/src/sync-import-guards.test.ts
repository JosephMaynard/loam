import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, type LoamApp } from "./app.js";
import type { AppOptions } from "./types.js";

/**
 * Guards on what a configured sync peer can make this node download or hold (docs/11): a single over-cap
 * record is isolated and remembered instead of starving every later offer, a digest can't land an unbounded
 * number of channels, a peer may author new content only as users sync introduced, and peer timestamps are
 * clamped to this node's clock. Each peer is a scripted plaintext HTTP server (the puller allows the
 * plaintext fallback by default). Each test fails with its guard removed.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

const PEER_AUTHOR = { id: "user.peer", type: "human", isAdmin: false, ephemeral: true, createdAt: 1, displayName: "Peer" };

/** A fresh app on its own temp data dir (config.json + options), cleaned up after the test. */
async function makeApp(config: unknown, opts: Partial<AppOptions> = {}): Promise<{ app: LoamApp; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-sync-import-guards-"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
}

/** Like {@link makeApp}, with the server log captured line by line. */
async function makeLoggedApp(config: unknown): Promise<{ app: LoamApp; logs: string[] }> {
  const logs: string[] = [];
  const { app } = await makeApp(config, { logger: true, logStream: { write: (line) => void logs.push(line) } });
  return { app, logs };
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

type FakePeer = { url: string; requests: { path: string; body: unknown }[] };

/** A scripted plaintext peer: `respond` returns JSON, or undefined for a 404. A puller that abandons an
 *  over-cap answer closes the socket mid-write, which must not take the peer down. */
async function fakePeer(respond: (path: string, body: unknown) => unknown): Promise<FakePeer> {
  const requests: FakePeer["requests"] = [];
  const server = createServer((req, res) => {
    req.socket.on("error", () => undefined);
    res.on("error", () => undefined);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      const path = req.url ?? "";
      requests.push({ path, body });
      const out = respond(path, body);
      if (out === undefined) {
        res.statusCode = 404;
        res.end("{}");
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      }
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

/** One forced sync round; returns the first peer's `lastError`, if the round recorded one. */
async function syncRound(app: LoamApp, cookie: string): Promise<string | undefined> {
  const res = await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  const report = res.json() as { peers: { status?: { lastError?: string } }[] };
  return report.peers[0]?.status?.lastError;
}

function heldIds(app: LoamApp): Set<string> {
  return new Set(app.store.loadMessages().map((message) => message.id));
}

function syncConfig(peerUrl: string, extra: Record<string, unknown> = {}): unknown {
  return { sync: { enabled: true, peers: [{ url: peerUrl }], intervalMs: 3_600_000 }, ...extra };
}

function post(id: string, body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: "channelPost", authorId: PEER_AUTHOR.id, channelId: "general", createdAt: 1_000, body, ...overrides };
}

/** A peer serving `records()` as its public offer, with `users` beside them. */
async function recordsPeer(records: () => Record<string, unknown>[], users: () => unknown[] = () => [PEER_AUTHOR]): Promise<FakePeer> {
  return fakePeer((path, body) => {
    if (path === "/api/sync/digest") {
      return { channels: [], messages: records().map((record) => ({ id: record.id, ...(record.editedAt !== undefined ? { editedAt: record.editedAt } : {}) })) };
    }
    if (path === "/api/sync/messages") {
      const ids = new Set((body as { ids: string[] }).ids);
      return { messages: records().filter((record) => ids.has(record.id as string)), users: users() };
    }
    return undefined;
  });
}

describe("one over-cap record can't starve the round", () => {
  it("is settled as refused once isolated, the rest of the batch imports in the same round, and the next round skips it", async () => {
    // Nine fine posts and one whose answer alone is over the 8 MiB response cap: isolating it from a batch
    // of ten costs five too-large answers (40 MiB), more than the round's 32 MiB byte budget. The single id
    // must still be settled, or every round would repeat the same downloads and never get past this batch.
    const huge = post("msg_huge", "x".repeat(9 * 1024 * 1024));
    const normal = Array.from({ length: 9 }, (_, index) => post(`msg_ok_${index}`, `fine ${index}`));
    const peer = await recordsPeer(() => [huge, ...normal]);
    const { app } = await makeApp(syncConfig(peer.url));
    const { cookie } = await newSession(app);

    expect(await syncRound(app, cookie)).toBeUndefined();
    const held = heldIds(app);
    for (const message of normal) {
      expect(held.has(message.id as string)).toBe(true);
    }
    expect(held.has("msg_huge")).toBe(false);
    // The bisection got down to the offender on its own.
    expect(peer.requests.some((request) => request.path === "/api/sync/messages" && JSON.stringify((request.body as { ids: string[] }).ids) === JSON.stringify(["msg_huge"]))).toBe(true);

    const mark = peer.requests.length;
    expect(await syncRound(app, cookie)).toBeUndefined();
    expect(requestedIds(peer, mark)).toEqual([]);
  });
});

describe("channel imports are bounded", () => {
  function channelRecord(index: number): Record<string, unknown> {
    return {
      id: `chan_${String(index).padStart(4, "0")}`,
      name: `Channel ${index}`,
      visibility: "public",
      allowPosting: "everyone",
      allowReplies: true,
      discoverable: true,
      createdAt: 1,
    };
  }

  it("takes at most 200 new channels a round and 2 000 of synced origin in all, logging once per round", async () => {
    const channels = Array.from({ length: 2_100 }, (_, index) => channelRecord(index));
    const peer = await fakePeer((path) => {
      if (path === "/api/sync/digest") {
        return { channels, messages: [] };
      }
      return path === "/api/sync/messages" ? { messages: [], users: [] } : undefined;
    });
    const { app, logs } = await makeLoggedApp(syncConfig(peer.url));
    const { cookie } = await newSession(app);
    const synced = () => app.store.loadChannels().filter((channel) => channel.id.startsWith("chan_")).length;
    const capWarnings = () => logs.filter((line) => line.includes("beyond the import cap")).length;

    expect(await syncRound(app, cookie)).toBeUndefined();
    expect(synced()).toBe(200);
    expect(capWarnings()).toBe(1);

    for (let round = 2; round <= 10; round += 1) {
      expect(await syncRound(app, cookie)).toBeUndefined();
    }
    expect(synced()).toBe(2_000);

    // The node-wide ceiling: a further round takes none of the hundred still on offer.
    expect(await syncRound(app, cookie)).toBeUndefined();
    expect(synced()).toBe(2_000);
    expect(capWarnings()).toBe(11);
  });
});

describe("a peer may author new content only as users it introduced", () => {
  it("refuses posts as a local member (into that member's owner-only channel too), takes a new author and later that author's posts, and never asks for a local post echoed back", async () => {
    let records: Record<string, unknown>[] = [];
    let users: unknown[] = [];
    const peer = await recordsPeer(() => records, () => users);
    const { app } = await makeApp(syncConfig(peer.url));
    const admin = await newSession(app);
    const member = await newSession(app);

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: member.cookie },
      payload: { name: "Owner only", allowPosting: "owner" },
    });
    expect(created.statusCode).toBe(201);
    const ownerOnlyId = (created.json() as { id: string }).id;
    const local = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "written here" },
    });
    expect(local.statusCode).toBe(201);
    const localId = (local.json() as { message: { id: string } }).message.id;
    const memberRecord = app.store.loadUsers().find((user) => user.id === member.userId);
    expect(memberRecord).toBeDefined();

    records = [
      post("peer_as_member", "as a local member", { authorId: member.userId }),
      post("peer_into_owner_only", "into the member's own channel", { authorId: member.userId, channelId: ownerOnlyId }),
      post("peer_stranger", "a stranger's post"),
      post(localId, "echoed back", { authorId: admin.userId }),
    ];
    users = [PEER_AUTHOR, { ...memberRecord, isAdmin: false }];
    expect(await syncRound(app, cookie(admin))).toBeUndefined();

    const held = heldIds(app);
    expect(held.has("peer_as_member")).toBe(false);
    expect(held.has("peer_into_owner_only")).toBe(false);
    expect(held.has("peer_stranger")).toBe(true);
    expect(requestedIds(peer)).not.toContain(localId);
    expect(app.store.isUserSynced(PEER_AUTHOR.id)).toBe(true);
    expect(app.store.isUserSynced(member.userId)).toBe(false);

    // The author sync introduced keeps posting.
    records = [...records, post("peer_stranger_2", "another one")];
    expect(await syncRound(app, cookie(admin))).toBeUndefined();
    expect(heldIds(app).has("peer_stranger_2")).toBe(true);
  });

  function cookie(session: { cookie: string }): string {
    return session.cookie;
  }
});

describe("peer timestamps are clamped to this node's clock", () => {
  it("a far-future createdAt and editedAt land at most five minutes ahead, so the message expires under retention", async () => {
    const tenYears = 10 * 365 * 24 * 3_600_000;
    const far = Date.now() + tenYears;
    const future = post("peer_future", "from the future", { createdAt: far, editedAt: far + 1 });
    const peer = await recordsPeer(() => [future]);
    const { app } = await makeApp(syncConfig(peer.url, { retention: { messageTtlMs: 1 } }));
    const { cookie } = await newSession(app);

    const before = Date.now();
    expect(await syncRound(app, cookie)).toBeUndefined();
    const stored = app.store.loadMessages().find((message) => message.id === "peer_future");
    expect(stored).toBeDefined();
    const horizon = Date.now() + 5 * 60_000;
    expect(stored?.createdAt).toBeGreaterThanOrEqual(before);
    expect(stored?.createdAt).toBeLessThanOrEqual(horizon);
    expect(stored?.editedAt).toBeLessThanOrEqual(horizon);

    // Six minutes on, a 1 ms retention reaps it; stored as sent it would have outlived everyone.
    vi.spyOn(Date, "now").mockReturnValue(before + 6 * 60_000);
    app.reapExpiredMessages();
    expect(heldIds(app).has("peer_future")).toBe(false);
  });
});
