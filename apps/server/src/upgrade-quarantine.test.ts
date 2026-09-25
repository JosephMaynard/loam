import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { Channel, Message, SyncDigest, User } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import { openStore, QuarantinedRowError } from "./db.js";
import type { AppOptions } from "./types.js";

/**
 * Upgrade quarantine (pre-release review 2026-09-25, P1). v0.5.0 bounds every id at 128 chars; a row v0.4
 * wrote past that no longer validates. The loader used to skip such a row but still load the messages
 * under a skipped channel and let anything claim the skipped id — so a private channel with one over-long
 * member id vanished at upgrade, and a sync peer's PUBLIC channel with the same slug was then upserted over
 * the private row, publishing its retained messages. Now the loader repairs what is provably safe and
 * quarantines the rest: not loaded, left on disk, and its id refused by every write path.
 *
 * Each security test was mutation-checked: with its guard reverted, it fails.
 */

type InjectResponse = Awaited<ReturnType<LoamApp["server"]["inject"]>>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** A fresh temp data dir (optionally seeded with a config.json), removed after the test. */
function tempDataDir(config?: unknown): string {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-quarantine-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

/** Boot an app on `dataDir` (closed after the test; closing twice is harmless). */
async function boot(dataDir: string, opts?: Partial<AppOptions>): Promise<LoamApp> {
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(() => app.close());
  return app;
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

/** Run one sync round as `cookie` (an admin) and return the single peer's status. */
async function runSync(app: LoamApp, cookie: string): Promise<{ lastError?: string; imported: number } | undefined> {
  const run = await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  expect(run.statusCode).toBe(200);
  return (run.json() as { peers: { status?: { lastError?: string; imported: number } }[] }).peers[0]?.status;
}

/** Read a row's raw `data` straight from the SQLite file (the app must be closed or idle). */
function rawData(dataDir: string, table: "users" | "channels" | "messages", id: string): string | undefined {
  const db = new DatabaseSync(join(dataDir, "loam.db"));
  try {
    return (db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data?: string } | undefined)?.data;
  } finally {
    db.close();
  }
}

/** Run raw SQL against the SQLite file (the app must be closed). */
function rawRun(dataDir: string, sql: string, ...params: (string | number | null)[]): void {
  const db = new DatabaseSync(join(dataDir, "loam.db"));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** A stand-in sync peer: serves `digest()` and the requested subset of `messages()`, recording every id
 *  the puller asks for. Everything else 404s (the puller falls back to a plaintext pull). */
async function startPeer(source: { digest: () => SyncDigest; messages?: () => Message[]; users?: () => User[] }) {
  const requested: string[] = [];
  const readBody = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => resolve(body));
    });
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/sync/digest") {
      response.end(JSON.stringify(source.digest()));
      return;
    }
    if (request.url === "/api/sync/messages" && request.method === "POST") {
      const { ids } = JSON.parse(await readBody(request)) as { ids: string[] };
      requested.push(...ids);
      const messages = (source.messages?.() ?? []).filter((message) => ids.includes(message.id));
      response.end(JSON.stringify({ messages, users: source.users?.() ?? [] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requested };
}

const syncConfig = (url: string) => ({ sync: { enabled: true, peers: [{ url }], intervalMs: 3_600_000 } });

/** A valid public post as a peer would serve it. */
function peerPost(id: string, channelId: string, body: string, authorId = "user.peer0001"): Message {
  return { id, type: "channelPost", channelId, authorId, body, createdAt: 1_700_000_000_000 } as Message;
}

const peerUser: User = { id: "user.peer0001", displayName: "Peer", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };

/** Compare a response to a reference response: same status, same body. */
function expectSameAnswer(actual: InjectResponse, reference: InjectResponse): void {
  expect(actual.statusCode).toBe(reference.statusCode);
  expect(actual.body).toBe(reference.body);
}

describe("upgrade: a private channel whose roster names an over-long member id", () => {
  it("is repaired (the member dropped), stays private, and a peer's same-slug public channel can't claim it", async () => {
    let channel: Channel | undefined;
    const peer = await startPeer({
      digest: () => ({ channels: channel ? [{ ...channel, visibility: "public", memberUserIds: undefined }] : [], messages: [] }),
    });
    const dataDir = tempDataDir(syncConfig(peer.url));
    const first = await boot(dataDir);
    const owner = await newSession(first);
    const created = await first.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Private Team", visibility: "private" },
    });
    expect(created.statusCode).toBe(201);
    channel = created.json() as Channel;
    const posted = await first.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: owner.cookie },
      payload: { type: "channelPost", channelId: channel.id, body: "private before upgrade" },
    });
    expect(posted.statusCode).toBe(201);
    // Valid under v0.4.0's unbounded IdSchema, invalid under ID_MAX_LENGTH.
    const longMember = `user.${"a".repeat(129)}`;
    first.store.upsertChannel({ ...channel, memberUserIds: [...(channel.memberUserIds ?? []), longMember] });
    await first.close();
    const storedRow = rawData(dataDir, "channels", channel.id);

    const app = await boot(dataDir);
    const loaded = app.store.loadChannels().find((candidate) => candidate.id === channel?.id);
    expect(loaded?.visibility).toBe("private");
    expect(loaded?.memberUserIds).toEqual([owner.userId]);
    expect(app.store.quarantine().channels.size).toBe(0);

    await runSync(app, owner.cookie);

    const stranger = await newSession(app);
    const read = await app.server.inject({ method: "GET", url: `/api/messages/${channel.id}`, headers: { cookie: stranger.cookie } });
    expect(read.statusCode).toBe(404);
    const ownerRead = await app.server.inject({ method: "GET", url: `/api/messages/${channel.id}`, headers: { cookie: owner.cookie } });
    expect(ownerRead.statusCode).toBe(200);
    expect((ownerRead.json() as Message[]).some((message) => "body" in message && message.body === "private before upgrade")).toBe(true);
    expect(app.store.loadChannels().find((candidate) => candidate.id === channel?.id)?.visibility).toBe("private");
    // The repair is in memory: the row on disk is untouched until the channel is next changed.
    await app.close();
    expect(rawData(dataDir, "channels", channel.id)).toBe(storedRow);
  });
});

