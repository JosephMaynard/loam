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

describe("security profiles", () => {
  type FullConfig = {
    security: { profile: string };
    access: { joinPolicy: string };
    retention: { messageTtlMs?: number };
    killSwitch: { enabled: boolean };
  };

  async function adminConfig(app: LoamApp, cookie: string): Promise<FullConfig> {
    return (
      await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie } })
    ).json() as FullConfig;
  }

  it("hardened forces its coherent bundle: approval join, ephemeral TTL, armed kill switch", async () => {
    const app = await makeApp({ security: { profile: "hardened" } });
    const admin = await newSession(app);
    expect(admin.isAdmin).toBe(true);

    const network = (
      await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
    ).json() as { networkConfig: { joinPolicy: string; securityProfile: string } };
    expect(network.networkConfig.securityProfile).toBe("hardened");
    expect(network.networkConfig.joinPolicy).toBe("approval");

    const full = await adminConfig(app, admin.cookie);
    expect(full.access.joinPolicy).toBe("approval");
    expect(full.retention.messageTtlMs).toBe(3_600_000);
    expect(full.killSwitch.enabled).toBe(true);
  });

  it("selecting a profile via PATCH applies the whole bundle even for unspecified axes", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { profile: "hardened" } },
    });
    expect(patch.statusCode).toBe(200);
    const cfg = patch.json() as FullConfig;
    expect(cfg.security.profile).toBe("hardened");
    expect(cfg.access.joinPolicy).toBe("approval");
    expect(cfg.retention.messageTtlMs).toBe(3_600_000);
    expect(cfg.killSwitch.enabled).toBe(true);
  });

  it("custom leaves individually-set axes untouched (no forcing)", async () => {
    const app = await makeApp({
      security: { profile: "custom" },
      access: { joinPolicy: "approval" },
      killSwitch: { enabled: true },
    });
    const admin = await newSession(app);
    const full = await adminConfig(app, admin.cookie);
    expect(full.security.profile).toBe("custom");
    expect(full.access.joinPolicy).toBe("approval");
    expect(full.killSwitch.enabled).toBe(true);
  });

  it("defaults to custom, so a kill switch set without a profile is preserved", async () => {
    const app = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    const full = await adminConfig(app, admin.cookie);
    expect(full.security.profile).toBe("custom");
    expect(full.killSwitch.enabled).toBe(true);
  });

  it("keeps explicit axes from a config.json that also pins a preset profile (effective: custom)", async () => {
    // Hand-authored config.json pinning `standard` (kill switch off) alongside an explicitly-armed
    // kill switch must not have it silently disarmed — the file path reconciles just like the DB one.
    const app = await makeApp({ security: { profile: "standard" }, killSwitch: { enabled: true } });
    const admin = await newSession(app);
    const full = await adminConfig(app, admin.cookie);
    expect(full.security.profile).toBe("custom");
    expect(full.killSwitch.enabled).toBe(true);
  });

  it("heals a legacy persisted profile that would otherwise silently disarm the kill switch", async () => {
    const { app, dataDir } = await makeApp();
    // Simulate config saved by an older build where the profile was inert: profile `standard` sat
    // alongside an explicitly-armed kill switch. The new authoritative `standard` preset would
    // disarm it, so boot must demote the profile to `custom` and keep the operator's setting.
    app.store.setConfigValue(
      "config",
      JSON.stringify({ security: { profile: "standard" }, killSwitch: { enabled: true } }),
    );

    const next = await reopenApp(app, dataDir);
    const admin = await newSession(next);
    const full = await adminConfig(next, admin.cookie);
    expect(full.security.profile).toBe("custom");
    expect(full.killSwitch.enabled).toBe(true);
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

  it("keeps private-channel messages scoped to members and skips archived channels", async () => {
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

    // Archiving a channel removes its messages from search results too.
    await post(app, admin.cookie, "general", "archive me please");
    await app.server.inject({
      method: "PATCH",
      url: "/api/channels/general",
      headers: { cookie: admin.cookie },
      payload: { archived: true },
    });
    expect(results(await search(app, admin.cookie, "archive me")).length).toBe(0);
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

describe("websocket privacy filtering", () => {
  type WireEvent = { type?: string; messageId?: string; user?: { id?: string; pending?: boolean }; message?: { id?: string } };

  const openSockets: WebSocket[] = [];

  afterEach(() => {
    for (const socket of openSockets) {
      socket.close();
    }
    openSockets.length = 0;
  });

  async function listen(app: LoamApp): Promise<string> {
    return app.server.listen({ port: 0, host: "127.0.0.1" });
  }

  function connect(baseUrl: string, cookie: string): Promise<{ socket: WebSocket; events: WireEvent[]; closed: Promise<void> }> {
    return new Promise((resolve, reject) => {
      // Undici's WebSocket accepts an options bag with headers (needed to send the session cookie).
      const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
        `${baseUrl.replace("http", "ws")}/ws`,
        { headers: { cookie } },
      );
      const events: WireEvent[] = [];
      const closed = new Promise<void>((resolveClose) => {
        socket.addEventListener("close", () => resolveClose());
      });
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String((event as MessageEvent).data)) as WireEvent);
      });
      socket.addEventListener("open", () => {
        openSockets.push(socket);
        resolve({ socket, events, closed });
      });
      socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
    });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  /**
   * Bounded wait for an expected event, so positive assertions don't race CI scheduling the way a
   * fixed sleep can. Negative assertions ("never delivered") still use `settle` — or first await
   * the *other* party's copy of the same broadcast, which proves delivery completed.
   */
  async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (check()) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return check();
  }

  it("withholds a shadow-banned author's deleted message body from everyone else", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);
    const viewer = await newSession(app);
    const baseUrl = await listen(app);

    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: target.cookie },
      payload: { type: "channelPost", channelId: "general", body: "the hidden text" },
    });
    const messageId = (posted.json() as { message: { id: string } }).message.id;

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    const viewerSocket = await connect(baseUrl, viewer.cookie);
    const targetSocket = await connect(baseUrl, target.cookie);

    const deleted = await app.server.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: admin.cookie },
    });
    expect(deleted.statusCode).toBe(200);

    // The delete event carries the full body — it must stay between the author and nobody else.
    // The author receiving their copy proves the broadcast completed, making the viewer's silence
    // a real verdict rather than a timing artifact.
    expect(
      await waitFor(() =>
        targetSocket.events.some((event) => event.type === "messageDeleted" && event.messageId === messageId),
      ),
    ).toBe(true);
    expect(viewerSocket.events.some((event) => event.type === "messageDeleted")).toBe(false);
  });

  it("rejects a banned user's websocket reconnect", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);
    const baseUrl = await listen(app);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const reconnect = await connect(baseUrl, target.cookie);
    await reconnect.closed;
    expect(reconnect.events.some((event) => event.type === "error")).toBe(true);

    // A healthy user still connects and stays connected.
    const healthy = await connect(baseUrl, admin.cookie);
    await settle();
    expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("limits a pending user's feed to node notices and their own approval", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const admin = await newSession(app);
    const joiner = await newSession(app);
    const baseUrl = await listen(app);

    const joinerSocket = await connect(baseUrl, joiner.cookie);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "members only chatter" },
    });
    await settle();
    expect(joinerSocket.events.some((event) => event.type === "messageCreated")).toBe(false);

    await app.server.inject({
      method: "POST",
      url: `/api/access/users/${joiner.userId}/approve`,
      headers: { cookie: admin.cookie },
    });
    expect(
      await waitFor(() =>
        joinerSocket.events.some(
          (event) => event.type === "userUpserted" && event.user?.id === joiner.userId && event.user?.pending !== true,
        ),
      ),
    ).toBe(true);
  });

  it("announces hidden identities only to themselves and to moderators", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const bystander = await newSession(app);
    const target = await newSession(app);
    const baseUrl = await listen(app);

    const adminSocket = await connect(baseUrl, admin.cookie);
    const bystanderSocket = await connect(baseUrl, bystander.cookie);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const sawBanned = (events: WireEvent[]) =>
      events.some((event) => event.type === "userUpserted" && event.user?.id === target.userId);
    // The moderator receiving their copy proves the broadcast completed before the negative check.
    expect(await waitFor(() => sawBanned(adminSocket.events))).toBe(true);
    expect(sawBanned(bystanderSocket.events)).toBe(false);
  });
});

