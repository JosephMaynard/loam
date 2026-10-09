import { afterEach, describe, expect, it } from "vitest";

import { REPORTED_MESSAGE_BODY_MAX_LENGTH, ReportedMessageSchema } from "@loam/schema";

import type { LoamApp } from "./app.js";
import { OPEN_REPORTS_PER_REPORTER_MAX, reportedMessageBody } from "./routes-users.js";
import { type InjectResponse, makeApp, newSession, sessionCookie, teardownApps } from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("roles, moderation, and join policy", () => {
  function postChannel(app: LoamApp, cookie: string, body: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId: "general", body },
    });
  }

  function setRoles(app: LoamApp, cookie: string, userId: string, roles: string[]): Promise<InjectResponse> {
    return app.server.inject({
      method: "PATCH",
      url: `/api/admin/users/${userId}/roles`,
      headers: { cookie },
      payload: { roles },
    });
  }

  function moderate(
    app: LoamApp,
    cookie: string,
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<InjectResponse> {
    return app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${userId}`,
      headers: { cookie },
      payload,
    });
  }

  function approve(app: LoamApp, cookie: string, userId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: `/api/access/users/${userId}/approve`,
      headers: { cookie },
    });
  }

  function deny(app: LoamApp, cookie: string, userId: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: `/api/access/users/${userId}/deny`,
      headers: { cookie },
    });
  }

  /** Open a fresh session and return the cookie together with the full currentUser (incl. pending). */
  async function fullSession(
    app: LoamApp,
  ): Promise<{ cookie: string; user: { id: string; isAdmin: boolean; pending?: boolean } }> {
    const response = await app.server.inject({ method: "GET", url: "/api/config" });
    return {
      cookie: sessionCookie(response),
      user: (
        response.json() as { currentUser: { id: string; isAdmin: boolean; pending?: boolean } }
      ).currentUser,
    };
  }

  describe("roles", () => {
    it("counts a repeated role once, refuses more roles than exist, and treats the assistant bot like an unknown user", async () => {
      const app = await makeApp({
        llm: { ollama: { enabled: true, baseUrl: "http://localhost:11434", model: "m", botId: "llm.bot.test", botDisplayName: "Bot" } },
      });
      const admin = await newSession(app);
      const member = await newSession(app);

      const repeated = await setRoles(app, admin.cookie, member.userId, ["moderator", "moderator"]);
      expect(repeated.statusCode).toBe(200);
      expect((repeated.json() as { roles?: string[] }).roles).toEqual(["moderator"]);

      expect((await setRoles(app, admin.cookie, member.userId, ["moderator", "greeter", "moderator"])).statusCode).toBe(400);

      // Roles and moderation are for people: the bot answers like an unknown user on both routes.
      const botRoles = await setRoles(app, admin.cookie, "llm.bot.test", ["moderator"]);
      expect(botRoles.statusCode).toBe(404);
      expect(botRoles.json()).toMatchObject({ code: "user_not_found" });
      const botBan = await moderate(app, admin.cookie, "llm.bot.test", { banned: true });
      expect(botBan.statusCode).toBe(404);
      expect(botBan.json()).toMatchObject({ code: "user_not_found" });
      expect(app.store.loadUsers().find((user) => user.id === "llm.bot.test")).toMatchObject({ type: "bot" });
      expect(app.store.loadUsers().find((user) => user.id === "llm.bot.test")?.banned).toBeUndefined();
    });

    it("lets an admin set a member's roles", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);

      const granted = await setRoles(app, admin.cookie, member.userId, ["moderator", "greeter"]);
      expect(granted.statusCode).toBe(200);
      expect((granted.json() as { roles: string[] }).roles).toEqual(["moderator", "greeter"]);
    });

    it("does not leak a member's roles to ordinary joiners, but shows them to self and moderators", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const mod = await newSession(app);
      const stranger = await newSession(app);

      expect((await setRoles(app, admin.cookie, mod.userId, ["moderator"])).statusCode).toBe(200);

      const rosterFor = async (cookie: string) =>
        (await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie } })).json() as {
          id: string;
          roles?: string[];
        }[];

      // A stranger still sees the moderator in the roster, but their roles are stripped (can't
      // enumerate who holds authority).
      const strangerRoster = await rosterFor(stranger.cookie);
      expect(strangerRoster.find((entry) => entry.id === mod.userId)).toBeDefined();
      expect(strangerRoster.find((entry) => entry.id === mod.userId)?.roles).toBeUndefined();

      // A moderator sees roles across the whole roster...
      const modRoster = await rosterFor(mod.cookie);
      expect(modRoster.find((entry) => entry.id === mod.userId)?.roles).toEqual(["moderator"]);

      // ...and sees their OWN roles via /api/config, so the client can gate its moderation UI.
      const modConfig = (
        await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: mod.cookie } })
      ).json() as { currentUser: { roles?: string[] } };
      expect(modConfig.currentUser.roles).toEqual(["moderator"]);
    });

    it("does not leak roles/shadowBan via the private-channel member list to a non-moderator member", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const alice = await newSession(app);
      const mod = await newSession(app);

      const channelId = (
        (
          await app.server.inject({
            method: "POST",
            url: "/api/channels",
            headers: { cookie: admin.cookie },
            payload: { name: "ops", visibility: "private" },
          })
        ).json() as { id: string }
      ).id;
      for (const member of [alice, mod]) {
        expect(
          (
            await app.server.inject({
              method: "POST",
              url: `/api/channels/${channelId}/members`,
              headers: { cookie: admin.cookie },
              payload: { userId: member.userId },
            })
          ).statusCode,
        ).toBe(200);
      }
      expect((await setRoles(app, admin.cookie, mod.userId, ["moderator"])).statusCode).toBe(200);
      expect((await moderate(app, admin.cookie, mod.userId, { shadowBanned: true })).statusCode).toBe(200);

      const membersFor = async (cookie: string) =>
        (await app.server.inject({ method: "GET", url: `/api/channels/${channelId}/members`, headers: { cookie } }))
          .json() as { id: string; roles?: string[]; shadowBanned?: boolean }[];

      // Alice is an ordinary member — she must not learn the moderator's roles or shadow-ban state.
      const asAlice = (await membersFor(alice.cookie)).find((entry) => entry.id === mod.userId);
      expect(asAlice).toBeDefined();
      expect(asAlice?.roles).toBeUndefined();
      expect(asAlice?.shadowBanned).toBeUndefined();

      // The admin (a moderator) still sees roles (but never shadowBanned, which is moderation-endpoint only).
      const asAdmin = (await membersFor(admin.cookie)).find((entry) => entry.id === mod.userId);
      expect(asAdmin?.roles).toEqual(["moderator"]);
      expect(asAdmin?.shadowBanned).toBeUndefined();
    });

    it("rejects role changes from a non-admin", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);
      const other = await newSession(app);

      expect((await setRoles(app, other.cookie, member.userId, ["moderator"])).statusCode).toBe(403);
      // Sanity: the admin can, so it is genuinely a permission gate.
      expect((await setRoles(app, admin.cookie, member.userId, ["moderator"])).statusCode).toBe(200);
    });

    it("refuses to change an admin's roles and 404s an unknown user", async () => {
      const app = await makeApp();
      const admin = await newSession(app);

      expect((await setRoles(app, admin.cookie, admin.userId, ["moderator"])).statusCode).toBe(400);
      expect((await setRoles(app, admin.cookie, "user.does-not-exist", ["moderator"])).statusCode).toBe(404);
    });

    it("rejects an invalid roles body", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);

      const bad = await app.server.inject({
        method: "PATCH",
        url: `/api/admin/users/${member.userId}/roles`,
        headers: { cookie: admin.cookie },
        payload: { roles: ["overlord"] },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe("moderation", () => {
    it("lets a moderator ban a member: enforcement holds and sessions are invalidated", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const mod = await newSession(app);
      const member = await newSession(app);

      // Grant a genuine (non-admin) moderator role so we exercise canModerate via role, not isAdmin.
      expect((await setRoles(app, admin.cookie, mod.userId, ["moderator"])).statusCode).toBe(200);

      // The member can post before the ban.
      expect((await postChannel(app, member.cookie, "before the ban")).statusCode).toBe(201);

      const ban = await moderate(app, mod.cookie, member.userId, { banned: true });
      expect(ban.statusCode).toBe(200);
      expect((ban.json() as { banned: boolean }).banned).toBe(true);

      // Their next post is forbidden, and their session is gone from the store.
      const after = await postChannel(app, member.cookie, "after the ban");
      expect(after.statusCode).toBe(403);
      expect(app.store.loadSessions().some((session) => session.userId === member.userId)).toBe(false);

      // A banned user is no longer a visible participant.
      const roster = (
        await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: admin.cookie } })
      ).json() as { id: string }[];
      expect(roster.some((user) => user.id === member.userId)).toBe(false);
    });

    it("refuses to ban an admin or oneself", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const mod = await newSession(app);
      await setRoles(app, admin.cookie, mod.userId, ["moderator"]);

      expect((await moderate(app, mod.cookie, admin.userId, { banned: true })).statusCode).toBe(403);
      expect((await moderate(app, mod.cookie, mod.userId, { banned: true })).statusCode).toBe(403);
      expect((await moderate(app, admin.cookie, admin.userId, { banned: true })).statusCode).toBe(403);
    });

    it("requires moderator (or admin) rights and a non-empty body", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);

      expect((await moderate(app, member.cookie, admin.userId, { banned: true })).statusCode).toBe(403);
      // Empty moderation body (neither banned nor shadowBanned) is a bad request.
      expect((await moderate(app, admin.cookie, member.userId, {})).statusCode).toBe(400);
      expect((await moderate(app, admin.cookie, "user.nope", { banned: true })).statusCode).toBe(404);
    });

    it("shadow-ban lets the author keep posting while withholding the message from others", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);

      const shadow = await moderate(app, admin.cookie, member.userId, { shadowBanned: true });
      expect(shadow.statusCode).toBe(200);
      expect((shadow.json() as { shadowBanned: boolean }).shadowBanned).toBe(true);

      // The author is allowed through: the message is created and persisted (returned to them).
      const post = await postChannel(app, member.cookie, "am I shouting into the void?");
      expect(post.statusCode).toBe(201);
      const messageId = (post.json() as { message: { id: string } }).message.id;
      expect(app.store.loadMessages().some((message) => message.id === messageId)).toBe(true);

      // A shadow-banned user stays a visible participant — only their messages are withheld. But the
      // `shadowBanned` flag is stripped from the general roster (even for an admin — they read it via
      // the gated moderation endpoint), so no one can enumerate who is shadow-banned.
      const roster = (
        await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: admin.cookie } })
      ).json() as { id: string; shadowBanned?: boolean }[];
      const listed = roster.find((user) => user.id === member.userId);
      expect(listed).toBeDefined();
      expect(listed?.shadowBanned).toBeUndefined();

      // The target must NOT learn their own shadow-ban (that would defeat the "shadow") — their own
      // /api/config currentUser carries no flag.
      const selfConfig = (
        await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: member.cookie } })
      ).json() as { currentUser: { shadowBanned?: boolean } };
      expect(selfConfig.currentUser.shadowBanned).toBeUndefined();

      // Moderators still see it via the gated endpoint.
      const modRoster = (
        await app.server.inject({ method: "GET", url: "/api/moderation/users", headers: { cookie: admin.cookie } })
      ).json() as { id: string; shadowBanned?: boolean }[];
      expect(modRoster.find((user) => user.id === member.userId)?.shadowBanned).toBe(true);

      // Un-shadow-ban clears the flag.
      const restore = await moderate(app, admin.cookie, member.userId, { shadowBanned: false });
      expect((restore.json() as { shadowBanned?: boolean }).shadowBanned).toBe(false);
    });

    it("withholds a shadow-banned author's messages from REST reads, but not from the author", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const spammer = await newSession(app);
      const viewer = await newSession(app);

      await moderate(app, admin.cookie, spammer.userId, { shadowBanned: true });
      expect((await postChannel(app, spammer.cookie, "buy my thing")).statusCode).toBe(201);

      const read = async (cookie: string): Promise<string[]> =>
        (
          (
            await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie } })
          ).json() as { body?: string }[]
        ).map((message) => message.body ?? "");

      // The author still sees their own post (shadow ban is invisible to them)...
      expect(await read(spammer.cookie)).toContain("buy my thing");
      // ...but nobody else does — not even an admin — via the REST path the client refetches on every
      // channel open and reconnect. Without the fix the WS-level concealment would be cosmetic.
      expect(await read(viewer.cookie)).not.toContain("buy my thing");
      expect(await read(admin.cookie)).not.toContain("buy my thing");
    });

    it("drops orphan reactions that target a shadow-banned author's now-hidden message", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const spammer = await newSession(app);
      const viewer = await newSession(app);

      // Spammer posts and the viewer reacts — both visible while nobody is shadow-banned.
      const post = await postChannel(app, spammer.cookie, "root by spammer");
      const rootId = (post.json() as { message: { id: string } }).message.id;
      expect(
        (
          await app.server.inject({
            method: "POST",
            url: "/api/messages",
            headers: { cookie: viewer.cookie },
            payload: { type: "reaction", targetMessageId: rootId, reaction: "👍" },
          })
        ).statusCode,
      ).toBe(201);

      // Shadow-ban the spammer. The viewer's read must contain neither the hidden root nor their own
      // reaction to it — a surviving reaction would leak that the root exists.
      await moderate(app, admin.cookie, spammer.userId, { shadowBanned: true });
      const seen = (
        await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: viewer.cookie } })
      ).json() as { id: string; type: string; targetMessageId?: string }[];
      expect(seen.some((message) => message.id === rootId)).toBe(false);
      expect(seen.some((message) => message.type === "reaction" && message.targetMessageId === rootId)).toBe(false);
    });

    it("exposes the full human roster (incl. banned) to moderators only", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);
      await moderate(app, admin.cookie, member.userId, { banned: true });

      const list = await app.server.inject({
        method: "GET",
        url: "/api/moderation/users",
        headers: { cookie: admin.cookie },
      });
      expect(list.statusCode).toBe(200);
      const users = list.json() as { id: string; banned?: boolean }[];
      expect(users.find((user) => user.id === member.userId)?.banned).toBe(true);

      // A plain member cannot read the moderation roster.
      const other = await newSession(app);
      expect(
        (
          await app.server.inject({
            method: "GET",
            url: "/api/moderation/users",
            headers: { cookie: other.cookie },
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  describe("join policy (approval)", () => {
    it("marks fresh non-admin sessions pending and blocks their posts until approved", async () => {
      const app = await makeApp({ access: { joinPolicy: "approval" } });

      // firstUser bootstrap: the first session becomes admin and is never pending.
      const admin = await fullSession(app);
      expect(admin.user.isAdmin).toBe(true);
      expect(admin.user.pending).toBeUndefined();

      // The next session is a pending newcomer.
      const newcomer = await fullSession(app);
      expect(newcomer.user.isAdmin).toBe(false);
      expect(newcomer.user.pending).toBe(true);

      // A pending user cannot post.
      expect((await postChannel(app, newcomer.cookie, "hello?")).statusCode).toBe(403);

      // The greeter (admin) sees the newcomer in the pending queue; a pending user cannot.
      const pending = await app.server.inject({
        method: "GET",
        url: "/api/access/pending",
        headers: { cookie: admin.cookie },
      });
      expect(pending.statusCode).toBe(200);
      expect((pending.json() as { id: string }[]).some((user) => user.id === newcomer.user.id)).toBe(true);
      expect(
        (
          await app.server.inject({
            method: "GET",
            url: "/api/access/pending",
            headers: { cookie: newcomer.cookie },
          })
        ).statusCode,
      ).toBe(403);

      // Approving clears pending; now they can post.
      const approved = await approve(app, admin.cookie, newcomer.user.id);
      expect(approved.statusCode).toBe(200);
      expect((approved.json() as { pending?: boolean }).pending).toBe(false);
      expect((await postChannel(app, newcomer.cookie, "now I can talk")).statusCode).toBe(201);
    });

    it("leaves the open join policy ungated", async () => {
      const app = await makeApp(); // default access.joinPolicy = "open"
      await newSession(app); // burn the firstUser admin slot
      const newcomer = await fullSession(app);
      expect(newcomer.user.pending).toBeUndefined();
      expect((await postChannel(app, newcomer.cookie, "straight in")).statusCode).toBe(201);
    });

    it("lets a greeter (not just an admin) approve pending newcomers but not ban", async () => {
      const app = await makeApp({ access: { joinPolicy: "approval" } });
      const admin = await newSession(app);

      // Promote a user to greeter: approve them, then grant the role.
      const greeter = await newSession(app);
      await approve(app, admin.cookie, greeter.userId);
      await setRoles(app, admin.cookie, greeter.userId, ["greeter"]);

      const newcomer = await newSession(app);
      expect((await approve(app, greeter.cookie, newcomer.userId)).statusCode).toBe(200);

      // Greeting is not moderating: the greeter cannot ban.
      expect((await moderate(app, greeter.cookie, newcomer.userId, { banned: true })).statusCode).toBe(403);
    });

    it("lets a greeter deny (ban) a pending newcomer and tears their session down", async () => {
      const app = await makeApp({ access: { joinPolicy: "approval" } });
      const admin = await newSession(app);
      const newcomer = await fullSession(app);
      expect(newcomer.user.pending).toBe(true);

      const denied = await deny(app, admin.cookie, newcomer.user.id);
      expect(denied.statusCode).toBe(200);
      const record = denied.json() as { banned: boolean; pending?: boolean };
      expect(record.banned).toBe(true);
      expect(record.pending).toBe(false);
      expect(app.store.loadSessions().some((session) => session.userId === newcomer.user.id)).toBe(false);

      // Denying an admin/self is refused, and a plain member cannot deny at all.
      expect((await deny(app, admin.cookie, admin.userId)).statusCode).toBe(403);
      const member = await newSession(app);
      const another = await fullSession(app);
      expect((await deny(app, member.cookie, another.user.id)).statusCode).toBe(403);

      // Deny is onboarding-only: once a newcomer is approved they are no longer pending, so denying
      // them is refused (banning an established member is a moderator action, not a greeter one).
      await approve(app, admin.cookie, another.user.id);
      expect((await deny(app, admin.cookie, another.user.id)).statusCode).toBe(400);
    });

    it("surfaces the join policy and security profile on the public bootstrap", async () => {
      // `hardened` forces `required` transport, so `/api/config` is tunnel-only content now (docs/20).
      // The same networkConfig is exposed cookie-free on the public `/api/bootstrap`, which is what a
      // pre-session client reads to learn the mode + join policy.
      const app = await makeApp({ access: { joinPolicy: "approval" }, security: { profile: "hardened" } });
      const config = (
        await app.server.inject({ method: "GET", url: "/api/bootstrap" })
      ).json() as { networkConfig: { joinPolicy: string; securityProfile: string } };
      expect(config.networkConfig.joinPolicy).toBe("approval");
      expect(config.networkConfig.securityProfile).toBe("hardened");
    });

    it("persists access.joinPolicy through the admin config API and rebroadcasts it", async () => {
      const app = await makeApp();
      const admin = await newSession(app);

      const patch = await app.server.inject({
        method: "PATCH",
        url: "/api/admin/config",
        headers: { cookie: admin.cookie },
        payload: { access: { joinPolicy: "approval" } },
      });
      expect(patch.statusCode).toBe(200);
      expect((patch.json() as { access: { joinPolicy: string } }).access.joinPolicy).toBe("approval");

      const config = (
        await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
      ).json() as { networkConfig: { joinPolicy: string } };
      expect(config.networkConfig.joinPolicy).toBe("approval");
    });
  });
});

describe("member reports + timeout + honest tombstone", () => {
  function postChannel(app: LoamApp, cookie: string, channelId: string, body: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId, body },
    });
  }
  function fileReport(app: LoamApp, cookie: string, payload: Record<string, unknown>, remoteAddress?: string): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/reports", headers: { cookie }, payload, ...(remoteAddress ? { remoteAddress } : {}) });
  }
  async function queue(app: LoamApp, cookie: string): Promise<{ id: string; reason: string; note?: string; reporterUserId: string }[]> {
    const response = await app.server.inject({ method: "GET", url: "/api/moderation/reports", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return response.json() as { id: string; reason: string; note?: string; reporterUserId: string }[];
  }

  it("keeps one open report per reporter and target: filing again updates the reason and note instead of adding a row", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const author = await newSession(app);
    const reporter = await newSession(app);
    const other = await newSession(app);
    const msgId = ((await postChannel(app, author.cookie, "general", "hmm")).json() as { message: { id: string } }).message.id;

    const first = await fileReport(app, reporter.cookie, { targetType: "message", targetId: msgId, reason: "spam" });
    expect(first.statusCode).toBe(201);
    const { id } = first.json() as { id: string };
    expect(id).toMatch(/^rpt_/);

    const again = await fileReport(app, reporter.cookie, { targetType: "message", targetId: msgId, reason: "harassment", note: "and rude" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true, id });

    let reports = await queue(app, admin.cookie);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id, reason: "harassment", note: "and rude", reporterUserId: reporter.userId });

    // Another person reporting the same message is a report of its own.
    expect((await fileReport(app, other.cookie, { targetType: "message", targetId: msgId, reason: "spam" })).statusCode).toBe(201);
    reports = await queue(app, admin.cookie);
    expect(reports).toHaveLength(2);
  });

  it("caps how many reports one person may have open at once, and resolving one makes room", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const author = await newSession(app);
    const reporter = await newSession(app);
    const messageIds: string[] = [];
    for (let index = 0; index <= OPEN_REPORTS_PER_REPORTER_MAX; index += 1) {
      messageIds.push(((await postChannel(app, author.cookie, "general", `post ${index}`)).json() as { message: { id: string } }).message.id);
    }

    // Each request from its own address: the route's per-address rate limit is a different bound from the
    // per-reporter cap under test, which follows the account, not the address.
    let address = 0;
    const fromFreshAddress = (payload: Record<string, unknown>) => {
      address += 1;
      return fileReport(app, reporter.cookie, payload, `10.9.${Math.floor(address / 250)}.${address % 250}`);
    };
    for (const targetId of messageIds.slice(0, OPEN_REPORTS_PER_REPORTER_MAX)) {
      expect((await fromFreshAddress({ targetType: "message", targetId, reason: "spam" })).statusCode).toBe(201);
    }
    const extra = messageIds[OPEN_REPORTS_PER_REPORTER_MAX] ?? "";
    const refused = await fromFreshAddress({ targetType: "message", targetId: extra, reason: "spam" });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: "too_many_attempts" });
    // Updating one already filed is not a new report, so it still goes through.
    expect((await fromFreshAddress({ targetType: "message", targetId: messageIds[0] ?? "", reason: "other" })).statusCode).toBe(200);

    const [oldest] = await queue(app, admin.cookie);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/moderation/reports/${oldest?.id ?? ""}/resolve`,
          headers: { cookie: admin.cookie },
          payload: { resolution: "dismissed" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await fromFreshAddress({ targetType: "message", targetId: extra, reason: "spam" })).statusCode).toBe(201);
  });

  it("serves a reported message's private attachment to a moderator outside the conversation only while the report is in their queue", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const channelId = ((await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Ops", visibility: "private" },
    })).json() as { id: string }).id;
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64");
    const uploaded = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie: owner.cookie },
      payload: { mimeType: "image/png", data: png, width: 1, height: 1 },
    });
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json() as { id: string; mimeType: string };
    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: owner.cookie },
      payload: { type: "channelPost", channelId, body: "look", attachments: [attachment] },
    });
    expect(posted.statusCode).toBe(201);
    const msgId = (posted.json() as { message: { id: string } }).message.id;
    const fetchAsAdmin = () =>
      app.server.inject({ method: "GET", url: `/api/attachments/${attachment.id}.png`, headers: { cookie: admin.cookie } });

    // Not a member, no report: the file does not exist for the admin.
    expect((await fetchAsAdmin()).statusCode).toBe(404);

    expect((await fileReport(app, owner.cookie, { targetType: "message", targetId: msgId, reason: "other" })).statusCode).toBe(201);
    const whileOpen = await fetchAsAdmin();
    expect(whileOpen.statusCode).toBe(200);
    expect(whileOpen.headers["cache-control"]).toBe("no-store");
    // Only reports about THIS message count: one about another message opens nothing here.
    const otherId = ((await postChannel(app, owner.cookie, channelId, "other")).json() as { message: { id: string } }).message.id;
    expect((await fileReport(app, owner.cookie, { targetType: "message", targetId: otherId, reason: "other" })).statusCode).toBe(201);

    const [report] = (await queue(app, admin.cookie)).filter((entry) => (entry as { targetId?: string }).targetId === msgId);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/moderation/reports/${report?.id ?? ""}/resolve`,
          headers: { cookie: admin.cookie },
          payload: { resolution: "dismissed" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await fetchAsAdmin()).statusCode).toBe(404);
  });

  it("cuts a reported body longer than the queue carries and says so, leaving shorter ones alone", () => {
    expect(reportedMessageBody("short")).toEqual({ body: "short" });
    const long = "x".repeat(REPORTED_MESSAGE_BODY_MAX_LENGTH + 5);
    const cut = reportedMessageBody(long);
    expect(cut).toEqual({ body: "x".repeat(REPORTED_MESSAGE_BODY_MAX_LENGTH), truncated: true });
    expect(ReportedMessageSchema.shape.body.safeParse(cut.body).success).toBe(true);
  });

  it("keeps reports moderator-private: filed but never broadcast, queue is mod-only, reporter id shown only there", async () => {
    const app = await makeApp();
    const admin = await newSession(app); // firstUser → admin (also a moderator implicitly)
    const author = await newSession(app);
    const reporter = await newSession(app);

    const msgId = ((await postChannel(app, author.cookie, "general", "questionable")).json() as {
      message: { id: string };
    }).message.id;

    const filed = await fileReport(app, reporter.cookie, {
      targetType: "message",
      targetId: msgId,
      reason: "harassment",
      note: "not ok",
    });
    expect(filed.statusCode).toBe(201);

    // A non-moderator cannot read the queue.
    expect(
      (await app.server.inject({ method: "GET", url: "/api/moderation/reports", headers: { cookie: reporter.cookie } }))
        .statusCode,
    ).toBe(403);

    // The admin (moderator) sees it, with the reporter id (mod-only egress).
    const queue = (
      await app.server.inject({ method: "GET", url: "/api/moderation/reports", headers: { cookie: admin.cookie } })
    ).json() as { targetId: string; reporterUserId: string; reason: string; status: string }[];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ targetId: msgId, reporterUserId: reporter.userId, reason: "harassment", status: "open" });

    // The report never appears in the message stream.
    const feed = (
      await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: admin.cookie } })
    ).json() as { id: string }[];
    expect(feed.some((m) => m.id.startsWith("rpt_"))).toBe(false);
  });

  it("404s a report against a private-channel message the reporter cannot see", async () => {
    const app = await makeApp();
    const owner = await newSession(app);
    const outsider = await newSession(app);
    const channelId = ((await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Ops", visibility: "private" },
    })).json() as { id: string }).id;
    const secretId = ((await postChannel(app, owner.cookie, channelId, "secret")).json() as {
      message: { id: string };
    }).message.id;

    const res = await fileReport(app, outsider.cookie, { targetType: "message", targetId: secretId, reason: "spam" });
    expect(res.statusCode).toBe(404);
  });

  it("a timeout blocks posting but not reading, and lifting it restores posting", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const member = await newSession(app);

    const future = Date.now() + 3_600_000;
    const timedOut = await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${member.userId}`,
      headers: { cookie: admin.cookie },
      payload: { timeoutUntil: future },
    });
    expect(timedOut.statusCode).toBe(200);

    // Posting is blocked (403)...
    expect((await postChannel(app, member.cookie, "general", "hi")).statusCode).toBe(403);
    // ...but reading still works.
    expect(
      (await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: member.cookie } }))
        .statusCode,
    ).toBe(200);

    // Lift the timeout (null) → posting works again.
    expect(
      (await app.server.inject({
        method: "PATCH",
        url: `/api/moderation/users/${member.userId}`,
        headers: { cookie: admin.cookie },
        payload: { timeoutUntil: null },
      })).statusCode,
    ).toBe(200);
    expect((await postChannel(app, member.cookie, "general", "hi again")).statusCode).toBe(201);
  });

  it("moderator removal leaves an honest tombstone (blanked, marked removed) — not a silent delete", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const author = await newSession(app);
    const msgId = ((await postChannel(app, author.cookie, "general", "to be removed")).json() as {
      message: { id: string };
    }).message.id;

    const removed = await app.server.inject({
      method: "POST",
      url: `/api/moderation/messages/${msgId}/remove`,
      headers: { cookie: admin.cookie },
      payload: { reason: "off-topic" },
    });
    expect(removed.statusCode).toBe(200);

    // Still present in the feed (not deleted), but blanked + flagged removed with the reason.
    const feed = (
      await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: admin.cookie } })
    ).json() as { id: string; body?: string; meta?: { removedByModerator?: boolean; removalReason?: string } }[];
    const tombstone = feed.find((m) => m.id === msgId);
    expect(tombstone).toBeDefined();
    expect(tombstone?.body).toBe("");
    expect(tombstone?.meta?.removedByModerator).toBe(true);
    expect(tombstone?.meta?.removalReason).toBe("off-topic");
  });

  it("resolving a report closes it (drops out of the open queue)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const reporter = await newSession(app);
    await fileReport(app, reporter.cookie, { targetType: "user", targetId: admin.userId, reason: "other" });

    const queue = (
      await app.server.inject({ method: "GET", url: "/api/moderation/reports", headers: { cookie: admin.cookie } })
    ).json() as { id: string }[];
    expect(queue).toHaveLength(1);

    const resolved = await app.server.inject({
      method: "POST",
      url: `/api/moderation/reports/${queue[0]?.id}/resolve`,
      headers: { cookie: admin.cookie },
      payload: { resolution: "dismissed" },
    });
    expect(resolved.statusCode).toBe(200);

    const after = (
      await app.server.inject({ method: "GET", url: "/api/moderation/reports", headers: { cookie: admin.cookie } })
    ).json() as unknown[];
    expect(after).toHaveLength(0);
  });
});