describe("upgrade: a channel row that can't be repaired is quarantined with everything under it", () => {
  it("loads neither the channel nor its messages, and no peer, request or seed can claim its id", async () => {
    let peerChannel: Channel | undefined;
    let quarantinedPostId = "";
    const generalPost = peerPost("msg_peer000000000001", "general", "unrelated public post");
    const peer = await startPeer({
      digest: () => ({
        channels: peerChannel ? [peerChannel] : [],
        messages: [{ id: quarantinedPostId, editedAt: Date.now() }, { id: generalPost.id }],
      }),
      messages: () => [peerPost(quarantinedPostId, "ops-room", "peer copy"), generalPost],
      users: () => [peerUser],
    });
    const dataDir = tempDataDir(syncConfig(peer.url));
    const first = await boot(dataDir);
    const owner = await newSession(first);
    const post = (payload: Record<string, unknown>) =>
      first.server.inject({ method: "POST", url: "/api/messages", headers: { cookie: owner.cookie }, payload });
    const created = await first.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Ops Room", visibility: "private" },
    });
    const channel = created.json() as Channel;
    expect(channel.id).toBe("ops-room");
    const root = ((await post({ type: "channelPost", channelId: channel.id, body: "secret plan" })).json() as { message: Message }).message;
    const reply = (
      (await post({ type: "channelReply", channelId: channel.id, parentMessageId: root.id, body: "secret reply" })).json() as {
        message: Message;
      }
    ).message;
    const reaction = (
      (await post({ type: "reaction", targetMessageId: root.id, reaction: "👍" })).json() as { message: Message }
    ).message;
    quarantinedPostId = root.id;
    peerChannel = { ...channel, visibility: "public", memberUserIds: undefined, ownerUserId: undefined, discoverable: true };
    // An over-long OWNER id isn't repairable (dropping it would change who manages the channel).
    first.store.upsertChannel({ ...channel, ownerUserId: `user.${"o".repeat(200)}` });
    await first.close();
    const before = {
      channel: rawData(dataDir, "channels", channel.id),
      root: rawData(dataDir, "messages", root.id),
      reply: rawData(dataDir, "messages", reply.id),
      reaction: rawData(dataDir, "messages", reaction.id),
    };

    const app = await boot(dataDir);
    expect(app.store.loadChannels().some((candidate) => candidate.id === channel.id)).toBe(false);
    const loadedIds = app.store.loadMessages().map((message) => message.id);
    for (const id of [root.id, reply.id, reaction.id]) {
      expect(loadedIds).not.toContain(id);
      expect(app.store.quarantine().messages.has(id)).toBe(true);
    }
    expect(app.store.quarantine().channels.has(channel.id)).toBe(true);

    // Reading or posting into it answers exactly like a channel that doesn't exist.
    const get = (id: string) =>
      app.server.inject({ method: "GET", url: `/api/messages/${id}`, headers: { cookie: owner.cookie } });
    expectSameAnswer(await get(channel.id), await get("no-such-channel"));
    const postInto = (channelId: string) =>
      app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: owner.cookie },
        payload: { type: "channelPost", channelId, body: "hello?" },
      });
    expectSameAnswer(await postInto(channel.id), await postInto("no-such-channel"));

    // A sync round: the peer's same-id public channel is refused WITHOUT failing the round (the unrelated
    // public post still imports), and the quarantined post is never even requested.
    const status = await runSync(app, owner.cookie);
    expect(status?.lastError).toBeUndefined();
    expect(app.store.loadMessages().some((message) => message.id === generalPost.id)).toBe(true);
    expect(peer.requested).not.toContain(root.id);
    expect(app.store.loadChannels().some((candidate) => candidate.id === channel.id)).toBe(false);

    // A fresh channel with the same name gets a suffixed id, not the quarantined one.
    const again = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Ops Room" },
    });
    expect(again.statusCode).toBe(201);
    expect((again.json() as Channel).id).toMatch(/^ops-room-[0-9a-f]{6}$/);

    await app.close();
    expect(rawData(dataDir, "channels", channel.id)).toBe(before.channel);
    expect(rawData(dataDir, "messages", root.id)).toBe(before.root);
    expect(rawData(dataDir, "messages", reply.id)).toBe(before.reply);
    expect(rawData(dataDir, "messages", reaction.id)).toBe(before.reaction);
  });

  it("never seeds a default channel over a quarantined row", async () => {
    const dataDir = tempDataDir();
    const first = await boot(dataDir);
    await first.close();
    // Both default channels unreadable → the node has no loaded channels, which is what triggers seeding.
    rawRun(dataDir, "UPDATE channels SET data = '{' WHERE id IN ('general', 'announcements')");

    const app = await boot(dataDir);
    expect(app.store.loadChannels()).toEqual([]);
    expect([...app.store.quarantine().channels].sort()).toEqual(["announcements", "general"]);
    const admin = await newSession(app);
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
      payload: { name: "General" },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as Channel).id).toMatch(/^general-[0-9a-f]{6}$/);
    await app.close();
    expect(rawData(dataDir, "channels", "general")).toBe("{");
    expect(rawData(dataDir, "channels", "announcements")).toBe("{");
  });
});

