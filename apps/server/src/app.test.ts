import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type AppOptions, type LoamApp } from "./app.js";

type InjectResponse = Awaited<ReturnType<LoamApp["server"]["inject"]>>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function makeApp(config?: unknown): Promise<{ app: LoamApp; dataDir: string } & LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));

  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }

  const app = await buildApp({ dataDir, logger: false });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { ...app, app, dataDir };
}

/** Reopen an app on an existing data dir (restart simulation). */
async function reopenApp(app: LoamApp, dataDir: string): Promise<LoamApp> {
  await app.close();
  const next = await buildApp({ dataDir, logger: false });
  cleanups.push(() => next.close());
  return next;
}

function sessionCookie(response: InjectResponse): string {
  const header = response.headers["set-cookie"];
  const first = Array.isArray(header) ? header[0] : header;
  const cookie = first?.split(";")[0];

  if (!cookie?.startsWith("loam_session=")) {
    throw new Error("No session cookie in response");
  }

  return cookie;
}

async function newSession(app: LoamApp): Promise<{ cookie: string; userId: string; isAdmin: boolean }> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const body = response.json() as { currentUser: { id: string; isAdmin: boolean } };
  return { cookie: sessionCookie(response), userId: body.currentUser.id, isAdmin: body.currentUser.isAdmin };
}

async function claim(app: LoamApp, cookie: string, secret: string): Promise<InjectResponse> {
  return app.server.inject({
    method: "POST",
    url: "/api/admin/claim",
    headers: { cookie },
    payload: { secret },
  });
}

describe("admin bootstrap", () => {
  it("firstUser (default): the first session becomes admin, later ones do not", async () => {
    const app = await makeApp();

    const first = await newSession(app);
    expect(first.isAdmin).toBe(true);

    const second = await newSession(app);
    expect(second.isAdmin).toBe(false);
  });

  it("demotes legacy admin seed users so bootstrap governs admin", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    writeFileSync(
      join(dataDir, "users.json"),
      JSON.stringify([
        {
          id: "user.1234",
          displayName: "Seed",
          type: "human",
          isAdmin: true,
          createdAt: 1_704_067_200_000,
          ephemeral: false,
        },
      ]),
    );

    const app = await buildApp({ dataDir, logger: false });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const users = app.store.loadUsers();
    expect(users.find((user) => user.id === "user.1234")?.isAdmin).toBe(false);

    const first = await newSession(app);
    expect(first.isAdmin).toBe(true);
  });

  it("setupCode: exposes a one-time code that grants admin exactly once", async () => {
    const app = await makeApp({ admin: { bootstrap: "setupCode" } });
    expect(app.adminSetupCode).toMatch(/^[a-f0-9]{12}$/);

    const session = await newSession(app);
    expect(session.isAdmin).toBe(false);

    const wrong = await claim(app, session.cookie, "not-the-code");
    expect(wrong.statusCode).toBe(403);

    const right = await claim(app, session.cookie, app.adminSetupCode ?? "");
    expect(right.statusCode).toBe(200);
    expect((right.json() as { isAdmin: boolean }).isAdmin).toBe(true);

    const again = await claim(app, (await newSession(app)).cookie, app.adminSetupCode ?? "");
    expect(again.statusCode).toBe(403);
  });

  it("passphrase: grants admin for the configured passphrase only", async () => {
    const app = await makeApp({ admin: { bootstrap: "passphrase", passphrase: "correct horse battery" } });

    const session = await newSession(app);
    expect(session.isAdmin).toBe(false);

    expect((await claim(app, session.cookie, "wrong horse")).statusCode).toBe(403);

    const right = await claim(app, session.cookie, "correct horse battery");
    expect(right.statusCode).toBe(200);
    expect((right.json() as { isAdmin: boolean }).isAdmin).toBe(true);
  });

  it("none: claiming is rejected and nobody becomes admin", async () => {
    const app = await makeApp({ admin: { bootstrap: "none" } });

    const session = await newSession(app);
    expect(session.isAdmin).toBe(false);
    expect((await claim(app, session.cookie, "anything")).statusCode).toBe(403);
  });

  it("rate-limits repeated claim attempts", async () => {
    const app = await makeApp({ admin: { bootstrap: "passphrase", passphrase: "correct horse battery" } });
    const session = await newSession(app);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await claim(app, session.cookie, `wrong-${attempt}`)).statusCode).toBe(403);
    }

    expect((await claim(app, session.cookie, "wrong-again")).statusCode).toBe(429);
  });

  it("exposes allowAdminClaim only while a usable claim secret exists", async () => {
    const claimable = await makeApp({ admin: { bootstrap: "setupCode" } });
    const readClaimFlag = async (app: LoamApp) =>
      (
        (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
          networkConfig: { allowAdminClaim: boolean };
        }
      ).networkConfig.allowAdminClaim;

    expect(await readClaimFlag(claimable)).toBe(true);

    // Once the one-time code is spent, stop advertising a claim flow that cannot succeed.
    const session = await newSession(claimable);
    await claim(claimable, session.cookie, claimable.adminSetupCode ?? "");
    expect(await readClaimFlag(claimable)).toBe(false);

    const notClaimable = await makeApp();
    expect(await readClaimFlag(notClaimable)).toBe(false);
  });
});

