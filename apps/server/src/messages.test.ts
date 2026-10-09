import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageSchema } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import { makeUser } from "./identity.js";
import {
  cleanups,
  type InjectResponse,
  makeApp,
  newSession,
  reopenApp,
  teardownApps,
} from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("message authorization", () => {
  it("refuses a DM to a mesh sender artifact or to a bot that isn't the enabled assistant, with the generic DM answer", async () => {
    const botId = "llm.bot.test";
    const { app, dataDir } = await makeApp({
      llm: { ollama: { enabled: true, baseUrl: "http://localhost:11434", model: "m", botId, botDisplayName: "Bot" } },
    });
    const admin = await newSession(app);
    // A mesh sender's display record (sealed mail is delivered as a DM from it) and a bot the config no longer
    // enables are both records nobody reads: a DM to either would be stored and delivered to no one. The row
    // is planted and the node reopened so it loads like any stored record; the admin's session survives that.
    app.store.upsertUser(makeUser("mesh.0123456789abcdef0123456789abcdef"));
    const reopened = await reopenApp(app, dataDir);
    expect(
      (
        await reopened.server.inject({
          method: "PATCH",
          url: "/api/admin/config",
          headers: { cookie: admin.cookie },
          payload: { llm: { ollama: { enabled: false } } },
        })
      ).statusCode,
    ).toBe(200);

    for (const recipientUserId of ["mesh.0123456789abcdef0123456789abcdef", botId]) {
      const dm = await reopened.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: admin.cookie },
        payload: { type: "dm", recipientUserId, body: "anyone there?" },
      });
      expect(dm.statusCode).toBe(403);
      expect(dm.json()).toMatchObject({ code: "dm_unavailable" });
    }
    expect(reopened.store.loadMessages().filter((message) => message.type === "dm")).toEqual([]);
  });

  it("blocks reactions on DMs from non-participants", async () => {
    const app = await makeApp();
    const alice = await newSession(app);
    const bob = await newSession(app);
    const mallory = await newSession(app);

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "dm", recipientUserId: bob.userId, body: "secret" },
    });
    expect(dm.statusCode).toBe(201);
    const dmId = (dm.json() as { message: { id: string } }).message.id;

    const outsider = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: mallory.cookie },
      payload: { type: "reaction", targetMessageId: dmId, reaction: "👀" },
    });
    expect(outsider.statusCode).toBe(400);
    expect((outsider.json() as { error: string }).error).toMatch(/Cannot react/);

    const participant = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: bob.cookie },
      payload: { type: "reaction", targetMessageId: dmId, reaction: "👍" },
    });
    expect(participant.statusCode).toBe(201);
  });

  it("takes any single emoji as a new reaction, refuses anything else, and still removes an older one", async () => {
    const { app, dataDir } = await makeApp();
    const alice = await newSession(app);

    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "channelPost", channelId: "general", body: "hello" },
    });
    expect(post.statusCode).toBe(201);
    const postId = (post.json() as { message: { id: string } }).message.id;

    async function react(reaction: string, current = app) {
      return current.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: alice.cookie },
        payload: { type: "reaction", targetMessageId: postId, reaction },
      });
    }

    // Not on the client's built-in list, but one emoji from the keyboard: accepted.
    expect((await react("🦔")).statusCode).toBe(201);
    expect((await react("👩‍👩‍👧")).statusCode).toBe(201);

    for (const reaction of ["lol", "👍👍", " 👍", "❤"]) {
      const refused = await react(reaction);
      expect(refused.statusCode, reaction).toBe(400);
      expect((refused.json() as { code?: string }).code).toBe("reaction_invalid");
    }

    // A reaction stored before the rule (here seeded straight into the DB) can still be toggled off.
    app.store.insertMessage({
      id: "react_legacy",
      type: "reaction",
      authorId: alice.userId,
      targetMessageId: postId,
      reaction: "+1",
      createdAt: Date.now(),
    });
    const reopened = await reopenApp(app, dataDir);
    const removed = await react("+1", reopened);
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { deletedMessageId?: string }).deletedMessageId).toBe("react_legacy");
  });

  it("rejects DMs when enableDMs is off", async () => {
    const app = await makeApp({ features: { enableDMs: false } });
    const alice = await newSession(app);
    const bob = await newSession(app);

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "dm", recipientUserId: bob.userId, body: "secret" },
    });
    expect(dm.statusCode).toBe(400);
    expect((dm.json() as { code?: string }).code).toBe("dms_disabled");
  });

  it("enforces channel posting policy server-side", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    const base = {
      visibility: "public",
      allowPosting: "everyone",
      allowReplies: true,
      discoverable: true,
      createdAt: 1_704_067_200_000,
    };
    writeFileSync(
      join(dataDir, "channels.json"),
      JSON.stringify([
        { id: "general", name: "General", ...base },
        { id: "notices", name: "Notices", ...base, allowPosting: "admins" },
        { id: "old", name: "Old", ...base, archived: true },
      ]),
    );
    const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const admin = await newSession(app);
    const visitor = await newSession(app);
    const post = (cookie: string, channelId: string) =>
      app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie },
        payload: { type: "channelPost", channelId, body: "hello" },
      });

    expect((await post(visitor.cookie, "old")).statusCode).toBe(400);
    expect((await post(visitor.cookie, "notices")).statusCode).toBe(400);
    expect((await post(admin.cookie, "notices")).statusCode).toBe(201);
    expect((await post(visitor.cookie, "general")).statusCode).toBe(201);
  });
});