describe("review hardening fixes", () => {
  it("encrypted kill switch re-persists admin config edits into the fresh database", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-enc-config-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const key = "a fixed host passphrase";
    const first = await buildApp({ dataDir, logger: false, dbEncryptionKey: key });
    cleanups.push(() => first.close());

    const admin = await newSession(first);
    // Arm the kill switch purely via the admin API — persisted only in the DB config table.
    const patch = await first.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { killSwitch: { enabled: true }, features: { enableReactions: false } },
    });
    expect(patch.statusCode).toBe(200);

    const wipe = await first.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // Restart on the same data dir + key: the admin edits must survive the wipe.
    await first.close();
    const second = await buildApp({ dataDir, logger: false, dbEncryptionKey: key });
    cleanups.push(() => second.close());

    const nextAdmin = await newSession(second);
    const config = await second.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: nextAdmin.cookie },
    });
    const body = config.json() as { killSwitch: { enabled: boolean }; features: { enableReactions: boolean } };
    expect(body.killSwitch.enabled).toBe(true);
    expect(body.features.enableReactions).toBe(false);
  });

  it("retention reaper cascades an expired thread root to its replies and reactions", async () => {
    const app = await makeApp({ retention: { messageTtlMs: 500 } });
    const session = await newSession(app);

    const root = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "expiring root" },
    });
    const rootId = (root.json() as { message: { id: string } }).message.id;

    await new Promise((resolve) => setTimeout(resolve, 700));

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

