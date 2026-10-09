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
  reopenApp,
  teardownApps,
} from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("channels API", () => {
  type ChannelBody = {
    id: string;
    name: string;
    description?: string;
    ownerUserId?: string;
    visibility: string;
    allowPosting: string;
    allowReplies: boolean;
    discoverable: boolean;
    archived?: boolean;
  };

  async function listChannels(app: LoamApp, cookie: string): Promise<ChannelBody[]> {
    const response = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie },
    });
    return response.json() as ChannelBody[];
  }

  function createChannel(app: LoamApp, cookie: string, payload: object): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie },
      payload,
    });
  }

  function updateChannel(
    app: LoamApp,
    cookie: string,
    channelId: string,
    payload: object,
  ): Promise<InjectResponse> {
    return app.server.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers: { cookie },
      payload,
    });
  }

  it("restricts the full (archived-inclusive) channel list to admins", async () => {
    const app = await makeApp({ admin: { bootstrap: "none" } });
    const session = await newSession(app);
    expect(session.isAdmin).toBe(false);

    const list = await app.server.inject({
      method: "GET",
      url: "/api/admin/channels",
      headers: { cookie: session.cookie },
    });
    expect(list.statusCode).toBe(403);
  });

  it("lets a user create a channel when enableUserChannels is on, and blocks it when off", async () => {
    // Default config has enableUserChannels: true.
    const open = await makeApp();
    await newSession(open); // burn the firstUser=admin slot
    const user = await newSession(open);
    expect(user.isAdmin).toBe(false);

    const created = await createChannel(open, user.cookie, { name: "User Room" });
    expect(created.statusCode).toBe(201);
    expect((created.json() as ChannelBody).ownerUserId).toBe(user.userId);

    const locked = await makeApp({ features: { enableUserChannels: false } });
    const admin = await newSession(locked);
    const lockedUser = await newSession(locked);
    expect((await createChannel(locked, lockedUser.cookie, { name: "Nope" })).statusCode).toBe(403);
    // An admin can still create even when user channels are disabled.
    expect((await createChannel(locked, admin.cookie, { name: "Admin Room" })).statusCode).toBe(201);
  });

  it("lets the channel owner update it but blocks a non-owner non-admin", async () => {
    const app = await makeApp();
    await newSession(app); // burn the admin slot
    const owner = await newSession(app);
    const stranger = await newSession(app);
    const channel = (await createChannel(app, owner.cookie, { name: "Owned" })).json() as ChannelBody;
    expect(channel.ownerUserId).toBe(owner.userId);

    const renamed = await updateChannel(app, owner.cookie, channel.id, { name: "Owned Plus" });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as ChannelBody).name).toBe("Owned Plus");

    expect((await updateChannel(app, stranger.cookie, channel.id, { name: "Hijack" })).statusCode).toBe(403);
  });

  it("keeps archived channels in both the public and admin lists (read-only-but-available)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const created = (await createChannel(app, admin.cookie, { name: "Hidden" })).json() as ChannelBody;
    await updateChannel(app, admin.cookie, created.id, { archived: true });

    // Archive means read-only, not invisible: the public list still returns it (flagged), so
    // clients can render it read-only; the admin list keeps it restorable.
    const listed = (await listChannels(app, admin.cookie)).find((entry) => entry.id === created.id);
    expect(listed?.archived).toBe(true);

    const adminList = await app.server.inject({
      method: "GET",
      url: "/api/admin/channels",
      headers: { cookie: admin.cookie },
    });
    expect(adminList.statusCode).toBe(200);
    const entries = adminList.json() as ChannelBody[];
    const hidden = entries.find((entry) => entry.id === created.id);
    expect(hidden?.archived).toBe(true);
  });

  it("creates a public channel, owns it, and lists it", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    expect(admin.isAdmin).toBe(true);

    const create = await createChannel(app, admin.cookie, {
      name: "Logistics Team",
      description: "Supply coordination",
      allowPosting: "admins",
      allowReplies: false,
    });
    expect(create.statusCode).toBe(201);

    const channel = create.json() as ChannelBody;
    expect(channel.id).toBe("logistics-team");
    expect(channel.name).toBe("Logistics Team");
    expect(channel.visibility).toBe("public");
    expect(channel.discoverable).toBe(true);
    expect(channel.allowPosting).toBe("admins");
    expect(channel.allowReplies).toBe(false);
    expect(channel.ownerUserId).toBe(admin.userId);

    const channels = await listChannels(app, admin.cookie);
    expect(channels.some((entry) => entry.id === "logistics-team")).toBe(true);
  });

  it("rejects an empty channel name", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const create = await createChannel(app, admin.cookie, { name: "   " });
    expect(create.statusCode).toBe(400);
  });

  it("gives duplicate names distinct, non-colliding ids", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const first = (await createChannel(app, admin.cookie, { name: "Alerts" })).json() as ChannelBody;
    const second = (await createChannel(app, admin.cookie, { name: "Alerts" })).json() as ChannelBody;

    expect(first.id).toBe("alerts");
    expect(second.id).not.toBe(first.id);
    expect(second.id.startsWith("alerts-")).toBe(true);
  });

  it("falls back to a generated id when the name has no slug characters", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const channel = (await createChannel(app, admin.cookie, { name: "🔥🔥" })).json() as ChannelBody;
    expect(channel.id.startsWith("channel-")).toBe(true);
    expect(channel.name).toBe("🔥🔥");
  });

  it("renames a channel and archives it out of the public list, then restores it", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const created = (await createChannel(app, admin.cookie, { name: "Temp" })).json() as ChannelBody;

    const renamed = await updateChannel(app, admin.cookie, created.id, { name: "Renamed" });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as ChannelBody).name).toBe("Renamed");

    // Archiving keeps the channel listed (read-only) — the flag flips, the channel never vanishes.
    const archived = await updateChannel(app, admin.cookie, created.id, { archived: true });
    expect(archived.statusCode).toBe(200);
    expect((await listChannels(app, admin.cookie)).find((entry) => entry.id === created.id)?.archived).toBe(true);

    const restored = await updateChannel(app, admin.cookie, created.id, { archived: false });
    expect(restored.statusCode).toBe(200);
    expect((await listChannels(app, admin.cookie)).find((entry) => entry.id === created.id)?.archived).toBe(false);
  });

  it("returns 404 when updating a channel that does not exist", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const update = await updateChannel(app, admin.cookie, "does-not-exist", { name: "Nope" });
    expect(update.statusCode).toBe(404);
  });

  it("persists created channels across a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    // reopenApp closes this instance itself and registers the reopened one for teardown. The
    // try/finally closes the initial instance only if an assertion throws before reopen — so it
    // never leaks a handle, and is never double-closed on the happy path.
    let app: LoamApp = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
    let reopened = false;

    try {
      const admin = await newSession(app);
      // A multi-word name yields a hyphenated slug id; confirm that survives reload + ChannelSchema.parse.
      const created = (await createChannel(app, admin.cookie, { name: "Durable Channel" })).json() as ChannelBody;
      expect(created.id).toBe("durable-channel");

      app = await reopenApp(app, dataDir);
      reopened = true;
      expect(app.store.loadChannels().some((entry) => entry.id === created.id)).toBe(true);
    } finally {
      if (!reopened) {
        await app.close();
      }
    }
  });
});