describe("admin config API", () => {
  it("rejects non-admins", async () => {
    const app = await makeApp({ admin: { bootstrap: "none" } });
    const session = await newSession(app);

    const get = await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: session.cookie } });
    expect(get.statusCode).toBe(403);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: session.cookie },
      payload: { features: { enableReplies: false } },
    });
    expect(patch.statusCode).toBe(403);
  });

  it("returns the effective config with the passphrase redacted", async () => {
    const app = await makeApp({ admin: { bootstrap: "passphrase", passphrase: "correct horse battery" } });
    const session = await newSession(app);
    await claim(app, session.cookie, "correct horse battery");

    const response = await app.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const config = response.json() as { admin: { bootstrap: string; passphrase?: string }; features: { enableReplies: boolean } };
    expect(config.admin.bootstrap).toBe("passphrase");
    expect(config.admin.passphrase).toBeUndefined();
    expect(config.features.enableReplies).toBe(true);
  });

  it("rejects invalid config updates", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const response = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { features: { enableReplies: "nope" } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("applies, enforces, broadcasts shape, and persists feature flag changes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const initialApp = await buildApp({ dataDir, logger: false });
    let app: LoamApp = initialApp;
    cleanups.push(() => initialApp.close());

    const admin = await newSession(app);
    expect(admin.isAdmin).toBe(true);

    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "root post" },
    });
    expect(post.statusCode).toBe(201);
    const postId = (post.json() as { message: { id: string } }).message.id;

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { features: { enableReplies: false, enableReactions: false } },
    });
    expect(patch.statusCode).toBe(200);

    const reply = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelReply", channelId: "general", parentMessageId: postId, body: "reply" },
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toMatch(/Replies are disabled/);

    const reaction = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "reaction", targetMessageId: postId, reaction: "👍" },
    });
    expect(reaction.statusCode).toBe(400);

    const networkConfig = (
      (await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).json() as {
        networkConfig: { enableReplies: boolean; enableReactions: boolean };
      }
    ).networkConfig;
    expect(networkConfig.enableReplies).toBe(false);
    expect(networkConfig.enableReactions).toBe(false);

    app = await reopenApp(app, dataDir);
    const reopened = (
      (await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).json() as {
        currentUser: { isAdmin: boolean };
        networkConfig: { enableReplies: boolean };
      }
    );
    expect(reopened.networkConfig.enableReplies).toBe(false);
    expect(reopened.currentUser.isAdmin).toBe(true);
  });

  it("redacts the panic token and never returns it", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });
    const admin = await newSession(app);

    const response = await app.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
    });
    const config = response.json() as { killSwitch: { enabled: boolean; panicToken?: string } };
    expect(config.killSwitch.enabled).toBe(true);
    expect(config.killSwitch.panicToken).toBeUndefined();
  });

  it("refuses to clear the passphrase while the passphrase strategy is active", async () => {
    const app = await makeApp({ admin: { bootstrap: "passphrase", passphrase: "correct horse battery" } });
    const admin = await newSession(app);
    await claim(app, admin.cookie, "correct horse battery");

    const clearWhileActive = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { admin: { passphrase: "" } },
    });
    expect(clearWhileActive.statusCode).toBe(400);

    // Switching strategy and clearing together is fine — and claiming stops working.
    const switchAndClear = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { admin: { bootstrap: "none", passphrase: "" } },
    });
    expect(switchAndClear.statusCode).toBe(200);

    const session = await newSession(app);
    expect((await claim(app, session.cookie, "correct horse battery")).statusCode).toBe(403);
  });
});