describe("message attachments", () => {
  // A real 1x1 PNG (valid magic bytes) — small enough to inline.
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  async function upload(app: LoamApp, cookie: string, data = tinyPng, mimeType = "image/png") {
    return app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie },
      payload: { mimeType, data, width: 1, height: 1 },
    });
  }

  it("uploads, attaches, serves, and allows an image-only message", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    const uploaded = await upload(app, session.cookie);
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json() as { id: string; mimeType: string };
    expect(attachment.id).toMatch(/^att_[a-f0-9]{16}$/);

    // Empty body + attachment is a valid message.
    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attachment] },
    });
    expect(posted.statusCode).toBe(201);

    const served = await app.server.inject({
      method: "GET",
      url: `/api/attachments/${attachment.id}.png`,
      headers: { cookie: session.cookie },
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");

    const listed = (
      await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: session.cookie } })
    ).json() as { attachments?: { id: string }[] }[];
    expect(listed[0]?.attachments?.[0]?.id).toBe(attachment.id);
  });

  it("rejects a message with no body and no attachments", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "   " },
    });
    expect(posted.statusCode).toBe(400);
  });

  it("rejects uploads when the flag is off, on signature mismatch, and foreign attachment ids", async () => {
    const flagOff = await makeApp({ features: { enableAttachments: false } });
    const offSession = await newSession(flagOff);
    expect((await upload(flagOff, offSession.cookie)).statusCode).toBe(403);

    const app = await makeApp();
    const alice = await newSession(app);
    const mallory = await newSession(app);

    // Declared webp but PNG bytes.
    expect((await upload(app, alice.cookie, tinyPng, "image/webp")).statusCode).toBe(400);

    const uploaded = (await upload(app, alice.cookie)).json() as { id: string; mimeType: string };

    // Mallory cannot attach Alice's pending upload...
    const stolen = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: mallory.cookie },
      payload: { type: "channelPost", channelId: "general", body: "mine now", attachments: [uploaded] },
    });
    expect(stolen.statusCode).toBe(400);
    expect((stolen.json() as { error: string }).error).toBe("Unknown attachment");

    // ...and after Alice uses it, the id is consumed and cannot be attached again.
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: alice.cookie },
          payload: { type: "channelPost", channelId: "general", body: "one", attachments: [uploaded] },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: alice.cookie },
          payload: { type: "channelPost", channelId: "general", body: "two", attachments: [uploaded] },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("deletes the attachment file with its message", async () => {
    const { app, dataDir } = await makeApp();
    const session = await newSession(app);

    const attachment = (await upload(app, session.cookie)).json() as { id: string; mimeType: string };
    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attachment] },
    });
    const messageId = (posted.json() as { message: { id: string } }).message.id;
    const filePath = join(dataDir, "attachments", `${attachment.id}.png`);
    expect(existsSync(filePath)).toBe(true);

    await app.server.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: session.cookie },
    });
    // File removal is best-effort/async — poll briefly.
    for (let i = 0; i < 40 && existsSync(filePath); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("node-to-node sync", () => {
  async function listenApp(app: LoamApp): Promise<string> {
    return app.server.listen({ port: 0, host: "127.0.0.1" });
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

  async function runSync(app: LoamApp, cookie: string) {
    return app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  }

  async function generalBodies(app: LoamApp, cookie: string): Promise<string[]> {
    const response = await app.server.inject({
      method: "GET",
      url: "/api/messages/general",
      headers: { cookie },
    });
    return (response.json() as { body?: string }[]).map((message) => message.body ?? "");
  }

  it("answers 404 on the sync endpoints unless enabled", async () => {
    const app = await makeApp();
    expect((await app.server.inject({ method: "GET", url: "/api/sync/digest" })).statusCode).toBe(404);
    expect(
      (await app.server.inject({ method: "POST", url: "/api/sync/messages", payload: { ids: ["x"] } })).statusCode,
    ).toBe(404);
  });

  it("pulls public messages and channels from a peer, sanitizing imported users", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    expect(sourceAdmin.isAdmin).toBe(true);
    await post(source, sourceAdmin.cookie, "general", "hello from the other node");
    await source.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: sourceAdmin.cookie },
      payload: { name: "Relief Ops" },
    });
    await post(source, sourceAdmin.cookie, "relief-ops", "supplies at the depot");
    const sourceUrl = await listenApp(source);

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl, label: "source" }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);

    const run = await runSync(puller, pullerAdmin.cookie);
    expect(run.statusCode).toBe(200);
    const report = run.json() as { peers: { status?: { lastError?: string; imported: number } }[] };
    expect(report.peers[0]?.status?.lastError).toBeUndefined();

    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("hello from the other node");

    // The peer's channel was imported too, with its messages.
    const channels = (
      await puller.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: pullerAdmin.cookie } })
    ).json() as { id: string }[];
    expect(channels.some((channel) => channel.id === "relief-ops")).toBe(true);

    // The source's admin author arrives as a plain user — authority never syncs.
    const importedAuthor = puller.store.loadUsers().find((user) => user.id === sourceAdmin.userId);
    expect(importedAuthor).toBeDefined();
    expect(importedAuthor?.isAdmin).toBe(false);

    // Running again imports nothing new (idempotent by id).
    const again = (await runSync(puller, pullerAdmin.cookie)).json() as {
      peers: { status?: { imported: number } }[];
    };
    const importedTotal = again.peers[0]?.status?.imported ?? -1;
    expect(importedTotal).toBeGreaterThan(0);
    const third = (await runSync(puller, pullerAdmin.cookie)).json() as {
      peers: { status?: { imported: number } }[];
    };
    expect(third.peers[0]?.status?.imported).toBe(importedTotal);
  });

  it("never exports private channels, DMs, or shadow-banned authors' messages", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const admin = await newSession(source);
    const owner = await newSession(source);
    const shadowed = await newSession(source);

    // Private channel + message.
    const created = await source.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Quiet", visibility: "private" },
    });
    const privateId = (created.json() as { id: string }).id;
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: owner.cookie },
      payload: { type: "channelPost", channelId: privateId, body: "private words" },
    });

    // DM.
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "dm", recipientUserId: owner.userId, body: "dm words" },
    });

    // Shadow-banned author's public post.
    await post(source, shadowed.cookie, "general", "shadow words");
    await source.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${shadowed.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    await post(source, admin.cookie, "general", "public words");

    const digest = (
      await source.server.inject({ method: "GET", url: "/api/sync/digest" })
    ).json() as { channels: { id: string }[]; messages: { id: string }[] };

    expect(digest.channels.some((channel) => channel.id === privateId)).toBe(false);

    // Resolve each advertised id and confirm none of the withheld bodies appear.
    const fetched = (
      await source.server.inject({
        method: "POST",
        url: "/api/sync/messages",
        payload: { ids: digest.messages.map((entry) => entry.id) },
      })
    ).json() as { messages: { body?: string }[] };
    const bodies = fetched.messages.map((message) => message.body ?? "");
    expect(bodies).toContain("public words");
    expect(bodies).not.toContain("private words");
    expect(bodies).not.toContain("dm words");
    expect(bodies).not.toContain("shadow words");
  });

  it("tombstones keep locally deleted messages from re-importing, and edits propagate", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const keepId = await post(source, sourceAdmin.cookie, "general", "keep me");
    const doomedId = await post(source, sourceAdmin.cookie, "general", "delete me locally");
    const sourceUrl = await listenApp(source);

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("delete me locally");

    // Delete locally on the puller; the source still holds it — it must not come back.
    await puller.server.inject({
      method: "DELETE",
      url: `/api/messages/${doomedId}`,
      headers: { cookie: pullerAdmin.cookie },
    });
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).not.toContain("delete me locally");

    // An edit on the source propagates (newer editedAt wins).
    await source.server.inject({
      method: "PATCH",
      url: `/api/messages/${keepId}`,
      headers: { cookie: sourceAdmin.cookie },
      payload: { body: "keep me (edited)" },
    });
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("keep me (edited)");
  });
});

