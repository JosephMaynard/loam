import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MEMBER_RULES_VERSION, ModerationReportSchema, UserSchema } from "@loam/schema";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import type { AppOptions } from "./types.js";

/**
 * The member rules (the client's Welcome screen, Google Play's UGC policy) and the moderation queue that
 * enforces them: nobody publishes before agreeing, "Try another" only before agreeing, an escalated report
 * stays with the admins, and a message report shows the moderator that one message.
 */

type InjectResponse = Awaited<ReturnType<LoamApp["server"]["inject"]>>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** A fresh app with the rules gate ON (its default), on its own temp data dir. */
async function makeApp(opts?: Partial<AppOptions>): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-rules-"));
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

function request(app: LoamApp, cookie: string, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown): Promise<InjectResponse> {
  return app.server.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
}

function agree(app: LoamApp, cookie: string): Promise<InjectResponse> {
  return request(app, cookie, "POST", "/api/users/me/rules", { version: MEMBER_RULES_VERSION });
}

function post(app: LoamApp, cookie: string, body: string): Promise<InjectResponse> {
  return request(app, cookie, "POST", "/api/messages", { type: "channelPost", channelId: "general", body });
}

describe("member rules", () => {
  it("refuses posts, uploads and new channels until the person agrees", async () => {
    const app = await makeApp();
    const { cookie } = await newSession(app);

    const refused = [
      await post(app, cookie, "hello"),
      await request(app, cookie, "POST", "/api/attachments", { mimeType: "image/png", data: "aGVsbG8=" }),
      await request(app, cookie, "POST", "/api/channels", { name: "new-place" }),
    ];
    for (const response of refused) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "rules_not_accepted" });
    }

    const agreed = await agree(app, cookie);
    expect(agreed.statusCode).toBe(200);
    expect(UserSchema.parse(agreed.json()).rulesVersion).toBe(MEMBER_RULES_VERSION);
    expect((await post(app, cookie, "hello")).statusCode).toBe(201);
  });

  it("refuses an outdated rules version with its own code", async () => {
    const app = await makeApp();
    const { cookie } = await newSession(app);
    const response = await request(app, cookie, "POST", "/api/users/me/rules", { version: MEMBER_RULES_VERSION + 1 });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "rules_version_mismatch" });
  });

  it("keeps reading, reporting and blocking open before agreeing", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    await agree(app, admin.cookie);
    const posted = (await post(app, admin.cookie, "first")).json() as { message: { id: string } };
    const member = await newSession(app);

    expect((await request(app, member.cookie, "GET", "/api/messages/general")).statusCode).toBe(200);
    const report = await request(app, member.cookie, "POST", "/api/reports", {
      targetType: "message",
      targetId: posted.message.id,
      reason: "spam",
    });
    expect(report.statusCode).toBe(201);
    expect((await request(app, member.cookie, "PUT", `/api/users/me/blocks/${admin.userId}`)).statusCode).toBe(200);
  });

  it("gives a new random name for the same id, only before agreeing", async () => {
    const app = await makeApp();
    const { cookie, userId } = await newSession(app);
    const before = UserSchema.parse((await request(app, cookie, "GET", "/api/config")).json().currentUser);

    const rerolled = await request(app, cookie, "POST", "/api/users/me/reroll");
    expect(rerolled.statusCode).toBe(200);
    const after = UserSchema.parse(rerolled.json());
    expect(after.id).toBe(userId);
    expect(after.displayName).not.toBe(before.displayName);
    expect(after.avatar?.seed).toBeTruthy();

    await agree(app, cookie);
    const late = await request(app, cookie, "POST", "/api/users/me/reroll");
    expect(late.statusCode).toBe(403);
    expect(late.json()).toMatchObject({ code: "reroll_not_allowed" });
  });

  it("keeps the name of someone who posted before the rules existed", async () => {
    const app = await makeApp({ requireRulesAcceptance: false });
    const { cookie } = await newSession(app);
    expect((await post(app, cookie, "from before the update")).statusCode).toBe(201);
    const response = await request(app, cookie, "POST", "/api/users/me/reroll");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "reroll_not_allowed" });
  });

  it("allows a new random name even where people can't choose their own", async () => {
    const app = await makeApp();
    const { cookie } = await newSession(app);
    // The default config doesn't let people type a name; "Try another" still works.
    expect((await request(app, cookie, "PATCH", "/api/users/me", { displayName: "Typed" })).statusCode).toBe(403);
    expect((await request(app, cookie, "POST", "/api/users/me/reroll")).statusCode).toBe(200);
  });
});

describe("the moderation queue", () => {
  /** An admin, a moderator and a member who have all agreed, plus a member post the member reports. */
  async function reportedNode() {
    const app = await makeApp();
    const admin = await newSession(app);
    const moderator = await newSession(app);
    const member = await newSession(app);
    for (const session of [admin, moderator, member]) {
      await agree(app, session.cookie);
    }
    await request(app, admin.cookie, "PATCH", `/api/admin/users/${moderator.userId}/roles`, { roles: ["moderator"] });
    const posted = (await post(app, admin.cookie, "something nasty")).json() as { message: { id: string } };
    await request(app, member.cookie, "POST", "/api/reports", { targetType: "message", targetId: posted.message.id, reason: "harassment" });
    return { app, admin, moderator, member, messageId: posted.message.id };
  }

  async function queue(app: LoamApp, cookie: string) {
    const response = await request(app, cookie, "GET", "/api/moderation/reports");
    expect(response.statusCode).toBe(200);
    return (response.json() as unknown[]).map((item) => ModerationReportSchema.parse(item));
  }

  it("shows the moderator the reported message and where it was posted", async () => {
    const { app, moderator, admin } = await reportedNode();
    const [report] = await queue(app, moderator.cookie);
    expect(report?.message).toMatchObject({
      authorId: admin.userId,
      body: "something nasty",
      where: { kind: "channel", channelId: "general" },
    });
  });

  it("says when the reported message is gone", async () => {
    const { app, admin, moderator, messageId } = await reportedNode();
    await request(app, admin.cookie, "DELETE" as "POST", `/api/messages/${messageId}`);
    const [report] = await queue(app, moderator.cookie);
    expect(report?.message).toBeUndefined();
    expect(report?.messageGone).toBe(true);
  });

  it("keeps an escalated report for the admins until one of them resolves it", async () => {
    const { app, admin, moderator } = await reportedNode();
    const [report] = await queue(app, moderator.cookie);

    const escalated = await request(app, moderator.cookie, "POST", `/api/moderation/reports/${report!.id}/resolve`, {
      resolution: "escalated",
    });
    expect(escalated.json()).toMatchObject({ status: "escalated", escalatedByUserId: moderator.userId });

    // Gone from the moderator's queue, still in the admin's.
    expect(await queue(app, moderator.cookie)).toHaveLength(0);
    expect((await queue(app, admin.cookie)).map((entry) => entry.id)).toEqual([report!.id]);

    // Only an admin can close it.
    const byModerator = await request(app, moderator.cookie, "POST", `/api/moderation/reports/${report!.id}/resolve`, {
      resolution: "dismissed",
    });
    expect(byModerator.statusCode).toBe(403);
    const byAdmin = await request(app, admin.cookie, "POST", `/api/moderation/reports/${report!.id}/resolve`, {
      resolution: "dismissed",
    });
    expect(byAdmin.json()).toMatchObject({ status: "resolved", resolution: "dismissed" });
    expect(await queue(app, admin.cookie)).toHaveLength(0);
  });
});