describe("kill switch", () => {
  async function postKillSwitch(
    app: LoamApp,
    cookie: string,
    payload: Record<string, unknown> = { confirm: "wipe" },
  ) {
    return app.server.inject({ method: "POST", url: "/api/admin/kill-switch", headers: { cookie }, payload });
  }

  it("requires typed confirmation when requireConfirmation is on (the default)", async () => {
    const app = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);

    expect((await postKillSwitch(app, admin.cookie, {})).statusCode).toBe(400);
    expect((await postKillSwitch(app, admin.cookie, { confirm: "yes" })).statusCode).toBe(400);
    expect(app.store.loadSessions().length).toBeGreaterThan(0);
    expect((await postKillSwitch(app, admin.cookie, { confirm: "wipe" })).statusCode).toBe(200);
    expect(app.store.loadSessions()).toEqual([]);
  });

  it("fires without confirmation when requireConfirmation is off", async () => {
    const app = await makeApp({ killSwitch: { enabled: true, requireConfirmation: false } });
    const admin = await newSession(app);

    expect((await postKillSwitch(app, admin.cookie, {})).statusCode).toBe(200);
  });

  it("rejects non-admins and admins on nodes where it is disabled", async () => {
    const disabled = await makeApp();
    const admin = await newSession(disabled);
    const visitor = await newSession(disabled);

    expect((await postKillSwitch(disabled, visitor.cookie)).statusCode).toBe(403);
    expect((await postKillSwitch(disabled, admin.cookie)).statusCode).toBe(403);
    expect(disabled.store.loadMessages().length).toBe(0);
  });

  it("wipes all data, invalidates sessions, clears avatars, and re-seeds defaults", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);

    const avatarsDir = join(dataDir, "avatars");
    mkdirSync(avatarsDir, { recursive: true });
    writeFileSync(join(avatarsDir, "avt_deadbeefdeadbeef.webp"), "fake");

    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "to be wiped" },
    });
    expect(post.statusCode).toBe(201);

    const wipe = await postKillSwitch(app, admin.cookie);
    expect(wipe.statusCode).toBe(200);

    expect(app.store.loadMessages()).toEqual([]);
    expect(app.store.loadSessions()).toEqual([]);
    expect(app.store.loadUsers().every((user) => !user.isAdmin)).toBe(true);
    expect(app.store.loadChannels().map((channel) => channel.id).sort()).toEqual(["announcements", "general"]);
    expect(existsSync(join(avatarsDir, "avt_deadbeefdeadbeef.webp"))).toBe(false);

    const returning = await app.server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: admin.cookie },
    });
    const returningUser = (returning.json() as { currentUser: { id: string; isAdmin: boolean } }).currentUser;
    expect(returningUser.id).not.toBe(admin.userId);

    const fresh = await newSession(app);
    expect(fresh.isAdmin).toBe(false);
  });

  it("keeps the kill switch enabled after a wipe so it can fire again", async () => {
    const app = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    expect((await postKillSwitch(app, admin.cookie)).statusCode).toBe(200);

    const nextAdmin = await newSession(app);
    expect(nextAdmin.isAdmin).toBe(true);
    expect((await postKillSwitch(app, nextAdmin.cookie)).statusCode).toBe(200);
  });
});