describe("attachment + sync review hardening", () => {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  async function uploadAttachment(app: LoamApp, cookie: string) {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie },
      payload: { mimeType: "image/png", data: tinyPng },
    });
    return response.json() as { id: string; mimeType: string };
  }

  it("audience-gates attachment downloads like their owning message", async () => {
    const app = await makeApp();
    const alice = await newSession(app);
    const bob = await newSession(app);
    const eve = await newSession(app);

    // A DM attachment: participants can fetch it, a third party (or no session) cannot.
    const dmAttachment = await uploadAttachment(app, alice.cookie);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "dm", recipientUserId: bob.userId, body: "look", attachments: [dmAttachment] },
    });

    const path = `/api/attachments/${dmAttachment.id}.png`;
    expect((await app.server.inject({ method: "GET", url: path, headers: { cookie: alice.cookie } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: path, headers: { cookie: bob.cookie } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: path, headers: { cookie: eve.cookie } })).statusCode).toBe(404);
    expect((await app.server.inject({ method: "GET", url: path })).statusCode).toBe(404);

    // A public-channel attachment stays anonymously fetchable (peer nodes copy without a session).
    const publicAttachment = await uploadAttachment(app, alice.cookie);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [publicAttachment] },
    });
    expect(
      (await app.server.inject({ method: "GET", url: `/api/attachments/${publicAttachment.id}.png` })).statusCode,
    ).toBe(200);

    // A pending (not yet attached) upload is only visible to its uploader.
    const pendingAttachment = await uploadAttachment(app, alice.cookie);
    const pendingPath = `/api/attachments/${pendingAttachment.id}.png`;
    expect((await app.server.inject({ method: "GET", url: pendingPath, headers: { cookie: alice.cookie } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: pendingPath, headers: { cookie: eve.cookie } })).statusCode).toBe(404);
  });

  it("sweeps orphaned attachment files but keeps referenced and fresh-pending ones", async () => {
    const { app, dataDir } = await makeApp();
    const session = await newSession(app);
    const attachmentsDir = join(dataDir, "attachments");

    // Referenced file: attached to a message — must survive the sweep.
    const attached = await uploadAttachment(app, session.cookie);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attached] },
    });

    // Fresh pending upload: inside the grace period — must survive.
    const pending = await uploadAttachment(app, session.cookie);

    // Restart-orphan: a file on disk with no pending entry and no referencing message.
    mkdirSync(attachmentsDir, { recursive: true });
    const strayPath = join(attachmentsDir, "att_00000000000000ff.png");
    writeFileSync(strayPath, Buffer.from(tinyPng, "base64"));

    await app.reapOrphanedAttachments();

    expect(existsSync(join(attachmentsDir, `${attached.id}.png`))).toBe(true);
    expect(existsSync(join(attachmentsDir, `${pending.id}.png`))).toBe(true);
    expect(existsSync(strayPath)).toBe(false);
  });

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

  it("keeps shadow-banned users' reactions out of the sync export", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const admin = await newSession(app);
    const shadowed = await newSession(app);

    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "react to me" },
    });
    const messageId = (posted.json() as { message: { id: string } }).message.id;

    const reacted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: shadowed.cookie },
      payload: { type: "reaction", targetMessageId: messageId, reaction: "👍" },
    });
    const reactionId = (reacted.json() as { message: { id: string } }).message.id;

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${shadowed.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    const digest = (await app.server.inject({ method: "GET", url: "/api/sync/digest" })).json() as {
      messages: { id: string }[];
    };
    expect(digest.messages.some((entry) => entry.id === messageId)).toBe(true);
    expect(digest.messages.some((entry) => entry.id === reactionId)).toBe(false);
  });

  it("refuses to import a reply whose parent was tombstoned locally", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const parentPost = await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "thread root" },
    });
    const parentId = (parentPost.json() as { message: { id: string } }).message.id;
    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });

    // The puller deletes the imported thread root (tombstoning it)...
    await puller.server.inject({
      method: "DELETE",
      url: `/api/messages/${parentId}`,
      headers: { cookie: pullerAdmin.cookie },
    });

    // ...then the source grows a reply under that root.
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelReply", channelId: "general", parentMessageId: parentId, body: "late reply" },
    });

    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });

    const bodies = (
      (
        await puller.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: pullerAdmin.cookie } })
      ).json() as { body?: string }[]
    ).map((message) => message.body ?? "");
    expect(bodies).not.toContain("thread root");
    expect(bodies).not.toContain("late reply");
  });
});