describe("public-channel flag", () => {
  it("blocks replies as well as posts when enablePublicChannels is off", async () => {
    const app = await makeApp({ features: { enablePublicChannels: false } });
    const session = await newSession(app);

    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "nope" },
    });
    expect(post.statusCode).toBe(400);

    const reply = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelReply", channelId: "general", parentMessageId: "msg_whatever", body: "nope" },
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toMatch(/Channel posting is disabled/);
  });
});

describe("message deletion API", () => {
  function postMessage(app: LoamApp, cookie: string, payload: object): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  function deleteMessage(app: LoamApp, cookie: string, id: string): Promise<InjectResponse> {
    return app.server.inject({ method: "DELETE", url: `/api/messages/${id}`, headers: { cookie } });
  }

  async function postId(app: LoamApp, cookie: string, payload: object): Promise<string> {
    const response = await postMessage(app, cookie, payload);
    expect(response.statusCode).toBe(201);
    return (response.json() as { message: { id: string } }).message.id;
  }

  const remainingIds = (app: LoamApp): string[] => app.store.loadMessages().map((message) => message.id);

  it("refuses a reply whose parent is itself a reply, and still cascades a nested reply an older database holds", async () => {
    const { app, dataDir } = await makeApp();
    await newSession(app);
    const author = await newSession(app);
    const rootId = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "root" });
    const replyId = await postId(app, author.cookie, {
      type: "channelReply",
      channelId: "general",
      parentMessageId: rootId,
      body: "reply",
    });

    // Threads are one level deep: a reply can only hang off a channel post.
    const nested = await postMessage(app, author.cookie, {
      type: "channelReply",
      channelId: "general",
      parentMessageId: replyId,
      body: "reply to a reply",
    });
    expect(nested.statusCode).toBe(400);
    expect(nested.json()).toMatchObject({ code: "parent_not_found" });

    // A database written before that rule may hold one. Deleting the middle reply takes it along instead of
    // leaving it pointing at a parent that no longer exists.
    app.store.insertMessage(
      MessageSchema.parse({
        id: "msg_legacynested00",
        type: "channelReply",
        channelId: "general",
        parentMessageId: replyId,
        authorId: author.userId,
        body: "orphan in waiting",
        createdAt: Date.now(),
      }),
    );
    const reopened = await reopenApp(app, dataDir);
    const deleted = await deleteMessage(reopened, author.cookie, replyId);
    expect(deleted.statusCode).toBe(200);
    expect((deleted.json() as { deletedIds: string[] }).deletedIds.sort()).toEqual([replyId, "msg_legacynested00"].sort());
    expect(remainingIds(reopened)).toEqual([rootId]);
  });

  it("lets an author delete their own message", async () => {
    const app = await makeApp();
    await newSession(app); // burn the firstUser=admin slot so the author below is a plain user
    const author = await newSession(app);
    expect(author.isAdmin).toBe(false);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "hi" });

    expect((await deleteMessage(app, author.cookie, id)).statusCode).toBe(200);
    expect(remainingIds(app)).not.toContain(id);
  });

  it("stops a non-author non-admin from deleting someone else's message", async () => {
    const app = await makeApp();
    await newSession(app);
    const author = await newSession(app);
    const other = await newSession(app);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "hi" });

    const response = await deleteMessage(app, other.cookie, id);
    expect(response.statusCode).toBe(403);
    expect(remainingIds(app)).toContain(id);
  });

  it("lets an admin delete anyone's message (moderation)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    expect(admin.isAdmin).toBe(true);
    const author = await newSession(app);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "hi" });

    expect((await deleteMessage(app, admin.cookie, id)).statusCode).toBe(200);
    expect(remainingIds(app)).not.toContain(id);
  });

  it("returns 404 for a message that does not exist", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    expect((await deleteMessage(app, admin.cookie, "msg_missing")).statusCode).toBe(404);
  });

  it("cascades: deleting a thread root removes its replies and reactions", async () => {
    const app = await makeApp();
    await newSession(app);
    const author = await newSession(app);
    const rootId = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "root" });
    const replyId = await postId(app, author.cookie, {
      type: "channelReply",
      channelId: "general",
      parentMessageId: rootId,
      body: "reply",
    });
    expect((await postMessage(app, author.cookie, { type: "reaction", targetMessageId: rootId, reaction: "👍" })).statusCode).toBe(201);

    const response = await deleteMessage(app, author.cookie, rootId);
    expect(response.statusCode).toBe(200);
    const deletedIds = (response.json() as { deletedIds: string[] }).deletedIds;
    expect(deletedIds).toContain(rootId);
    expect(deletedIds).toContain(replyId);

    const remaining = app.store.loadMessages();
    expect(remaining.map((message) => message.id)).not.toContain(rootId);
    expect(remaining.map((message) => message.id)).not.toContain(replyId);
    expect(remaining.some((message) => message.type === "reaction")).toBe(false);
  });

  it("won't let a non-admin delete a thread others have replied to, but an admin can", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const author = await newSession(app);
    const other = await newSession(app);
    const rootId = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "root" });
    await postId(app, other.cookie, {
      type: "channelReply",
      channelId: "general",
      parentMessageId: rootId,
      body: "someone else's reply",
    });

    // The author can't delete the root because the cascade would remove another user's reply.
    expect((await deleteMessage(app, author.cookie, rootId)).statusCode).toBe(403);
    // An admin can moderate it.
    expect((await deleteMessage(app, admin.cookie, rootId)).statusCode).toBe(200);
    expect(app.store.loadMessages()).toEqual([]);
  });
});

