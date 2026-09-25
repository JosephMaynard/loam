import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import { openStore } from "./db.js";
import type { AppOptions } from "./types.js";

/**
 * Per-user blocking (docs/30 B3 — Play's user-generated-content policy). The DM-refusal tests were
 * mutation-checked: with the `dmBlockError` checks in `createMessage` / `messageMutationError` reverted,
 * they fail.
 */

type InjectResponse = Awaited<ReturnType<LoamApp["server"]["inject"]>>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** A fresh app on its own temp data dir (optional config.json + options), cleaned up after the test. */
async function makeApp(config?: unknown, opts?: Partial<AppOptions>): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-blocks-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
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

function block(app: LoamApp, cookie: string, userId: string): Promise<InjectResponse> {
  return app.server.inject({ method: "PUT", url: `/api/users/me/blocks/${encodeURIComponent(userId)}`, headers: { cookie } });
}

function unblock(app: LoamApp, cookie: string, userId: string): Promise<InjectResponse> {
  return app.server.inject({
    method: "DELETE",
    url: `/api/users/me/blocks/${encodeURIComponent(userId)}`,
    headers: { cookie },
  });
}

async function blockList(app: LoamApp, cookie: string): Promise<string[]> {
  const response = await app.server.inject({ method: "GET", url: "/api/users/me/blocks", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { blockedUserIds: string[] }).blockedUserIds;
}

function sendDm(app: LoamApp, cookie: string, recipientUserId: string, body = "hi"): Promise<InjectResponse> {
  return app.server.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { type: "dm", recipientUserId, body },
  });
}

function react(app: LoamApp, cookie: string, targetMessageId: string, reaction = "👍"): Promise<InjectResponse> {
  return app.server.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { type: "reaction", targetMessageId, reaction },
  });
}

function codeOf(response: InjectResponse): string | undefined {
  return (response.json() as { code?: string }).code;
}