describe("ready-for-use features (node name, promotion, presence)", () => {
  it("serves and hot-updates the configurable network name", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const before = (await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).json() as {
      nodeName: string;
      networkConfig: { nodeName: string };
    };
    expect(before.nodeName).toBe("LOAM local");
    expect(before.networkConfig.nodeName).toBe("LOAM local");

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { node: { name: "Sector 7 Relief Net" } },
    });
    expect(patch.statusCode).toBe(200);

    const after = (await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).json() as {
      nodeName: string;
      networkConfig: { nodeName: string };
    };
    expect(after.nodeName).toBe("Sector 7 Relief Net");
    expect(after.networkConfig.nodeName).toBe("Sector 7 Relief Net");
  });

  it("serves and hot-updates the node UI locale", async () => {
    const app = await makeApp();
    const admin = await newSession(app);

    const before = (
      await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
    ).json() as { networkConfig: { locale: string } };
    expect(before.networkConfig.locale).toBe("en");

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { node: { locale: "ar" } },
    });
    expect(patch.statusCode).toBe(200);

    const after = (
      await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
    ).json() as { networkConfig: { locale: string } };
    expect(after.networkConfig.locale).toBe("ar");

    const rejected = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { node: { locale: "xx" } },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("attaches a stable snake_case error code alongside the English error message", async () => {
    const app = await makeApp();
    await newSession(app); // first session claims the firstUser admin grant
    const user = await newSession(app); // this one is a plain member

    // A non-admin hitting an admin-only route gets the localizable code plus the English fallback.
    const denied = await app.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: user.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "Admin access required", code: "admin_required" });

    // A 404 for an unknown channel carries the not-found code.
    const missing = await app.server.inject({
      method: "GET",
      url: "/api/messages/does-not-exist",
      headers: { cookie: user.cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code?: string }).code).toBe("channel_not_found");
  });

  it("surfaces the node version in /api/config", async () => {
    // makeApp builds with no version option, so it reports the "dev" fallback.
    const app = await makeApp();
    const dev = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as { version: string };
    expect(dev.version).toBe("dev");

    // An explicit version (as server.ts / the npm CLI inject) is echoed back verbatim.
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    const versioned = await buildApp({ dataDir, logger: false, version: "9.9.9" });
    cleanups.push(async () => {
      await versioned.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    const reported = (await versioned.server.inject({ method: "GET", url: "/api/config" })).json() as { version: string };
    expect(reported.version).toBe("9.9.9");
  });

  it("lets an admin promote a member, but not non-admins, bots, or pending users", async () => {
    const app = await makeApp({
      access: { joinPolicy: "approval" },
      // Enable the LLM so the bot user exists, to exercise the type !== "human" guard below.
      llm: { ollama: { enabled: true, baseUrl: "http://localhost:11434", model: "m", botId: "bot.test", botDisplayName: "Bot" } },
    });
    const admin = await newSession(app);
    const member = await newSession(app);
    const pendingUser = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: `/api/access/users/${member.userId}/approve`,
      headers: { cookie: admin.cookie },
    });

    // A bot can never be promoted to admin (only people can be admins).
    const bot = await app.server.inject({
      method: "POST",
      url: "/api/admin/users/bot.test/promote",
      headers: { cookie: admin.cookie },
    });
    expect(bot.statusCode).toBe(400);

    // A plain member cannot promote anyone.
    const forbidden = await app.server.inject({
      method: "POST",
      url: `/api/admin/users/${admin.userId}/promote`,
      headers: { cookie: member.cookie },
    });
    expect(forbidden.statusCode).toBe(403);

    // Pending users must be approved first.
    const early = await app.server.inject({
      method: "POST",
      url: `/api/admin/users/${pendingUser.userId}/promote`,
      headers: { cookie: admin.cookie },
    });
    expect(early.statusCode).toBe(400);

    const promoted = await app.server.inject({
      method: "POST",
      url: `/api/admin/users/${member.userId}/promote`,
      headers: { cookie: admin.cookie },
    });
    expect(promoted.statusCode).toBe(200);
    expect((promoted.json() as { isAdmin: boolean }).isAdmin).toBe(true);

    // The promotion persisted and the new admin has admin powers.
    const config = await app.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: member.cookie },
    });
    expect(config.statusCode).toBe(200);
  });

  it("broadcasts presence on connect/disconnect and stays silent when disabled", async () => {
    const app = await makeApp();
    const alice = await newSession(app);
    const bob = await newSession(app);
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    const connect = (cookie: string) =>
      new Promise<{ socket: WebSocket; events: { type?: string; onlineUserIds?: string[] }[] }>((resolve, reject) => {
        const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
          `${baseUrl.replace("http", "ws")}/ws`,
          { headers: { cookie } },
        );
        const events: { type?: string; onlineUserIds?: string[] }[] = [];
        socket.addEventListener("message", (event) =>
          events.push(JSON.parse(String((event as MessageEvent).data)) as { type?: string }),
        );
        socket.addEventListener("open", () => resolve({ socket, events }));
        socket.addEventListener("error", () => reject(new Error("connect failed")));
      });

    const waitUntil = async (check: () => boolean) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !check()) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return check();
    };

    const aliceSocket = await connect(alice.cookie);
    const bobSocket = await connect(bob.cookie);

    // Alice hears that Bob came online (a presence event listing both ids).
    expect(
      await waitUntil(() =>
        aliceSocket.events.some(
          (event) =>
            event.type === "presence" &&
            !!event.onlineUserIds?.includes(alice.userId) &&
            !!event.onlineUserIds?.includes(bob.userId),
        ),
      ),
    ).toBe(true);

    // Bob disconnects; Alice's next presence event no longer lists him.
    bobSocket.socket.close();
    expect(
      await waitUntil(() => {
        const last = [...aliceSocket.events].reverse().find((event) => event.type === "presence");
        return !!last && !last.onlineUserIds?.includes(bob.userId);
      }),
    ).toBe(true);
    aliceSocket.socket.close();

    // With the flag off, no presence events are emitted at all.
    const silent = await makeApp({ features: { enablePresence: false } });
    const carol = await newSession(silent);
    const silentUrl = await silent.server.listen({ port: 0, host: "127.0.0.1" });
    const carolSocket = await new Promise<{ socket: WebSocket; events: { type?: string }[] }>((resolve, reject) => {
      const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
        `${silentUrl.replace("http", "ws")}/ws`,
        { headers: { cookie: carol.cookie } },
      );
      const events: { type?: string }[] = [];
      socket.addEventListener("message", (event) => events.push(JSON.parse(String((event as MessageEvent).data)) as { type?: string }));
      socket.addEventListener("open", () => resolve({ socket, events }));
      socket.addEventListener("error", () => reject(new Error("connect failed")));
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(carolSocket.events.some((event) => event.type === "presence")).toBe(false);
    carolSocket.socket.close();
  });
});