describe("participation gating (banned / pending read access)", () => {
  const readPaths = ["/api/channels", "/api/users", "/api/messages/general", "/api/search?q=x"];

  async function statusFor(app: LoamApp, cookie: string, url: string): Promise<number> {
    return (await app.server.inject({ method: "GET", url, headers: { cookie } })).statusCode;
  }

  it("locks a banned user out of every read endpoint", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);

    // Reads work before the ban.
    expect(await statusFor(app, target.cookie, "/api/channels")).toBe(200);

    const ban = await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });
    expect(ban.statusCode).toBe(200);

    for (const path of readPaths) {
      expect(await statusFor(app, target.cookie, path)).toBe(403);
    }
    expect(await statusFor(app, target.cookie, `/api/dms/${admin.userId}`)).toBe(403);

    // Config stays open — it is how the client learns it is banned.
    expect(await statusFor(app, target.cookie, "/api/config")).toBe(200);
  });

  it("holds a pending user at the door until approval, then lets them in", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const admin = await newSession(app);
    const joiner = await newSession(app);

    for (const path of readPaths) {
      expect(await statusFor(app, joiner.cookie, path)).toBe(403);
    }

    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: joiner.cookie },
      payload: { name: "Sneaky" },
    });
    expect(created.statusCode).toBe(403);

    const approve = await app.server.inject({
      method: "POST",
      url: `/api/access/users/${joiner.userId}/approve`,
      headers: { cookie: admin.cookie },
    });
    expect(approve.statusCode).toBe(200);

    for (const path of readPaths) {
      expect(await statusFor(app, joiner.cookie, path)).toBe(200);
    }
  });
});