describe("user blocking (docs/30 B3)", () => {
  it("blocks, lists and unblocks — idempotently, and only on the caller's own list", async () => {
    const app = await makeApp();
    await newSession(app); // the firstUser admin
    const alice = await newSession(app);
    const bob = await newSession(app);
    const carol = await newSession(app);

    expect(await blockList(app, alice.cookie)).toEqual([]);

    const first = await block(app, alice.cookie, bob.userId);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ blockedUserIds: [bob.userId] });
    // A repeat block is a no-op, not a duplicate.
    expect((await block(app, alice.cookie, bob.userId)).json()).toEqual({ blockedUserIds: [bob.userId] });
    expect((await block(app, alice.cookie, carol.userId)).json()).toEqual({
      blockedUserIds: [bob.userId, carol.userId],
    });

    // The list is Alice's alone — Bob's (the blocked party's) and Carol's are untouched.
    expect(await blockList(app, bob.cookie)).toEqual([]);
    expect(await blockList(app, carol.cookie)).toEqual([]);

    const removed = await unblock(app, alice.cookie, bob.userId);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ blockedUserIds: [carol.userId] });
    // Unblocking someone not on the list (but on the roster) is idempotent.
    expect((await unblock(app, alice.cookie, bob.userId)).statusCode).toBe(200);
    expect(await blockList(app, alice.cookie)).toEqual([carol.userId]);
  });

  it("refuses to block yourself, the assistant bot, or an unknown user; allows blocking an admin", async () => {
    const app = await makeApp({
      llm: { ollama: { enabled: true, baseUrl: "http://localhost:11434", model: "m", botId: "llm.bot.test", botDisplayName: "Bot" } },
    });
    const admin = await newSession(app);
    const member = await newSession(app);

    const self = await block(app, member.cookie, member.userId);
    expect(self.statusCode).toBe(400);
    expect(codeOf(self)).toBe("block_not_allowed");

    const bot = await block(app, member.cookie, "llm.bot.test");
    expect(bot.statusCode).toBe(400);
    expect(codeOf(bot)).toBe("block_not_allowed");

    const unknown = await block(app, member.cookie, "user.nobody");
    expect(unknown.statusCode).toBe(404);
    expect(codeOf(unknown)).toBe("user_not_found");
    expect((await unblock(app, member.cookie, "user.nobody")).statusCode).toBe(404);

    // Blocking an admin only changes what the blocker sees and who can DM them — allowed.
    expect((await block(app, member.cookie, admin.userId)).statusCode).toBe(200);
    expect(await blockList(app, member.cookie)).toEqual([admin.userId]);
  });

  it("answers a banned (hidden) user like an unknown one, so blocking can't probe the roster", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const member = await newSession(app);
    const troll = await newSession(app);
    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${troll.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const response = await block(app, member.cookie, troll.userId);
    expect(response.statusCode).toBe(404);
    expect(codeOf(response)).toBe("user_not_found");
  });

  it("refuses a DM from the blocked user with a generic code that doesn't reveal the block", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    const banned = await newSession(app);

    expect((await sendDm(app, bob.cookie, alice.userId, "before")).statusCode).toBe(201);
    await block(app, alice.cookie, bob.userId);

    const refused = await sendDm(app, bob.cookie, alice.userId, "after");
    expect(refused.statusCode).toBe(403);
    expect(codeOf(refused)).toBe("dm_unavailable");
    expect(JSON.stringify(refused.json())).not.toMatch(/block/i);

    // Exactly what a DM to someone who can't receive one (a banned user) answers — indistinguishable.
    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${banned.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });
    const toBanned = await sendDm(app, bob.cookie, banned.userId, "hello?");
    expect(toBanned.statusCode).toBe(refused.statusCode);
    expect(toBanned.json()).toEqual(refused.json());

    // Nothing was stored for Alice to receive.
    const thread = (
      await app.server.inject({ method: "GET", url: `/api/dms/${bob.userId}`, headers: { cookie: alice.cookie } })
    ).json() as { body?: string }[];
    expect(thread.map((message) => message.body)).toEqual(["before"]);

    // Unblocking restores DMs.
    await unblock(app, alice.cookie, bob.userId);
    expect((await sendDm(app, bob.cookie, alice.userId, "again")).statusCode).toBe(201);
  });

  it("refuses a DM from the blocker to the person they blocked, with its own code", async () => {
    const app = await makeApp();
    await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    await block(app, alice.cookie, bob.userId);

    const refused = await sendDm(app, alice.cookie, bob.userId);
    expect(refused.statusCode).toBe(403);
    expect(codeOf(refused)).toBe("dm_blocked_by_you");
    // Third parties are unaffected.
    const carol = await newSession(app);
    expect((await sendDm(app, carol.cookie, alice.userId)).statusCode).toBe(201);
    expect((await sendDm(app, bob.cookie, carol.userId)).statusCode).toBe(201);
  });

  it("refuses reactions on DMs across a block (both ways), but still lets you remove your own", async () => {
    const app = await makeApp();
    await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    const fromAlice = ((await sendDm(app, alice.cookie, bob.userId, "from alice")).json() as { message: { id: string } })
      .message.id;
    const fromBob = ((await sendDm(app, bob.cookie, alice.userId, "from bob")).json() as { message: { id: string } })
      .message.id;
    // Bob reacted before the block.
    expect((await react(app, bob.cookie, fromAlice, "❤️")).statusCode).toBe(201);

    await block(app, alice.cookie, bob.userId);

    const blockedReacts = await react(app, bob.cookie, fromAlice);
    expect(blockedReacts.statusCode).toBe(403);
    expect(codeOf(blockedReacts)).toBe("dm_unavailable");

    const blockerReacts = await react(app, alice.cookie, fromBob);
    expect(blockerReacts.statusCode).toBe(403);
    expect(codeOf(blockerReacts)).toBe("dm_blocked_by_you");

    // Toggling his own pre-block reaction OFF is cleanup, not contact — still allowed.
    const removed = await react(app, bob.cookie, fromAlice, "❤️");
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { deletedMessageId?: string }).deletedMessageId).toBeDefined();
  });

  it("freezes edits of pre-block DMs (an edit re-delivers text), but not deletes", async () => {
    const app = await makeApp();
    await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    const fromBob = ((await sendDm(app, bob.cookie, alice.userId, "original")).json() as { message: { id: string } })
      .message.id;

    await block(app, alice.cookie, bob.userId);

    const edit = await app.server.inject({
      method: "PATCH",
      url: `/api/messages/${fromBob}`,
      headers: { cookie: bob.cookie },
      payload: { body: "sneaky new text" },
    });
    expect(edit.statusCode).toBe(403);
    expect(codeOf(edit)).toBe("dm_unavailable");

    const remove = await app.server.inject({
      method: "DELETE",
      url: `/api/messages/${fromBob}`,
      headers: { cookie: bob.cookie },
    });
    expect(remove.statusCode).toBe(200);
  });

  it("keeps channel content flowing (hiding it is the blocker's client's job)", async () => {
    const app = await makeApp();
    await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    await block(app, alice.cookie, bob.userId);

    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: bob.cookie },
      payload: { type: "channelPost", channelId: "general", body: "still public" },
    });
    expect(post.statusCode).toBe(201);
    const general = (
      await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: alice.cookie } })
    ).json() as { body?: string }[];
    expect(general.some((message) => message.body === "still public")).toBe(true);
  });

  it("never exposes a block list on user records or to anyone but its owner", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    await block(app, alice.cookie, bob.userId);

    for (const viewer of [admin, alice, bob]) {
      const roster = await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: viewer.cookie } });
      expect(roster.body).not.toMatch(/block/i);
      const config = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: viewer.cookie } });
      expect(config.body).not.toMatch(/block/i);
      const moderation = await app.server.inject({
        method: "GET",
        url: "/api/moderation/users",
        headers: { cookie: viewer.cookie },
      });
      expect(moderation.body).not.toMatch(/block/i);
    }
    // The admin's own list is empty — admins get no view into members' lists.
    expect(await blockList(app, admin.cookie)).toEqual([]);
  });

  it("broadcasts nothing on block, and suppresses DM typing across a block", async () => {
    const app = await makeApp();
    await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const events: { type?: string; userId?: string; dmUserId?: string }[] = [];
    const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
      `${baseUrl.replace("http", "ws")}/ws`,
      { headers: { cookie: alice.cookie } },
    );
    cleanups.push(() => socket.close());
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as (typeof events)[number]);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
    });
    const waitFor = async (check: () => boolean): Promise<boolean> => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !check()) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return check();
    };
    const typing = () =>
      app.server.inject({
        method: "POST",
        url: "/api/typing",
        headers: { cookie: bob.cookie },
        payload: { recipientUserId: alice.userId },
      });
    const bobTyping = () => events.filter((event) => event.type === "typing" && event.userId === bob.userId).length;

    // Positive control: before the block, Bob's typing reaches Alice.
    expect((await typing()).statusCode).toBe(204);
    expect(await waitFor(() => bobTyping() === 1)).toBe(true);

    const before = events.length;
    await block(app, alice.cookie, bob.userId);
    // Same silent 204 for Bob, but nothing reaches Alice.
    expect((await typing()).statusCode).toBe(204);
    // Fence: a public channel post always broadcasts — once Alice sees it, anything earlier has landed.
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: bob.cookie },
      payload: { type: "channelPost", channelId: "general", body: "fence" },
    });
    expect(await waitFor(() => events.some((event) => event.type === "messageCreated"))).toBe(true);
    expect(bobTyping()).toBe(1);
    // The block itself produced no event of any kind.
    expect(events.slice(before).map((event) => event.type)).toEqual(["messageCreated"]);
  });

  it("is wiped by the kill switch", async () => {
    const app = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    await block(app, alice.cookie, bob.userId);
    expect(app.store.loadUserBlocks(alice.userId)).toEqual([bob.userId]);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(app.store.loadUserBlocks(alice.userId)).toEqual([]);
    expect(app.store.isUserBlocked(alice.userId, bob.userId)).toBe(false);
  });

  it("is never exported by node sync", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: bob.cookie },
      payload: { type: "channelPost", channelId: "general", body: "public words" },
    });
    await block(app, alice.cookie, bob.userId);

    const digest = await app.server.inject({ method: "GET", url: "/api/sync/digest" });
    expect(digest.statusCode).toBe(200);
    expect(digest.body).not.toMatch(/block/i);
    const ids = (digest.json() as { messages: { id: string }[] }).messages.map((message) => message.id);
    expect(ids.length).toBeGreaterThan(0);
    const exported = await app.server.inject({ method: "POST", url: "/api/sync/messages", payload: { ids } });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain("public words");
    expect(exported.body).not.toMatch(/block/i);
  });
});

describe("user_blocks DAL", () => {
  it("drops a user's rows (either side) when the user is deleted, and wipeAll clears the table", () => {
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    store.addUserBlock("user.a", "user.b");
    store.addUserBlock("user.c", "user.a");
    store.addUserBlock("user.c", "user.d");

    store.deleteUser("user.a");
    expect(store.loadUserBlocks("user.a")).toEqual([]);
    expect(store.loadUserBlocks("user.c")).toEqual(["user.d"]);

    store.wipeAll();
    expect(store.loadUserBlocks("user.c")).toEqual([]);
  });
});