describe("panic endpoint", () => {
  async function panic(app: LoamApp, token: string) {
    return app.server.inject({ method: "POST", url: "/api/panic", payload: { token } });
  }

  it("404s when the kill switch or token is not configured", async () => {
    const noKillSwitch = await makeApp();
    expect((await panic(noKillSwitch, "whatever")).statusCode).toBe(404);

    const noToken = await makeApp({ killSwitch: { enabled: true } });
    expect((await panic(noToken, "whatever")).statusCode).toBe(404);
  });

  it("wipes without authentication given the correct token, rejects wrong tokens", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });
    const admin = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "to be wiped" },
    });

    expect((await panic(app, "wrong-token")).statusCode).toBe(403);
    expect(app.store.loadMessages().length).toBe(1);

    expect((await panic(app, "panic-token-0123456789")).statusCode).toBe(200);
    expect(app.store.loadMessages()).toEqual([]);
  });

  it("rate-limits repeated wrong tokens", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await panic(app, `wrong-${attempt}`)).statusCode).toBe(403);
    }

    expect((await panic(app, "wrong-again")).statusCode).toBe(429);
  });
});

describe("message retention (ephemeral messages)", () => {
  it("reaps messages older than the configured TTL and keeps newer ones", async () => {
    // Generous margins keep this deterministic on slow CI: the old message is ~700ms old at reap
    // time (TTL 500ms) while the fresh one is only as old as the two intervening inject calls.
    const app = await makeApp({ retention: { messageTtlMs: 500 } });
    const session = await newSession(app);

    const oldPost = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "old enough to expire" },
    });
    expect(oldPost.statusCode).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 700));

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

    await new Promise((resolve) => setTimeout(resolve, 10));
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

describe("message authorization", () => {
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
    const app = await buildApp({ dataDir, logger: false });
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

describe("config robustness", () => {
  it("boots with defaults when the config file is malformed JSON", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    writeFileSync(join(dataDir, "config.json"), "{ this is not json");
    const app = await buildApp({ dataDir, logger: false });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const first = await newSession(app);
    expect(first.isAdmin).toBe(true);
  });

  it("boots when the persisted config row is malformed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const initialApp = await buildApp({ dataDir, logger: false });
    cleanups.push(() => initialApp.close());
    initialApp.store.setConfigValue("config", "{ broken");

    const reopened = await reopenApp(initialApp, dataDir);
    const session = await newSession(reopened);
    expect(session.isAdmin).toBe(true);
  });

  it("rejects update secrets shorter than their configured minimums", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const patch = (payload: Record<string, unknown>) =>
      app.server.inject({ method: "PATCH", url: "/api/admin/config", headers: { cookie: admin.cookie }, payload });

    expect((await patch({ admin: { passphrase: "short" } })).statusCode).toBe(400);
    expect((await patch({ killSwitch: { panicToken: "tooshort" } })).statusCode).toBe(400);
    expect((await patch({ admin: { passphrase: "" } })).statusCode).toBe(200);
    expect((await patch({ admin: { passphrase: "long enough passphrase" } })).statusCode).toBe(200);
  });
});

