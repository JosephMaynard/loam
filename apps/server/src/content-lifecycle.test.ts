import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import {
  cleanups,
  type InjectResponse,
  makeApp,
  newSession,
  openTransport08,
  resumeIdentity,
  teardownApps,
  tunnelInner,
} from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("content-mutation lifecycle: members, timeouts, archived and deleted channels", () => {
  it("exposes the transport public key for embedding hosts (keyed #k= join QR, no HTTP round-trip)", async () => {
    const app = await makeApp();
    const key = app.getTransportPublicKey();
    // base64url X25519 public key — what the loamnet CLI appends as the QR's #k= fragment.
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });


  /** POST a channel message as `cookie`, returning the created message id. */
  async function postIn(app: LoamApp, cookie: string, channelId: string, body: string): Promise<string> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId, body },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { message: { id: string } }).message.id;
  }

  function edit(app: LoamApp, cookie: string, messageId: string, body: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "PATCH",
      url: `/api/messages/${messageId}`,
      headers: { cookie },
      payload: { body },
    });
  }

  function del(app: LoamApp, cookie: string, messageId: string): Promise<InjectResponse> {
    return app.server.inject({ method: "DELETE", url: `/api/messages/${messageId}`, headers: { cookie } });
  }

  function react(app: LoamApp, cookie: string, targetMessageId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "reaction", targetMessageId, reaction: "👍" },
    });
  }

  it("blocks a removed private-channel member from editing or deleting their old messages", async () => {
    const app = await makeApp();
    const owner = await newSession(app);
    const member = await newSession(app);

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Quiet Ops", visibility: "private" },
    });
    const channelId = (created.json() as { id: string }).id;
    await app.server.inject({
      method: "POST",
      url: `/api/channels/${channelId}/members`,
      headers: { cookie: owner.cookie },
      payload: { userId: member.userId },
    });

    const messageId = await postIn(app, member.cookie, channelId, "original words");
    // Still a member: editing works.
    expect((await edit(app, member.cookie, messageId, "edited while member")).statusCode).toBe(200);

    await app.server.inject({
      method: "DELETE",
      url: `/api/channels/${channelId}/members/${member.userId}`,
      headers: { cookie: owner.cookie },
    });

    // Removed: edit and delete both answer like the message no longer exists (404-parity), and the
    // content is unchanged for those still inside.
    expect((await edit(app, member.cookie, messageId, "injected after removal")).statusCode).toBe(404);
    expect((await del(app, member.cookie, messageId)).statusCode).toBe(404);
    const visible = await app.server.inject({
      method: "GET",
      url: `/api/messages/${channelId}`,
      headers: { cookie: owner.cookie },
    });
    const bodies = (visible.json() as { body?: string }[]).map((entry) => entry.body);
    expect(bodies).toContain("edited while member");
    expect(bodies).not.toContain("injected after removal");
  });

  it("blocks a timed-out user from editing, deleting, reacting, and uploading — but not reading", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const user = await newSession(app);
    const userMessageId = await postIn(app, user.cookie, "general", "before the timeout");
    const adminMessageId = await postIn(app, admin.cookie, "general", "react to me");

    const timeout = await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${user.userId}`,
      headers: { cookie: admin.cookie },
      payload: { timeoutUntil: Date.now() + 60_000 },
    });
    expect(timeout.statusCode).toBe(200);

    expect((await edit(app, user.cookie, userMessageId, "rewritten during timeout")).statusCode).toBe(403);
    expect((await del(app, user.cookie, userMessageId)).statusCode).toBe(403);
    expect((await react(app, user.cookie, adminMessageId)).statusCode).toBe(403);
    const upload = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie: user.cookie },
      payload: { mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") },
    });
    expect(upload.statusCode).toBe(403);

    // Reading stays open — a timeout is a write-block, not an exile.
    const read = await app.server.inject({
      method: "GET",
      url: "/api/messages/general",
      headers: { cookie: user.cookie },
    });
    expect(read.statusCode).toBe(200);
  });

  it("makes an archived channel read-only: no posts, edits, or reactions — but reads, search, and listing work", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const user = await newSession(app);
    const userMessageId = await postIn(app, user.cookie, "general", "posted before archive");

    await app.server.inject({
      method: "PATCH",
      url: "/api/channels/general",
      headers: { cookie: admin.cookie },
      payload: { archived: true },
    });

    // Writes of every kind refuse.
    const newPost = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "channelPost", channelId: "general", body: "into the archive" },
    });
    expect(newPost.statusCode).toBe(400);
    expect((await edit(app, user.cookie, userMessageId, "rewriting history")).statusCode).toBe(403);
    expect((await react(app, user.cookie, userMessageId)).statusCode).toBe(400);

    // Reads keep working, and the channel stays listed with its flag.
    const read = await app.server.inject({
      method: "GET",
      url: "/api/messages/general",
      headers: { cookie: user.cookie },
    });
    expect(read.statusCode).toBe(200);
    const channels = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie: user.cookie },
    });
    const general = (channels.json() as { id: string; archived?: boolean }[]).find((entry) => entry.id === "general");
    expect(general?.archived).toBe(true);

    // An admin may still moderate archived history (delete), the one deliberate override.
    expect((await del(app, admin.cookie, userMessageId)).statusCode).toBe(200);
  });

  it("deletes a channel permanently: owner/admin only, full cascade, 404 afterwards", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const user = await newSession(app);

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
      payload: { name: "Doomed" },
    });
    const channelId = (created.json() as { id: string }).id;
    await postIn(app, user.cookie, channelId, "soon to be gone");

    // A non-owner non-admin cannot delete.
    expect(
      (await app.server.inject({ method: "DELETE", url: `/api/channels/${channelId}`, headers: { cookie: user.cookie } }))
        .statusCode,
    ).toBe(403);

    const deleted = await app.server.inject({
      method: "DELETE",
      url: `/api/channels/${channelId}`,
      headers: { cookie: admin.cookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect((deleted.json() as { deletedChannelId: string }).deletedChannelId).toBe(channelId);

    // Gone for good: history 404s, the lists no longer carry it, a second delete 404s.
    expect(
      (await app.server.inject({ method: "GET", url: `/api/messages/${channelId}`, headers: { cookie: user.cookie } }))
        .statusCode,
    ).toBe(404);
    const channels = await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: user.cookie } });
    expect((channels.json() as { id: string }[]).some((entry) => entry.id === channelId)).toBe(false);
    expect(
      (await app.server.inject({ method: "DELETE", url: `/api/channels/${channelId}`, headers: { cookie: admin.cookie } }))
        .statusCode,
    ).toBe(404);
  });

  it("hides private-channel deletion behind 404-parity and lets a non-member admin delete", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Hidden Room", visibility: "private" },
    });
    const channelId = (created.json() as { id: string }).id;

    // An outsider gets the same answer as a missing channel — never a 403 that confirms existence.
    expect(
      (
        await app.server.inject({
          method: "DELETE",
          url: `/api/channels/${channelId}`,
          headers: { cookie: outsider.cookie },
        })
      ).statusCode,
    ).toBe(404);

    // An admin who is NOT a member may still delete (manage-without-reading, like rename/archive).
    expect(
      (await app.server.inject({ method: "DELETE", url: `/api/channels/${channelId}`, headers: { cookie: admin.cookie } }))
        .statusCode,
    ).toBe(200);
  });
});

describe("content-mutation lifecycle: reactions, policy lockdowns, roster freezes and timeouts", () => {
  async function postIn(app: LoamApp, cookie: string, channelId: string, body: string): Promise<string> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId, body },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { message: { id: string } }).message.id;
  }

  async function reactTo(app: LoamApp, cookie: string, targetMessageId: string): Promise<string> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "reaction", targetMessageId, reaction: "👍" },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { message: { id: string } }).message.id;
  }

  it("blocks deleting a reaction in an archived channel, and by a removed member (the reaction hole)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const user = await newSession(app);

    // Archived: the reaction's CHANNEL state governs its deletion, resolved via the target.
    const postId = await postIn(app, admin.cookie, "general", "react here");
    const reactionId = await reactTo(app, user.cookie, postId);
    await app.server.inject({
      method: "PATCH",
      url: "/api/channels/general",
      headers: { cookie: admin.cookie },
      payload: { archived: true },
    });
    const archivedDelete = await app.server.inject({
      method: "DELETE",
      url: `/api/messages/${reactionId}`,
      headers: { cookie: user.cookie },
    });
    expect(archivedDelete.statusCode).toBe(403);

    // Removed private member: 404-parity, like their posts.
    const owner = await newSession(app);
    const member = await newSession(app);
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "React Room", visibility: "private" },
    });
    const channelId = (created.json() as { id: string }).id;
    await app.server.inject({
      method: "POST",
      url: `/api/channels/${channelId}/members`,
      headers: { cookie: owner.cookie },
      payload: { userId: member.userId },
    });
    const privatePostId = await postIn(app, owner.cookie, channelId, "member reacts");
    const privateReactionId = await reactTo(app, member.cookie, privatePostId);
    await app.server.inject({
      method: "DELETE",
      url: `/api/channels/${channelId}/members/${member.userId}`,
      headers: { cookie: owner.cookie },
    });
    const removedDelete = await app.server.inject({
      method: "DELETE",
      url: `/api/messages/${privateReactionId}`,
      headers: { cookie: member.cookie },
    });
    expect(removedDelete.statusCode).toBe(404);
  });

  it("blocks edits after a posting-policy lockdown (edit can't inject what posting refuses)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const user = await newSession(app);
    const messageId = await postIn(app, user.cookie, "general", "posted while open");

    await app.server.inject({
      method: "PATCH",
      url: "/api/channels/general",
      headers: { cookie: admin.cookie },
      payload: { allowPosting: "admins" },
    });

    const edit = await app.server.inject({
      method: "PATCH",
      url: `/api/messages/${messageId}`,
      headers: { cookie: user.cookie },
      payload: { body: "SPAM injected after lockdown" },
    });
    expect(edit.statusCode).toBe(403);

    // The admin (who may still post here) can still edit their own.
    const adminMessageId = await postIn(app, admin.cookie, "general", "admins only now");
    const adminEdit = await app.server.inject({
      method: "PATCH",
      url: `/api/messages/${adminMessageId}`,
      headers: { cookie: admin.cookie },
      payload: { body: "admins only now (edited)" },
    });
    expect(adminEdit.statusCode).toBe(200);
  });

  it("refuses a non-admin owner deleting a channel that holds other people's messages", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const other = await newSession(app);
    expect(owner.isAdmin).toBe(false);

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Shared Space" },
    });
    const channelId = (created.json() as { id: string }).id;
    await postIn(app, other.cookie, channelId, "someone else's words");

    // The owner may not cascade another person's content away...
    const ownerDelete = await app.server.inject({
      method: "DELETE",
      url: `/api/channels/${channelId}`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerDelete.statusCode).toBe(403);

    // ...but an admin may (moderation), and an owner CAN delete an own-content-only channel.
    const soloChannel = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "My Notes" },
    });
    const soloId = (soloChannel.json() as { id: string }).id;
    await postIn(app, owner.cookie, soloId, "only mine");
    expect(
      (await app.server.inject({ method: "DELETE", url: `/api/channels/${soloId}`, headers: { cookie: owner.cookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.server.inject({ method: "DELETE", url: `/api/channels/${channelId}`, headers: { cookie: admin.cookie } }))
        .statusCode,
    ).toBe(200);
  });

  it("freezes roster growth on an archived private channel (invite, transfer, approve)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const invitee = await newSession(app);
    const requester = await newSession(app);

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Frozen Room", visibility: "private" },
    });
    const channelId = (created.json() as { id: string }).id;
    await app.server.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers: { cookie: owner.cookie },
      payload: { allowJoinRequests: true },
    });
    // A join request filed BEFORE the archive...
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/channels/${channelId}/join-requests`,
          headers: { cookie: requester.cookie },
        })
      ).statusCode,
    ).toBe(201);

    await app.server.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers: { cookie: admin.cookie },
      payload: { archived: true },
    });

    // ...cannot be approved while archived, and neither invites nor transfers land.
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/channels/${channelId}/members`,
          headers: { cookie: owner.cookie },
          payload: { userId: invitee.userId },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/channels/${channelId}/transfer`,
          headers: { cookie: owner.cookie },
          payload: { userId: invitee.userId },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/channels/${channelId}/join-requests/${requester.userId}/approve`,
          headers: { cookie: owner.cookie },
        })
      ).statusCode,
    ).toBe(403);

    // Shrinking stays allowed: the owner can still remove a member / a member can leave.
    // (Roster is owner-only here, so removal of the owner is guarded elsewhere — just assert the
    // restore path re-enables growth.)
    await app.server.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers: { cookie: admin.cookie },
      payload: { archived: false },
    });
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/channels/${channelId}/members`,
          headers: { cookie: owner.cookie },
          payload: { userId: invitee.userId },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("a deleted default channel stays deleted across a restart (no reseed resurrection)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    let app: LoamApp = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });

    try {
      const admin = await newSession(app);
      expect(
        (await app.server.inject({ method: "DELETE", url: "/api/channels/general", headers: { cookie: admin.cookie } }))
          .statusCode,
      ).toBe(200);
      // Delete only ONE default: the reseed must not run (channels aren't empty) and, even if all
      // were gone, the tombstone filter must keep `general` out.
      await app.close();
      app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
      const session = await newSession(app);
      const channels = (
        await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: session.cookie } })
      ).json() as { id: string }[];
      expect(channels.some((entry) => entry.id === "general")).toBe(false);
      expect(channels.some((entry) => entry.id === "announcements")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("uploads a near-cap attachment through the encrypted tunnel (the hardened-mode path)", async () => {
    const app = await makeApp();
    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.status).toBe(200);

    // ~1 MiB raw → base64 JSON → sealed+base64 tunnel envelope: the double-wrapped worst case the
    // per-route body ceiling exists for. A regression here breaks every upload in `required` mode.
    const nearCap = Buffer.alloc(1024 * 1024 - 16, 7);
    const inner = await tunnelInner(app, session, 2, {
      m: "POST",
      p: "/api/attachments",
      body: { mimeType: "application/pdf", data: nearCap.toString("base64") },
    });
    expect(inner.outerStatus).toBe(200);
    expect(inner.status).toBe(201);
  });

  it("targets channelRemoved on permanent delete to the private audience only", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Vanishing Room", visibility: "private" },
    });
    const channelId = (created.json() as { id: string }).id;

    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const sockets: WebSocket[] = [];
    const connectFor = (cookie: string) =>
      new Promise<{ events: { type?: string; channelId?: string }[] }>((resolve, reject) => {
        const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
          `${baseUrl.replace("http", "ws")}/ws`,
          { headers: { cookie } },
        );
        const events: { type?: string; channelId?: string }[] = [];
        socket.addEventListener("message", (event) => {
          events.push(JSON.parse(String((event as MessageEvent).data)) as { type?: string });
        });
        socket.addEventListener("open", () => {
          sockets.push(socket);
          resolve({ events });
        });
        socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
      });

    try {
      const ownerFeed = await connectFor(owner.cookie);
      const outsiderFeed = await connectFor(outsider.cookie);
      const adminFeed = await connectFor(admin.cookie);

      const deleted = await app.server.inject({
        method: "DELETE",
        url: `/api/channels/${channelId}`,
        headers: { cookie: admin.cookie },
      });
      expect(deleted.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 150));

      // channelRemoved is what purges a connected client's cached copy — the "gone for good"
      // promise for online devices. It must reach the audience and ONLY the audience.
      expect(
        ownerFeed.events.some((event) => event.type === "channelRemoved" && event.channelId === channelId),
      ).toBe(true);
      expect(outsiderFeed.events.some((event) => event.type === "channelRemoved")).toBe(false);
      // The ACTING admin (not a member) must hear it too — their admin panel had upserted the
      // channel into their own client state, which only this event purges.
      expect(
        adminFeed.events.some((event) => event.type === "channelRemoved" && event.channelId === channelId),
      ).toBe(true);
    } finally {
      for (const socket of sockets) {
        socket.close();
      }
    }
  });

  it("blocks a timed-out user from uploading a new avatar image", async () => {
    const app = await makeApp({ identity: { allowUserAvatarEdit: true, allowUserAvatarUpload: true } });
    const admin = await newSession(app);
    const user = await newSession(app);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${user.userId}`,
      headers: { cookie: admin.cookie },
      payload: { timeoutUntil: Date.now() + 60_000 },
    });

    const upload = await app.server.inject({
      method: "PUT",
      url: "/api/users/me/avatar-image",
      headers: { cookie: user.cookie },
      payload: { mimeType: "image/png", data: Buffer.from("hi").toString("base64") },
    });
    expect(upload.statusCode).toBe(403);
    expect((upload.json() as { error: string }).error).toMatch(/timed out/);
  });

  it("blocks a timed-out user's profile edits, but deliberately not their join requests", async () => {
    const app = await makeApp({ identity: { allowUserDisplayNameEdit: true } });
    const admin = await newSession(app);
    const owner = await newSession(app);
    const user = await newSession(app);

    // A private channel accepting join requests, set up before the timeout.
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Requestable Room", visibility: "private" },
    });
    const channelId = (created.json() as { id: string }).id;
    await app.server.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers: { cookie: owner.cookie },
      payload: { allowJoinRequests: true },
    });

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${user.userId}`,
      headers: { cookie: admin.cookie },
      payload: { timeoutUntil: Date.now() + 60_000 },
    });

    // A profile edit broadcasts to the roster — blocked like every publishing surface.
    const rename = await app.server.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie: user.cookie },
      payload: { displayName: "look at me anyway" },
    });
    expect(rename.statusCode).toBe(403);
    expect((rename.json() as { error: string }).error).toMatch(/timed out/);

    // A join request publishes nothing and grants nothing without approval — DELIBERATELY allowed
    // during a timeout (a write block, not a participation penalty). This pins the policy choice.
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/channels/${channelId}/join-requests`,
          headers: { cookie: user.cookie },
        })
      ).statusCode,
    ).toBe(201);
  });

  it("blocks edits of DMs and replies after their feature is switched off — deletes stay for cleanup", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "dm", recipientUserId: bob.userId, body: "sent while DMs were on" },
    });
    expect(dm.statusCode).toBe(201);
    const dmId = (dm.json() as { message: { id: string } }).message.id;

    const parentId = await postIn(app, alice.cookie, "general", "thread root");
    const reply = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "channelReply", channelId: "general", parentMessageId: parentId, body: "replied while on" },
    });
    expect(reply.statusCode).toBe(201);
    const replyId = (reply.json() as { message: { id: string } }).message.id;

    const flip = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { features: { enableDMs: false, enableReplies: false } },
    });
    expect(flip.statusCode).toBe(200);

    // A runtime shutdown must stop fresh content broadcasting through PATCH on old messages...
    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: `/api/messages/${dmId}`,
          headers: { cookie: alice.cookie },
          payload: { body: "fresh DM content after shutdown" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: `/api/messages/${replyId}`,
          headers: { cookie: alice.cookie },
          payload: { body: "fresh reply content after shutdown" },
        })
      ).statusCode,
    ).toBe(403);

    // ...while deleting the feature's leftovers remains available (cleanup, not use).
    expect(
      (await app.server.inject({ method: "DELETE", url: `/api/messages/${dmId}`, headers: { cookie: alice.cookie } }))
        .statusCode,
    ).toBe(200);
  });

  it("blocks a timed-out user from channel creation, metadata edits, and roster growth — but not shrinking", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const user = await newSession(app);
    const member = await newSession(app);

    // Pre-timeout: the user owns a private channel with one member.
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: user.cookie },
      payload: { name: "Owned Room", visibility: "private" },
    });
    expect(created.statusCode).toBe(201);
    const channelId = (created.json() as { id: string }).id;
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/channels/${channelId}/members`,
          headers: { cookie: user.cookie },
          payload: { userId: member.userId },
        })
      ).statusCode,
    ).toBe(200);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${user.userId}`,
      headers: { cookie: admin.cookie },
      payload: { timeoutUntil: Date.now() + 60_000 },
    });

    // The write block covers every publishing/coordination surface channels offer...
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/channels",
          headers: { cookie: user.cookie },
          payload: { name: "Fresh Soapbox" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: `/api/channels/${channelId}`,
          headers: { cookie: user.cookie },
          payload: { description: "coordinating through metadata" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/channels/${channelId}/members`,
          headers: { cookie: user.cookie },
          payload: { userId: admin.userId },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/channels/${channelId}/transfer`,
          headers: { cookie: user.cookie },
          payload: { userId: member.userId },
        })
      ).statusCode,
    ).toBe(403);

    // ...but access-REDUCING actions stay available: the timed-out owner may still remove a member.
    expect(
      (
        await app.server.inject({
          method: "DELETE",
          url: `/api/channels/${channelId}/members/${member.userId}`,
          headers: { cookie: user.cookie },
        })
      ).statusCode,
    ).toBe(200);
  });
});