describe("private channels", () => {
  type PrivateChannelBody = {
    id: string;
    visibility: string;
    discoverable: boolean;
    ownerUserId?: string;
    memberUserIds?: string[];
  };

  async function createPrivateChannel(
    app: LoamApp,
    cookie: string,
    name = "Secret Ops",
  ): Promise<PrivateChannelBody> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie },
      payload: { name, visibility: "private" },
    });

    if (response.statusCode !== 201) {
      throw new Error(`Private channel creation failed: ${response.statusCode}`);
    }

    return response.json() as PrivateChannelBody;
  }

  function addMember(app: LoamApp, cookie: string, channelId: string, userId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: `/api/channels/${channelId}/members`,
      headers: { cookie },
      payload: { userId },
    });
  }

  function removeMember(app: LoamApp, cookie: string, channelId: string, userId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "DELETE",
      url: `/api/channels/${channelId}/members/${userId}`,
      headers: { cookie },
    });
  }

  async function channelIdsFor(app: LoamApp, cookie: string): Promise<string[]> {
    const response = await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie } });
    return (response.json() as { id: string }[]).map((entry) => entry.id);
  }

  function readMessages(app: LoamApp, cookie: string, channelId: string): Promise<InjectResponse> {
    return app.server.inject({ method: "GET", url: `/api/messages/${channelId}`, headers: { cookie } });
  }

  it("a private channel never takes the bare slug of its name, so a later creator can't learn it exists", async () => {
    const app = await makeApp();
    const alice = await newSession(app);
    const bob = await newSession(app);

    const first = await createPrivateChannel(app, alice.cookie, "Secret");
    const second = await createPrivateChannel(app, bob.cookie, "Secret");
    expect(first.id).toMatch(/^secret-[0-9a-f]{6}$/);
    expect(second.id).toMatch(/^secret-[0-9a-f]{6}$/);
    expect(first.id).not.toBe(second.id);

    // A public channel keeps its clean slug, and the hidden ones left no trace in it.
    const open = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: bob.cookie },
      payload: { name: "Secret" },
    });
    expect(open.statusCode).toBe(201);
    expect((open.json() as { id: string }).id).toBe("secret");
  });

  function post(app: LoamApp, cookie: string, channelId: string, body: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId, body },
    });
  }

  it("creates a private channel with the creator as the only member", async () => {
    const app = await makeApp();
    await newSession(app); // burn the firstUser=admin slot
    const owner = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    expect(channel.visibility).toBe("private");
    expect(channel.discoverable).toBe(false);
    expect(channel.ownerUserId).toBe(owner.userId);
    expect(channel.memberUserIds).toEqual([owner.userId]);
  });

  it("rejects private channel creation when enablePrivateChannels is off", async () => {
    const app = await makeApp({ features: { enablePrivateChannels: false } });
    const admin = await newSession(app);

    const response = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
      payload: { name: "Nope", visibility: "private" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("hides a private channel from everyone but its members", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);

    expect(await channelIdsFor(app, owner.cookie)).toContain(channel.id);
    expect(await channelIdsFor(app, outsider.cookie)).not.toContain(channel.id);
    // Even node admins get no implicit membership in the public list...
    expect(await channelIdsFor(app, admin.cookie)).not.toContain(channel.id);

    // ...but the admin management list still shows it (archive/rename without reading).
    const adminList = await app.server.inject({
      method: "GET",
      url: "/api/admin/channels",
      headers: { cookie: admin.cookie },
    });
    expect((adminList.json() as { id: string }[]).some((entry) => entry.id === channel.id)).toBe(true);
  });

  it("answers 404 for message reads by outsiders and for unknown channels alike", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    expect((await post(app, owner.cookie, channel.id, "member post")).statusCode).toBe(201);

    const asOwner = await readMessages(app, owner.cookie, channel.id);
    expect(asOwner.statusCode).toBe(200);
    expect((asOwner.json() as unknown[]).length).toBe(1);

    // Outsider, admin (no implicit read), and a genuinely-missing channel are indistinguishable.
    expect((await readMessages(app, outsider.cookie, channel.id)).statusCode).toBe(404);
    expect((await readMessages(app, admin.cookie, channel.id)).statusCode).toBe(404);
    expect((await readMessages(app, outsider.cookie, "does-not-exist")).statusCode).toBe(404);
  });

  it("blocks outsiders from posting and reacting without leaking channel existence", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    const posted = await post(app, owner.cookie, channel.id, "hello members");
    const messageId = (posted.json() as { message: { id: string } }).message.id;

    const blockedPost = await post(app, outsider.cookie, channel.id, "let me in");
    expect(blockedPost.statusCode).toBe(400);
    expect((blockedPost.json() as { error: string }).error).toBe("Channel does not exist");

    const blockedReaction = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: outsider.cookie },
      payload: { type: "reaction", targetMessageId: messageId, reaction: "👍" },
    });
    expect(blockedReaction.statusCode).toBe(400);
  });

  it("lets the owner invite and remove members, who gain and lose access", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const invitee = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    expect((await post(app, owner.cookie, channel.id, "founding note")).statusCode).toBe(201);

    const added = await addMember(app, owner.cookie, channel.id, invitee.userId);
    expect(added.statusCode).toBe(200);
    expect((added.json() as PrivateChannelBody).memberUserIds).toContain(invitee.userId);

    expect(await channelIdsFor(app, invitee.cookie)).toContain(channel.id);
    expect((await readMessages(app, invitee.cookie, channel.id)).statusCode).toBe(200);
    expect((await post(app, invitee.cookie, channel.id, "thanks for the invite")).statusCode).toBe(201);

    const removed = await removeMember(app, owner.cookie, channel.id, invitee.userId);
    expect(removed.statusCode).toBe(200);
    expect(await channelIdsFor(app, invitee.cookie)).not.toContain(channel.id);
    expect((await readMessages(app, invitee.cookie, channel.id)).statusCode).toBe(404);
  });

  it("lets a member leave, keeps the owner in place, and gates invites to owner/admin", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const member = await newSession(app);
    const other = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    await addMember(app, owner.cookie, channel.id, member.userId);

    // A plain member cannot invite others...
    expect((await addMember(app, member.cookie, channel.id, other.userId)).statusCode).toBe(403);
    // ...or remove anyone else (the permission gate answers before owner-protection).
    expect((await removeMember(app, member.cookie, channel.id, owner.userId)).statusCode).toBe(403);

    // An admin may manage membership without being a member.
    expect((await addMember(app, admin.cookie, channel.id, other.userId)).statusCode).toBe(200);

    // A member may leave (remove themselves).
    expect((await removeMember(app, member.cookie, channel.id, member.userId)).statusCode).toBe(200);
    expect(await channelIdsFor(app, member.cookie)).not.toContain(channel.id);

    // The owner can never be removed — not even by themselves or an admin.
    expect((await removeMember(app, owner.cookie, channel.id, owner.userId)).statusCode).toBe(400);
    expect((await removeMember(app, admin.cookie, channel.id, owner.userId)).statusCode).toBe(400);
  });

  it("hides the member roster from outsiders and rejects it for public channels", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);

    const asOwner = await app.server.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/members`,
      headers: { cookie: owner.cookie },
    });
    expect(asOwner.statusCode).toBe(200);
    expect((asOwner.json() as { id: string }[]).map((user) => user.id)).toEqual([owner.userId]);

    const asOutsider = await app.server.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/members`,
      headers: { cookie: outsider.cookie },
    });
    expect(asOutsider.statusCode).toBe(404);

    const publicRoster = await app.server.inject({
      method: "GET",
      url: "/api/channels/general/members",
      headers: { cookie: owner.cookie },
    });
    expect(publicRoster.statusCode).toBe(400);
  });

  it("persists private channels and their members across a restart", async () => {
    const { app, dataDir } = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const member = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    await addMember(app, owner.cookie, channel.id, member.userId);

    const next = await reopenApp(app, dataDir);
    const stored = next.store.loadChannels().find((entry) => entry.id === channel.id);
    expect(stored?.visibility).toBe("private");
    expect(stored?.memberUserIds).toEqual([owner.userId, member.userId]);

    expect((await readMessages(next, member.cookie, channel.id)).statusCode).toBe(200);
  });

  function transfer(app: LoamApp, cookie: string, channelId: string, userId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: `/api/channels/${channelId}/transfer`,
      headers: { cookie },
      payload: { userId },
    });
  }

  it("transfers ownership, adding the new owner to the roster and keeping the old owner a member", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const heir = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    const response = await transfer(app, owner.cookie, channel.id, heir.userId);
    expect(response.statusCode).toBe(200);

    const body = response.json() as PrivateChannelBody;
    expect(body.ownerUserId).toBe(heir.userId);
    // New owner joined the roster; the previous owner stays a member.
    expect(body.memberUserIds).toEqual([owner.userId, heir.userId]);

    // The new owner can now manage members; the old owner no longer can.
    expect((await addMember(app, heir.cookie, channel.id, owner.userId)).statusCode).toBe(200);
    const oldOwnerInvites = await addMember(app, owner.cookie, channel.id, (await newSession(app)).userId);
    expect(oldOwnerInvites.statusCode).toBe(403);
  });

  it("lets a node admin transfer ownership but forbids a non-owner member", async () => {
    const app = await makeApp();
    const admin = await newSession(app); // firstUser → admin
    const owner = await newSession(app);
    const member = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    await addMember(app, owner.cookie, channel.id, member.userId);

    // A plain member cannot transfer.
    expect((await transfer(app, member.cookie, channel.id, member.userId)).statusCode).toBe(403);
    // An admin can, even without being a member.
    const asAdmin = await transfer(app, admin.cookie, channel.id, member.userId);
    expect(asAdmin.statusCode).toBe(200);
    expect((asAdmin.json() as PrivateChannelBody).ownerUserId).toBe(member.userId);
  });

  it("404s a transfer on a channel the caller can't see and rejects a banned target", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);

    // An outsider can't even tell the channel exists.
    expect((await transfer(app, outsider.cookie, channel.id, owner.userId)).statusCode).toBe(404);

    // Ban the outsider, then try to hand them the channel — rejected.
    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${outsider.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });
    expect((await transfer(app, owner.cookie, channel.id, outsider.userId)).statusCode).toBe(400);
  });

  it("keeps the previous owner in the roster when transferring to an existing member", async () => {
    const app = await makeApp();
    await newSession(app);
    const owner = await newSession(app);
    const member = await newSession(app);

    const channel = await createPrivateChannel(app, owner.cookie);
    await addMember(app, owner.cookie, channel.id, member.userId);

    // Transfer to someone who was already a member — the old owner must remain an explicit member,
    // not silently drop out once they stop being the (implicit) owner.
    const body = (await transfer(app, owner.cookie, channel.id, member.userId)).json() as PrivateChannelBody;
    expect(body.ownerUserId).toBe(member.userId);
    expect(new Set(body.memberUserIds)).toEqual(new Set([owner.userId, member.userId]));
  });

  it("leaves banned and still-pending members off the member list, like the roster", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const member = await newSession(app);
    const channel = await createPrivateChannel(app, owner.cookie);
    expect((await addMember(app, owner.cookie, channel.id, member.userId)).statusCode).toBe(200);

    const list = async (): Promise<string[]> =>
      (
        (await app.server.inject({ method: "GET", url: `/api/channels/${channel.id}/members`, headers: { cookie: owner.cookie } })).json() as {
          id: string;
        }[]
      ).map((user) => user.id);
    expect(await list()).toEqual(expect.arrayContaining([owner.userId, member.userId]));

    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: `/api/moderation/users/${member.userId}`,
          headers: { cookie: admin.cookie },
          payload: { banned: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(await list()).toContain(owner.userId);
    expect(await list()).not.toContain(member.userId);
  });
});