describe("avatar uploads", () => {
  it("keeps only the latest uploaded avatar image per user", async () => {
    const { app, dataDir } = await makeApp({
      identity: { allowUserAvatarEdit: true, allowUserAvatarUpload: true },
    });
    const session = await newSession(app);
    const webp = Buffer.from("RIFF\0\0\0\0WEBP").toString("base64");
    const upload = () =>
      app.server.inject({
        method: "PUT",
        url: "/api/users/me/avatar-image",
        headers: { cookie: session.cookie },
        payload: { mimeType: "image/webp", data: webp },
      });

    const first = await upload();
    expect(first.statusCode).toBe(200);
    const firstImageId = (first.json() as { avatar: { imageId: string } }).avatar.imageId;
    expect(existsSync(join(dataDir, "avatars", `${firstImageId}.webp`))).toBe(true);

    const second = await upload();
    expect(second.statusCode).toBe(200);
    const secondImageId = (second.json() as { avatar: { imageId: string } }).avatar.imageId;

    expect(existsSync(join(dataDir, "avatars", `${secondImageId}.webp`))).toBe(true);
    expect(existsSync(join(dataDir, "avatars", `${firstImageId}.webp`))).toBe(false);
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

describe("secret storage", () => {
  it("persists the passphrase and panic token scrypt-hashed, never in the clear", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: {
        admin: { bootstrap: "passphrase", passphrase: "correct horse battery" },
        killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
      },
    });
    expect(patch.statusCode).toBe(200);

    const persisted = app.store.getConfigValue("config") ?? "";
    expect(persisted).not.toContain("correct horse battery");
    expect(persisted).not.toContain("panic-token-0123456789");
    expect(persisted).toContain("scrypt:");

    // The plaintext still verifies after a restart (hash round-trips through the DB).
    const { dataDir } = app as unknown as { dataDir: string };
    const reopened = await reopenApp(app, dataDir);
    const session = await newSession(reopened);
    expect((await claim(reopened, session.cookie, "correct horse battery")).statusCode).toBe(200);
  });

  it("rate-limits avatar uploads per route", async () => {
    const app = await makeApp({
      identity: { allowUserAvatarEdit: true, allowUserAvatarUpload: true },
    });
    const session = await newSession(app);
    const webp = Buffer.from("RIFF\0\0\0\0WEBP").toString("base64");
    let limited = 0;

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.server.inject({
        method: "PUT",
        url: "/api/users/me/avatar-image",
        headers: { cookie: session.cookie },
        payload: { mimeType: "image/webp", data: webp },
      });

      if (response.statusCode === 429) {
        limited += 1;
      }
    }

    expect(limited).toBeGreaterThan(0);
  });
});