describe("upgrade: quarantined user rows", () => {
  it("refuses a peer's record for a quarantined user id, and never resurrects it from a stored session", async () => {
    const quarantinedId = "user.q0000001";
    const post = peerPost("msg_peer000000000002", "general", "from a peer", quarantinedId);
    const peer = await startPeer({
      digest: () => ({ channels: [], messages: [{ id: post.id }] }),
      messages: () => [post],
      users: () => [{ ...peerUser, id: quarantinedId, displayName: "Peer Person" }],
    });
    const dataDir = tempDataDir(syncConfig(peer.url));
    const first = await boot(dataDir);
    const admin = await newSession(first);
    await first.close();
    // An empty display name fails UserSchema and isn't repairable; the row even claims admin.
    const badRow = JSON.stringify({ id: quarantinedId, displayName: "", type: "human", isAdmin: true, createdAt: 1, ephemeral: true });
    rawRun(dataDir, "INSERT INTO users (id, data) VALUES (?, ?)", quarantinedId, badRow);
    rawRun(dataDir, "INSERT INTO sessions (token, user_id) VALUES (?, ?)", "quarantined-session-token", quarantinedId);

    const app = await boot(dataDir);
    expect(app.store.loadUsers().some((user) => user.id === quarantinedId)).toBe(false);
    expect(app.store.quarantine().users.has(quarantinedId)).toBe(true);

    // The stored session isn't honoured: the caller gets a fresh, non-admin identity (not a 500, and not
    // the quarantined user recreated over its row).
    const resumed = await app.server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: "loam_session=quarantined-session-token" },
    });
    expect(resumed.statusCode).toBe(200);
    const currentUser = (resumed.json() as { currentUser: User }).currentUser;
    expect(currentUser.id).not.toBe(quarantinedId);
    expect(currentUser.isAdmin).toBe(false);

    // The peer's message imports; its author record for the quarantined id does not.
    const status = await runSync(app, admin.cookie);
    expect(status?.lastError).toBeUndefined();
    expect(app.store.loadMessages().some((message) => message.id === post.id)).toBe(true);
    expect(app.store.loadUsers().some((user) => user.id === quarantinedId)).toBe(false);
    await app.close();
    expect(rawData(dataDir, "users", quarantinedId)).toBe(badRow);
  });
});