describe("private channel PATCH parity", () => {
  function patchChannel(app: LoamApp, cookie: string, channelId: string, payload: Record<string, unknown>): Promise<InjectResponse> {
    return app.server.inject({ method: "PATCH", url: `/api/channels/${channelId}`, headers: { cookie }, payload });
  }

  it("answers a non-member's PATCH on a private channel exactly like a missing channel (404 parity)", async () => {
    const app = await makeApp();
    await newSession(app); // firstUser admin
    const owner = await newSession(app);
    const outsider = await newSession(app);
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Leadership", visibility: "private" },
    });
    expect(created.statusCode).toBe(201);
    const channelId = (created.json() as { id: string }).id;

    const missing = await patchChannel(app, outsider.cookie, "no-such-channel", { name: "Renamed" });
    const hidden = await patchChannel(app, outsider.cookie, channelId, { name: "Renamed" });
    expect(missing.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);

    // The owner (and an admin) can still change it — only outsiders get parity.
    expect((await patchChannel(app, owner.cookie, channelId, { name: "Renamed" })).statusCode).toBe(200);
  });
});

describe("private channel join requests", () => {
  it("gates requests behind opt-in, then owner-approves a requester into the roster", async () => {
    const app = await makeApp();
    const owner = await newSession(app);
    const outsider = await newSession(app);

    const channelId = ((await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Ops", visibility: "private" },
    })).json() as { id: string }).id;

    const requestJoin = (cookie: string) =>
      app.server.inject({ method: "POST", url: `/api/channels/${channelId}/join-requests`, headers: { cookie } });

    // Not opted in yet → 404-parity (never reveals the channel exists).
    expect((await requestJoin(outsider.cookie)).statusCode).toBe(404);

    // Owner opts the channel into join requests.
    expect(
      (await app.server.inject({
        method: "PATCH",
        url: `/api/channels/${channelId}`,
        headers: { cookie: owner.cookie },
        payload: { allowJoinRequests: true },
      })).statusCode,
    ).toBe(200);

    // Now the outsider can request; the outsider still can't read the channel yet.
    expect((await requestJoin(outsider.cookie)).statusCode).toBe(201);
    expect(
      (await app.server.inject({ method: "GET", url: `/api/messages/${channelId}`, headers: { cookie: outsider.cookie } }))
        .statusCode,
    ).toBe(404);

    // The owner sees the pending request; a non-owner/admin can't review it.
    const queue = (
      await app.server.inject({ method: "GET", url: `/api/channels/${channelId}/join-requests`, headers: { cookie: owner.cookie } })
    ).json() as { id: string }[];
    expect(queue.map((u) => u.id)).toContain(outsider.userId);
    // A non-member requester can't review the queue — the private channel 404s for them (never 403, which
    // would confirm existence). Only a member-who-isn't-owner would get 403.
    expect(
      (await app.server.inject({ method: "GET", url: `/api/channels/${channelId}/join-requests`, headers: { cookie: outsider.cookie } }))
        .statusCode,
    ).toBe(404);

    // Approve → the requester joins and can now read the channel; the request clears.
    expect(
      (await app.server.inject({
        method: "POST",
        url: `/api/channels/${channelId}/join-requests/${outsider.userId}/approve`,
        headers: { cookie: owner.cookie },
      })).statusCode,
    ).toBe(200);
    expect(
      (await app.server.inject({ method: "GET", url: `/api/messages/${channelId}`, headers: { cookie: outsider.cookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        (await app.server.inject({ method: "GET", url: `/api/channels/${channelId}/join-requests`, headers: { cookie: owner.cookie } }))
          .json() as unknown[]
      ).length,
    ).toBe(0);
  });
});