describe("banned users and their old messages", () => {
  it("blocks a banned user from editing or deleting their old messages", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);

    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: target.cookie },
      payload: { type: "channelPost", channelId: "general", body: "before the ban" },
    });
    const messageId = (posted.json() as { message: { id: string } }).message.id;

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const edit = await app.server.inject({
      method: "PATCH",
      url: `/api/messages/${messageId}`,
      headers: { cookie: target.cookie },
      payload: { body: "rewritten after the ban" },
    });
    expect(edit.statusCode).toBe(403);

    const remove = await app.server.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: target.cookie },
    });
    expect(remove.statusCode).toBe(403);
  });
});

describe("moderator-removed messages and timeouts", () => {
  async function post(app: LoamApp, cookie: string, payload: Record<string, unknown>): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  it("a moderator-removed message can't be edited back, replied to, or newly reacted to", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const author = await newSession(app);
    const created = await post(app, author.cookie, { type: "channelPost", channelId: "general", body: "abuse" });
    expect(created.statusCode).toBe(201);
    const messageId = (created.json() as { message: { id: string } }).message.id;
    // A reaction placed BEFORE removal can still be toggled off afterwards.
    expect((await post(app, author.cookie, { type: "reaction", targetMessageId: messageId, reaction: "👍" })).statusCode).toBe(201);

    const removed = await app.server.inject({
      method: "POST",
      url: `/api/moderation/messages/${messageId}/remove`,
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(removed.statusCode).toBe(200);

    const edit = await app.server.inject({
      method: "PATCH",
      url: `/api/messages/${messageId}`,
      headers: { cookie: author.cookie },
      payload: { body: "abuse again" },
    });
    expect(edit.statusCode).toBe(403);
    expect(edit.json()).toMatchObject({ code: "message_removed" });
    const stored = app.store.loadMessages().find((message) => message.id === messageId) as { body: string } | undefined;
    expect(stored?.body).toBe("");

    const reply = await post(app, author.cookie, { type: "channelReply", channelId: "general", parentMessageId: messageId, body: "hi" });
    expect(reply.statusCode).toBe(403);
    expect(reply.json()).toMatchObject({ code: "message_removed" });

    const react = await post(app, admin.cookie, { type: "reaction", targetMessageId: messageId, reaction: "🔥" });
    expect(react.statusCode).toBe(403);
    expect(react.json()).toMatchObject({ code: "message_removed" });

    const unreact = await post(app, author.cookie, { type: "reaction", targetMessageId: messageId, reaction: "👍" });
    expect(unreact.statusCode).toBe(200);
  });

  it("computes a timeout from the server clock (timeoutMs) and clamps both forms to 7 days", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const member = await newSession(app);
    const WEEK = 7 * 24 * 3_600_000;
    const moderate = (payload: Record<string, unknown>) =>
      app.server.inject({
        method: "PATCH",
        url: `/api/moderation/users/${member.userId}`,
        headers: { cookie: admin.cookie },
        payload,
      });
    const timeoutUntil = () => app.store.loadUsers().find((user) => user.id === member.userId)?.timeoutUntil ?? 0;

    let before = Date.now();
    expect((await moderate({ timeoutMs: 3_600_000 })).statusCode).toBe(200);
    expect(timeoutUntil()).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(timeoutUntil()).toBeLessThanOrEqual(Date.now() + 3_600_000);

    expect((await moderate({ timeoutMs: 10 * 365 * 24 * 3_600_000 })).statusCode).toBe(200);
    expect(timeoutUntil()).toBeLessThanOrEqual(Date.now() + WEEK);

    // A skewed moderator clock sending an absolute far-future time (legacy field) is clamped too.
    before = Date.now();
    expect((await moderate({ timeoutUntil: before + 50 * 365 * 24 * 3_600_000 })).statusCode).toBe(200);
    expect(timeoutUntil()).toBeLessThanOrEqual(Date.now() + WEEK);
    expect(timeoutUntil()).toBeGreaterThanOrEqual(before + WEEK - 1_000);

    expect((await moderate({ timeoutUntil: null })).statusCode).toBe(200);
    expect(timeoutUntil()).toBe(0);
  });
});