describe("upgrade: quarantined message rows", () => {
  it("holds back replies under a quarantined post and never re-imports either id from a peer", async () => {
    let offered: Message[] = [];
    const fresh = peerPost("msg_peer000000000003", "general", "fresh from the peer");
    const peer = await startPeer({
      digest: () => ({ channels: [], messages: offered.map((message) => ({ id: message.id, editedAt: Date.now() })) }),
      messages: () => offered,
      users: () => [peerUser],
    });
    const dataDir = tempDataDir(syncConfig(peer.url));
    const first = await boot(dataDir);
    const admin = await newSession(first);
    const post = async (payload: Record<string, unknown>) =>
      (
        (await first.server.inject({ method: "POST", url: "/api/messages", headers: { cookie: admin.cookie }, payload })).json() as {
          message: Message;
        }
      ).message;
    const root = await post({ type: "channelPost", channelId: "general", body: "root" });
    const reply = await post({ type: "channelReply", channelId: "general", parentMessageId: root.id, body: "reply" });
    const other = await post({ type: "channelPost", channelId: "general", body: "unrelated" });
    await first.close();
    // An over-long author id (valid under v0.4.0) makes the root unloadable.
    const badRoot = JSON.stringify({ ...root, authorId: `user.${"z".repeat(130)}` });
    rawRun(dataDir, "UPDATE messages SET data = ? WHERE id = ?", badRoot, root.id);
    const storedReply = rawData(dataDir, "messages", reply.id);

    const app = await boot(dataDir);
    const loaded = app.store.loadMessages().map((message) => message.id);
    expect(loaded).toContain(other.id);
    expect(loaded).not.toContain(root.id);
    expect(loaded).not.toContain(reply.id);
    expect(app.store.quarantine().messages).toEqual(new Set([root.id, reply.id]));

    offered = [
      peerPost(root.id, "general", "peer version of the root"),
      { ...reply, authorId: peerUser.id, body: "peer version of the reply" } as Message,
      fresh,
    ];
    const status = await runSync(app, admin.cookie);
    expect(status?.lastError).toBeUndefined();
    expect(peer.requested).toContain(fresh.id);
    expect(peer.requested).not.toContain(root.id);
    expect(peer.requested).not.toContain(reply.id);
    const history = (
      await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: admin.cookie } })
    ).json() as Message[];
    expect(history.map((message) => message.id)).not.toContain(root.id);
    expect(history.map((message) => message.id)).toContain(fresh.id);
    await app.close();
    expect(rawData(dataDir, "messages", root.id)).toBe(badRoot);
    expect(rawData(dataDir, "messages", reply.id)).toBe(storedReply);
  });
});

describe("the store refuses writes to quarantined rows", () => {
  it("throws on every create/overwrite of a quarantined id, skips a row with no readable id, and wipeAll releases them", () => {
    const dir = tempDataDir();
    const path = join(dir, "loam.db");
    const seed = openStore(path);
    const longId = `x${"q".repeat(200)}`;
    const user: User = { id: longId, displayName: "Legacy", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
    const channel = {
      id: longId,
      name: "legacy",
      visibility: "public",
      allowPosting: "everyone",
      allowReplies: true,
      discoverable: true,
      createdAt: 1,
    } as Channel;
    const message = { id: longId, type: "channelPost", channelId: "general", authorId: "user.1", body: "x", createdAt: 1 } as Message;
    seed.upsertUser(user);
    seed.upsertChannel(channel);
    seed.insertMessage(message);
    seed.close();
    // SQLite lets a non-INTEGER primary key be NULL: such a row can't be named, so it's skipped on its own.
    rawRun(dir, "INSERT INTO users (id, data) VALUES (NULL, '{')");

    const store = openStore(path);
    cleanups.push(() => store.close());
    const reports: Record<string, unknown> = {};
    expect(store.loadUsers((report) => (reports.users = report))).toEqual([]);
    expect(store.loadChannels()).toEqual([]);
    expect(store.loadMessages()).toEqual([]);
    expect(reports.users).toEqual({ repaired: 0, quarantined: 2, dependent: 0 });
    expect(store.quarantine().users).toEqual(new Set([longId]));

    expect(() => store.upsertUser(user)).toThrow(QuarantinedRowError);
    expect(() => store.upsertChannel(channel)).toThrow(QuarantinedRowError);
    expect(() => store.insertMessage(message)).toThrow(QuarantinedRowError);
    expect(() => store.updateMessage(message)).toThrow(QuarantinedRowError);

    store.wipeAll();
    expect(store.quarantine().users.size + store.quarantine().channels.size + store.quarantine().messages.size).toBe(0);
    expect(() => store.upsertChannel({ ...channel, id: "legacy" })).not.toThrow();
  });
});

describe("Emergency Reset removes quarantined rows like any other", () => {
  it("wipes them from disk and releases their ids", async () => {
    const dataDir = tempDataDir({ killSwitch: { enabled: true } });
    const first = await boot(dataDir);
    const admin = await newSession(first);
    await first.close();
    rawRun(dataDir, "UPDATE channels SET data = '{' WHERE id = 'announcements'");

    const app = await boot(dataDir);
    expect(app.store.quarantine().channels.has("announcements")).toBe(true);
    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(app.store.quarantine().channels.size).toBe(0);
    // The re-seeded node has a fresh, valid default in its place.
    expect(app.store.loadChannels().some((candidate) => candidate.id === "announcements")).toBe(true);
    await app.close();
    expect(rawData(dataDir, "channels", "announcements")).not.toBe("{");
  });
});