describe("encryption at rest + key-discard kill switch", () => {
  // Build directly (not via makeApp) so `app.store` stays the live getter across an encrypted wipe.
  async function makeEncryptedApp(
    opts: Pick<AppOptions, "dbEncryptionKey" | "ephemeralDbKey">,
    config?: unknown,
  ): Promise<{ app: LoamApp; dataDir: string }> {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-enc-app-test-"));
    if (config !== undefined) {
      writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
    }
    const app = await buildApp({ dataDir, logger: false, ...opts });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    return { app, dataDir };
  }

  async function session(app: LoamApp) {
    const response = await app.server.inject({ method: "GET", url: "/api/config" });
    return {
      cookie: sessionCookie(response),
      user: (response.json() as { currentUser: { id: string; isAdmin: boolean } }).currentUser,
    };
  }

  async function post(app: LoamApp, cookie: string, body: string) {
    return app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId: "general", body },
    });
  }

  function dataDirHasPlaintext(dataDir: string, needle: string): boolean {
    const target = Buffer.from(needle);
    return readdirSync(dataDir)
      .filter((name) => name.startsWith("loam.db"))
      .some((name) => readFileSync(join(dataDir, name)).includes(target));
  }

  it("ephemeral mode writes an encrypted database (no plaintext on disk)", async () => {
    const { app, dataDir } = await makeEncryptedApp({ ephemeralDbKey: true });
    const admin = await session(app);
    expect((await post(app, admin.cookie, "EPHEMERAL_PLAINTEXT_NEEDLE")).statusCode).toBe(201);

    expect(dataDirHasPlaintext(dataDir, "EPHEMERAL_PLAINTEXT_NEEDLE")).toBe(false);
    expect(readFileSync(join(dataDir, "loam.db")).subarray(0, 15).toString("ascii")).not.toBe(
      "SQLite format 3",
    );
  });

  it("kill switch on an ephemeral-key node empties data, rotates the file, and the node recovers", async () => {
    const { app, dataDir } = await makeEncryptedApp(
      { ephemeralDbKey: true },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect(admin.user.isAdmin).toBe(true);
    expect((await post(app, admin.cookie, "DOOMED_SECRET_NEEDLE")).statusCode).toBe(201);

    const before = readFileSync(join(dataDir, "loam.db"));

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // Live getter → the reopened store. Old message gone; node re-seeded and usable.
    expect(app.store.loadMessages()).toEqual([]);
    expect(dataDirHasPlaintext(dataDir, "DOOMED_SECRET_NEEDLE")).toBe(false);
    const after = readFileSync(join(dataDir, "loam.db"));
    expect(after.equals(before)).toBe(false); // fresh key ⇒ entirely different ciphertext
    expect(after.subarray(0, 15).toString("ascii")).not.toBe("SQLite format 3");

    const returning = await session(app);
    expect(returning.user.isAdmin).toBe(true); // firstUser bootstrap re-applies on the fresh node
    expect((await post(app, returning.cookie, "after wipe")).statusCode).toBe(201);
  });

  it("kill switch on a passphrase-key node also empties and recovers", async () => {
    const { app } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed host passphrase" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    await post(app, admin.cookie, "doomed");

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(app.store.loadMessages()).toEqual([]);
    expect((await post(app, (await session(app)).cookie, "after")).statusCode).toBe(201);
  });
});

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

  function createChannel(app: LoamApp, cookie: string, payload: unknown): Promise<InjectResponse> {
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
    payload: unknown,
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

  it("lists archived channels for admins even though the public list hides them", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const created = (await createChannel(app, admin.cookie, { name: "Hidden" })).json() as ChannelBody;
    await updateChannel(app, admin.cookie, created.id, { archived: true });

    // Public list omits it, admin list keeps it (so it can be restored).
    expect((await listChannels(app, admin.cookie)).some((entry) => entry.id === created.id)).toBe(false);

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

    const archived = await updateChannel(app, admin.cookie, created.id, { archived: true });
    expect(archived.statusCode).toBe(200);
    expect((await listChannels(app, admin.cookie)).some((entry) => entry.id === created.id)).toBe(false);

    const restored = await updateChannel(app, admin.cookie, created.id, { archived: false });
    expect(restored.statusCode).toBe(200);
    expect((await listChannels(app, admin.cookie)).some((entry) => entry.id === created.id)).toBe(true);
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
    let app: LoamApp = await buildApp({ dataDir, logger: false });
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

describe("message deletion API", () => {
  function postMessage(app: LoamApp, cookie: string, payload: unknown): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  function deleteMessage(app: LoamApp, cookie: string, id: string): Promise<InjectResponse> {
    return app.server.inject({ method: "DELETE", url: `/api/messages/${id}`, headers: { cookie } });
  }

  async function postId(app: LoamApp, cookie: string, payload: unknown): Promise<string> {
    const response = await postMessage(app, cookie, payload);
    expect(response.statusCode).toBe(201);
    return (response.json() as { message: { id: string } }).message.id;
  }

  const remainingIds = (app: LoamApp): string[] => app.store.loadMessages().map((message) => message.id);

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
  function postMessage(app: LoamApp, cookie: string, payload: unknown): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  function editMessage(app: LoamApp, cookie: string, id: string, payload: unknown): Promise<InjectResponse> {
    return app.server.inject({ method: "PATCH", url: `/api/messages/${id}`, headers: { cookie }, payload });
  }

  async function postId(app: LoamApp, cookie: string, payload: unknown): Promise<string> {
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
});

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
    it("lets an admin set a member's roles", async () => {
      const app = await makeApp();
      const admin = await newSession(app);
      const member = await newSession(app);

      const granted = await setRoles(app, admin.cookie, member.userId, ["moderator", "greeter"]);
      expect(granted.statusCode).toBe(200);
      expect((granted.json() as { roles: string[] }).roles).toEqual(["moderator", "greeter"]);
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

      // A shadow-banned user stays a visible participant — only their messages are withheld (via the
      // socket broadcast filter). The flag is observable to moderators.
      const roster = (
        await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: admin.cookie } })
      ).json() as { id: string; shadowBanned?: boolean }[];
      expect(roster.find((user) => user.id === member.userId)?.shadowBanned).toBe(true);

      // Un-shadow-ban clears the flag.
      const restore = await moderate(app, admin.cookie, member.userId, { shadowBanned: false });
      expect((restore.json() as { shadowBanned?: boolean }).shadowBanned).toBe(false);
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

    it("surfaces the join policy and security profile on /api/config", async () => {
      const app = await makeApp({ access: { joinPolicy: "approval" }, security: { profile: "hardened" } });
      const config = (
        await app.server.inject({ method: "GET", url: "/api/config" })
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