describe("security hardening", () => {
  it("GET /api/health returns ok without minting a session or consuming firstUser admin", async () => {
    const app = await makeApp();

    const health = await app.server.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect(health.headers["set-cookie"]).toBeUndefined();

    const first = await newSession(app);
    expect(first.isAdmin).toBe(true);
  });

  it("sets security headers (nosniff always, CSP on the app shell only)", async () => {
    const app = await makeApp();

    const api = await app.server.inject({ method: "GET", url: "/api/health" });
    expect(api.headers["x-content-type-options"]).toBe("nosniff");
    expect(api.headers["content-security-policy"]).toBeUndefined();

    const shell = await app.server.inject({ method: "GET", url: "/" });
    expect(shell.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(shell.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  });

  it("blocks a banned user from editing their profile", async () => {
    const app = await makeApp({ identity: { allowUserDisplayNameEdit: true } });
    const admin = await newSession(app);
    const target = await newSession(app);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const edit = await app.server.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie: target.cookie },
      payload: { displayName: "Ban Evader" },
    });
    expect(edit.statusCode).toBe(403);
  });

  it("rejects an over-long message body but keeps normal ones", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    const huge = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "x".repeat(8001) },
    });
    expect(huge.statusCode).toBe(400);

    const ok = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: session.cookie },
      payload: { type: "channelPost", channelId: "general", body: "x".repeat(8000) },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("does not mark the session cookie Secure on the plain-http LAN", async () => {
    // The injected request is plain http (no TLS socket, trustProxy off), so the cookie must NOT be
    // Secure — a Secure cookie would be dropped by the browser and break the session. The flag
    // flips only when request.protocol is genuinely https (a self-hoster behind a TLS proxy enables
    // trustProxy for that); we deliberately don't trust a spoofable x-forwarded-proto header.
    const app = await makeApp();

    const plain = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(String(plain.headers["set-cookie"])).toContain("loam_session=");
    expect(String(plain.headers["set-cookie"])).not.toContain("Secure");
  });
});