describe("message editing API", () => {
  function postMessage(app: LoamApp, cookie: string, payload: object): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  function editMessage(app: LoamApp, cookie: string, id: string, payload: object): Promise<InjectResponse> {
    return app.server.inject({ method: "PATCH", url: `/api/messages/${id}`, headers: { cookie }, payload });
  }

  async function postId(app: LoamApp, cookie: string, payload: object): Promise<string> {
    const response = await postMessage(app, cookie, payload);
    expect(response.statusCode).toBe(201);
    return (response.json() as { message: { id: string } }).message.id;
  }

  it("lets an author edit their own message and stamps editedAt", async () => {
    const app = await makeApp();
    await newSession(app);
    const author = await newSession(app);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "typo herre" });

    const response = await editMessage(app, author.cookie, id, { body: "typo here" });
    expect(response.statusCode).toBe(200);
    const edited = response.json() as { body: string; editedAt?: number };
    expect(edited.body).toBe("typo here");
    expect(typeof edited.editedAt).toBe("number");

    const stored = app.store.loadMessages().find((message) => message.id === id);
    expect(stored && "body" in stored ? stored.body : undefined).toBe("typo here");
  });

  it("won't let another user (even an admin) edit someone else's message", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const author = await newSession(app);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "mine" });

    // Editing someone else's words is impersonation — admins moderate by deleting, not editing.
    expect((await editMessage(app, admin.cookie, id, { body: "tampered" })).statusCode).toBe(403);
    const stored = app.store.loadMessages().find((message) => message.id === id);
    expect(stored && "body" in stored ? stored.body : undefined).toBe("mine");
  });

  it("rejects an empty edited body and a missing message", async () => {
    const app = await makeApp();
    await newSession(app);
    const author = await newSession(app);
    const id = await postId(app, author.cookie, { type: "channelPost", channelId: "general", body: "keep" });

    expect((await editMessage(app, author.cookie, id, { body: "   " })).statusCode).toBe(400);
    expect((await editMessage(app, author.cookie, "msg_missing", { body: "hi" })).statusCode).toBe(404);
  });

  it("answers an outsider editing a private-channel message with the same 404 as an unknown id, like DELETE does", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const member = await newSession(app);
    const outsider = await newSession(app);
    const channelId = (
      (
        await app.server.inject({
          method: "POST",
          url: "/api/channels",
          headers: { cookie: owner.cookie },
          payload: { name: "Quiet", visibility: "private" },
        })
      ).json() as { id: string }
    ).id;
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/channels/${channelId}/members`,
          headers: { cookie: owner.cookie },
          payload: { userId: member.userId },
        })
      ).statusCode,
    ).toBe(200);
    const id = await postId(app, owner.cookie, { type: "channelPost", channelId, body: "ours" });

    // Not a member: the message does not exist as far as they can tell (a 403 would confirm it does).
    const outside = await editMessage(app, outsider.cookie, id, { body: "theirs" });
    expect(outside.statusCode).toBe(404);
    expect(outside.json()).toEqual((await editMessage(app, outsider.cookie, "msg_missing", { body: "x" })).json());

    // A member who isn't the author still gets the authorship answer.
    const inside = await editMessage(app, member.cookie, id, { body: "theirs" });
    expect(inside.statusCode).toBe(403);
    expect(inside.json()).toMatchObject({ code: "edit_own_only" });
  });
});

describe("message retention (ephemeral messages)", () => {
  it("reaps messages older than the configured TTL and keeps newer ones", async () => {
    // Fake timers make the age boundary exact and instant (was a real ~700ms sleep): the old
    // message is posted, the clock jumps a full TTL past its `createdAt`, then the fresh one is
    // posted so it sits safely inside the window while the old one falls outside it. Fake only
    // `Date` — the reaper's cutoff is the only clock this cares about, and faking the whole event
    // loop would deadlock `server.inject` (it needs real setImmediate/timers).
    const app = await makeApp({ retention: { messageTtlMs: 500 } });
    const session = await newSession(app);
    vi.useFakeTimers({ toFake: ["Date"] });

    const oldPost = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "old enough to expire" },
    });
    expect(oldPost.statusCode).toBe(201);

    await vi.advanceTimersByTimeAsync(700);

    const freshPost = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "still fresh" },
    });
    expect(freshPost.statusCode).toBe(201);

    app.reapExpiredMessages();

    const bodies = app.store.loadMessages().map((message) => ("body" in message ? message.body : ""));
    expect(bodies).toEqual(["still fresh"]);

    const served = (
      await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: session.cookie } })
    ).json() as { body?: string }[];
    expect(served.map((message) => message.body)).toEqual(["still fresh"]);
  });

  it("honors a per-channel retention TTL even when the node default is off", async () => {
    const app = await makeApp(); // no global retention TTL
    const admin = await newSession(app);
    vi.useFakeTimers({ toFake: ["Date"] });

    // A 1s TTL on `general` only; `announcements` keeps the node default (off).
    const patched = await app.server.inject({
      method: "PATCH",
      url: "/api/channels/general",
      headers: { cookie: admin.cookie },
      payload: { messageTtlMs: 1000 },
    });
    expect(patched.statusCode).toBe(200);

    expect(
      (await app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: admin.cookie },
        payload: { type: "channelPost", channelId: "general", body: "channel-ephemeral" },
      })).statusCode,
    ).toBe(201);

    await vi.advanceTimersByTimeAsync(1500);

    // Posted after the jump, in a channel with no per-channel TTL and the node default off — must survive.
    expect(
      (await app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: admin.cookie },
        payload: { type: "channelPost", channelId: "announcements", body: "no ttl here" },
      })).statusCode,
    ).toBe(201);

    app.reapExpiredMessages();

    const bodies = app.store.loadMessages().map((message) => ("body" in message ? message.body : ""));
    expect(bodies).toContain("no ttl here");
    expect(bodies).not.toContain("channel-ephemeral");
  });

  it("a channel's retention TTL is admin-only: the owner is refused, an admin is not", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    expect(owner.isAdmin).toBe(false);

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "mine" },
    });
    expect(created.statusCode).toBe(201);
    const channelId = (created.json() as { id: string }).id;
    const patchAs = (cookie: string, payload: object) =>
      app.server.inject({ method: "PATCH", url: `/api/channels/${channelId}`, headers: { cookie }, payload });

    const lengthen = await patchAs(owner.cookie, { messageTtlMs: 10_000_000_000 });
    expect(lengthen.statusCode).toBe(403);
    expect((lengthen.json() as { code?: string }).code).toBe("admin_required");
    // Clearing the channel TTL is a retention change too.
    expect((await patchAs(owner.cookie, { messageTtlMs: null })).statusCode).toBe(403);
    // The owner's other settings are untouched by the rule.
    expect((await patchAs(owner.cookie, { description: "still mine" })).statusCode).toBe(200);
    expect(app.store.loadChannels().find((channel) => channel.id === channelId)?.messageTtlMs).toBeUndefined();

    const byAdmin = await patchAs(admin.cookie, { messageTtlMs: 60_000 });
    expect(byAdmin.statusCode).toBe(200);
    expect((byAdmin.json() as { messageTtlMs?: number }).messageTtlMs).toBe(60_000);
  });

  it("a channel TTL can only shorten the node-wide TTL, never lengthen it", async () => {
    const app = await makeApp({ retention: { messageTtlMs: 1 } });
    const admin = await newSession(app);
    vi.useFakeTimers({ toFake: ["Date"] });

    const patched = await app.server.inject({
      method: "PATCH",
      url: "/api/channels/general",
      headers: { cookie: admin.cookie },
      payload: { messageTtlMs: 10_000_000_000 },
    });
    expect(patched.statusCode).toBe(200);
    expect(
      (await app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: admin.cookie },
        payload: { type: "channelPost", channelId: "general", body: "outlives nothing" },
      })).statusCode,
    ).toBe(201);

    await vi.advanceTimersByTimeAsync(10);
    app.reapExpiredMessages();
    expect(app.store.loadMessages()).toEqual([]);
  });

  it("a channel TTL below the node-wide TTL still shortens retention for that channel", async () => {
    const app = await makeApp({ retention: { messageTtlMs: 3_600_000 } });
    const admin = await newSession(app);
    vi.useFakeTimers({ toFake: ["Date"] });

    expect(
      (await app.server.inject({
        method: "PATCH",
        url: "/api/channels/general",
        headers: { cookie: admin.cookie },
        payload: { messageTtlMs: 500 },
      })).statusCode,
    ).toBe(200);
    const postTo = (channelId: string, body: string) =>
      app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: admin.cookie },
        payload: { type: "channelPost", channelId, body },
      });
    expect((await postTo("general", "short-lived")).statusCode).toBe(201);
    expect((await postTo("announcements", "node default applies")).statusCode).toBe(201);

    await vi.advanceTimersByTimeAsync(700);
    app.reapExpiredMessages();
    const bodies = app.store.loadMessages().map((message) => ("body" in message ? message.body : ""));
    expect(bodies).toEqual(["node default applies"]);
  });

  it("does nothing when no TTL is configured", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "kept forever" },
    });

    app.reapExpiredMessages();
    expect(app.store.loadMessages().length).toBe(1);
  });

  it("applies a TTL set via the admin config API and clears it with null", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    // Fake only `Date` (see the reap-and-keep test): faking timers wholesale would hang inject.
    vi.useFakeTimers({ toFake: ["Date"] });

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "doomed" },
    });

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { retention: { messageTtlMs: 1 } },
    });
    expect(patch.statusCode).toBe(200);

    // Advance past the 1ms TTL so the message is reliably expired (was a real 10ms sleep).
    await vi.advanceTimersByTimeAsync(10);
    app.reapExpiredMessages();
    expect(app.store.loadMessages()).toEqual([]);

    const clear = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { retention: { messageTtlMs: null } },
    });
    expect(clear.statusCode).toBe(200);
    const cleared = clear.json() as { retention: { messageTtlMs?: number } };
    expect(cleared.retention.messageTtlMs).toBeUndefined();
  });
});

describe("message retention: thread cascade", () => {
  it("retention reaper cascades an expired thread root to its replies and reactions", async () => {
    const app = await makeApp({ retention: { messageTtlMs: 500 } });
    const session = await newSession(app);
    // Fake only `Date` (see the reap-and-keep test): faking timers wholesale would hang inject.
    vi.useFakeTimers({ toFake: ["Date"] });

    const root = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "expiring root" },
    });
    const rootId = (root.json() as { message: { id: string } }).message.id;

    // Jump a full TTL past the root's `createdAt` (was a real 700ms sleep); the reply + reaction
    // added afterwards are young, so only the cascade — not their own age — can reap them.
    await vi.advanceTimersByTimeAsync(700);

    // Young reply + reaction attached to the now-expired root.
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelReply", channelId: "general", parentMessageId: rootId, body: "fresh reply" },
    });
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "reaction", targetMessageId: rootId, reaction: "👍" },
    });

    app.reapExpiredMessages();

    // No orphans: the root's whole thread goes with it.
    expect(app.store.loadMessages()).toEqual([]);
  });
});

describe("message search", () => {
  function search(app: LoamApp, cookie: string, query: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "GET",
      url: `/api/search?q=${encodeURIComponent(query)}`,
      headers: { cookie },
    });
  }

  function results(response: InjectResponse): { id: string; body?: string }[] {
    return (response.json() as { results: { id: string; body?: string }[] }).results;
  }

  async function post(app: LoamApp, cookie: string, channelId: string, body: string): Promise<string> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId, body },
    });
    return (response.json() as { message: { id: string } }).message.id;
  }

  it("matches case-insensitively, newest first, and requires a query", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    await post(app, session.cookie, "general", "The water point is OPEN again");
    await post(app, session.cookie, "general", "Bring water bottles tomorrow");
    await post(app, session.cookie, "general", "Unrelated note");

    const response = await search(app, session.cookie, "water");
    expect(response.statusCode).toBe(200);
    const found = results(response);
    expect(found.length).toBe(2);
    expect(found[0]?.body).toBe("Bring water bottles tomorrow");
    expect(found[1]?.body).toBe("The water point is OPEN again");

    expect((await search(app, session.cookie, "   ")).statusCode).toBe(400);
  });

  it("keeps DMs scoped to their participants", async () => {
    const app = await makeApp();
    const alice = await newSession(app);
    const bob = await newSession(app);
    const eve = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "dm", recipientUserId: bob.userId, body: "secret rendezvous point" },
    });

    expect(results(await search(app, alice.cookie, "rendezvous")).length).toBe(1);
    expect(results(await search(app, bob.cookie, "rendezvous")).length).toBe(1);
    expect(results(await search(app, eve.cookie, "rendezvous")).length).toBe(0);
  });

  it("keeps private-channel messages scoped to members and still searches archived channels", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Quiet Room", visibility: "private" },
    });
    const channelId = (created.json() as { id: string }).id;
    await post(app, owner.cookie, channelId, "meet at the quiet spot");

    expect(results(await search(app, owner.cookie, "quiet spot")).length).toBe(1);
    expect(results(await search(app, outsider.cookie, "quiet spot")).length).toBe(0);
    expect(results(await search(app, admin.cookie, "quiet spot")).length).toBe(0);

    // Archived channels stay searchable — archive is read-only-but-available, and search is a read.
    await post(app, admin.cookie, "general", "archive me please");
    await app.server.inject({
      method: "PATCH",
      url: "/api/channels/general",
      headers: { cookie: admin.cookie },
      payload: { archived: true },
    });
    expect(results(await search(app, admin.cookie, "archive me")).length).toBe(1);
  });

  it("shows a shadow-banned author's messages only to themselves", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);

    await post(app, target.cookie, "general", "shadow banned words");
    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    expect(results(await search(app, target.cookie, "shadow banned words")).length).toBe(1);
    expect(results(await search(app, admin.cookie, "shadow banned words")).length).toBe(0);
  });

  it("caps results at the requested limit", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    for (let index = 0; index < 5; index += 1) {
      await post(app, session.cookie, "general", `flood message ${index}`);
    }

    const response = await app.server.inject({
      method: "GET",
      url: "/api/search?q=flood&limit=3",
      headers: { cookie: session.cookie },
    });
    expect(results(response).length).toBe(3);
  });
});

describe("typing indicator", () => {
  it("accepts a channel typing ping (204), rejects an invalid body, and no-ops an inaccessible channel", async () => {
    const app = await makeApp();
    const session = await newSession(app);
    const typing = (payload: Record<string, unknown>) =>
      app.server.inject({ method: "POST", url: "/api/typing", headers: { cookie: session.cookie }, payload });

    expect((await typing({ channelId: "general" })).statusCode).toBe(204);
    // Exactly one of channelId / recipientUserId — both (or neither) is a 400.
    expect((await typing({ channelId: "general", recipientUserId: "user.1234" })).statusCode).toBe(400);
    expect((await typing({})).statusCode).toBe(400);
    // A channel the caller can't see is a silent no-op (still 204 — never leaks existence, never broadcasts).
    expect((await typing({ channelId: "does-not-exist" })).statusCode).toBe(204);
  });
});

describe("location sharing", () => {
  it("rejects a shared location when the feature is off (default), accepts it when on", async () => {
    const off = await makeApp();
    const offUser = await newSession(off);
    const rejected = await off.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: offUser.cookie },
      payload: { type: "channelPost", channelId: "general", body: "meet here", location: { label: "north gate" } },
    });
    expect(rejected.statusCode).toBe(400);

    const on = await makeApp({ features: { enableLocationSharing: true } });
    const onUser = await newSession(on);
    const accepted = await on.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: onUser.cookie },
      payload: {
        type: "channelPost",
        channelId: "general",
        body: "",
        location: { label: "north gate", lat: 51.5, lng: -0.12 },
      },
    });
    expect(accepted.statusCode).toBe(201);
    const stored = (accepted.json() as { message: { location?: { label?: string; lat?: number; lng?: number } } }).message;
    expect(stored.location).toEqual({ label: "north gate", lat: 51.5, lng: -0.12 });

    // Config advertises the flag to the client.
    const cfg = (await on.server.inject({ method: "GET", url: "/api/config", headers: { cookie: onUser.cookie } }))
      .json() as { networkConfig: { enableLocationSharing: boolean } };
    expect(cfg.networkConfig.enableLocationSharing).toBe(true);
  });

  it("rejects a location with neither a label nor coordinates", async () => {
    const app = await makeApp({ features: { enableLocationSharing: true } });
    const user = await newSession(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "channelPost", channelId: "general", body: "x", location: { lat: 51.5 } },
    });
    expect(res.statusCode).toBe(400);
  });
});
