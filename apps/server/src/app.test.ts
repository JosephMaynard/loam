import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { currentEpoch, mailboxTag } from "@loam/crypto";
import { MeshIdentityCardSchema, type MeshIdentityCard } from "@loam/schema";

import { buildApp, type AppOptions, type LoamApp } from "./app.js";

type InjectResponse = Awaited<ReturnType<LoamApp["server"]["inject"]>>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function makeApp(
  config?: unknown,
  opts?: Partial<AppOptions>,
): Promise<{ app: LoamApp; dataDir: string } & LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));

  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }

  // A high identity cap so the per-IP new-identity limiter (all inject requests share 127.0.0.1)
  // never trips across a suite that mints many sessions; a dedicated test drives it low on purpose.
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
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

  it("abandons an in-flight sync round when a kill switch fires mid-pull (docs/15 #2)", async () => {
    // A controllable peer: it advertises one message, then HOLDS the /api/sync/messages response until
    // we release it — so we can fire the kill switch while node A is suspended awaiting that fetch.
    let sawMessagesRequest!: () => void;
    const messagesRequested = new Promise<void>((resolve) => (sawMessagesRequest = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const peerMessage = {
      id: "msg.peer-race",
      type: "channelPost",
      authorId: "user.peerauthor",
      channelId: "general",
      body: "from the peer",
      createdAt: 1,
    };
    const peerAuthor = {
      id: "user.peerauthor",
      displayName: "Peer Author",
      type: "human",
      isAdmin: false,
      createdAt: 1,
      ephemeral: true,
    };

    const peer = createServer((req, res) => {
      if (req.url === "/api/sync/digest") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ channels: [], messages: [{ id: peerMessage.id }] }));
        return;
      }
      if (req.url === "/api/sync/messages") {
        sawMessagesRequest();
        void gate.then(() => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ messages: [peerMessage], users: [peerAuthor] }));
        });
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => peer.close(() => resolve())));
    const peerUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;

    const app = await makeApp({
      killSwitch: { enabled: true, requireConfirmation: false },
      sync: { enabled: true, peers: [{ url: peerUrl }] },
    });
    const admin = await newSession(app);

    // Kick off a sync round; it blocks awaiting the held /api/sync/messages response.
    const syncInFlight = app.server.inject({
      method: "POST",
      url: "/api/admin/sync/run",
      headers: { cookie: admin.cookie },
    });

    await messagesRequested; // A is now mid-pull, suspended on the peer's message payload
    try {
      expect((await postKillSwitch(app, admin.cookie, {})).statusCode).toBe(200); // wipe fires mid-round
    } finally {
      release(); // always release the held response, even if the assertion throws, so nothing hangs
    }
    await syncInFlight;

    // The peer's message (and author) were NOT written back onto the freshly wiped store.
    const stored = app.store.loadMessages();
    expect(stored.some((message) => message.id === peerMessage.id)).toBe(false);
    expect(app.store.loadUsers().some((user) => user.id === peerAuthor.id)).toBe(false);
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

    // A wrong token answers 404 — identical to an unconfigured node — so the panic route can't be
    // fingerprinted; the message survives.
    expect((await panic(app, "wrong-token")).statusCode).toBe(404);
    expect(app.store.loadMessages().length).toBe(1);

    expect((await panic(app, "panic-token-0123456789")).statusCode).toBe(200);
    expect(app.store.loadMessages()).toEqual([]);
  });

  it("rate-limits repeated attempts (indistinguishably) and blocks the wipe once tripped", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });
    const admin = await newSession(app);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "survives the brute force" },
    });

    // Every wrong attempt looks like a 404 (not a distinguishable 403/429).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await panic(app, `wrong-${attempt}`)).statusCode).toBe(404);
    }

    // Once the attempt limiter trips, even the CORRECT token is refused (checked after the limiter)
    // and the node is NOT wiped.
    expect((await panic(app, "panic-token-0123456789")).statusCode).toBe(404);
    expect(app.store.loadMessages().length).toBe(1);
  });

  it("answers 404 (never 429) even past the route-level rate limit", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });

    // The route allows 10/min; push well past it. Every rejection — including the route-level
    // rate-limit hit — must be a 404, so a 429 can never reveal that the panic route exists here.
    const codes: number[] = [];
    for (let attempt = 0; attempt < 13; attempt += 1) {
      codes.push((await panic(app, `wrong-${attempt}`)).statusCode);
    }
    expect(codes).not.toContain(429);
    expect(codes.every((code) => code === 404)).toBe(true);
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

  it("codes the participation-gate and channel-posting-policy errors (were English-only)", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const admin = await newSession(app);
    const pending = await newSession(app); // under approval policy, starts pending

    // A pending user hitting a mutating endpoint: the gate message now carries a code to localize.
    const gated = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie: pending.cookie },
    });
    expect(gated.statusCode).toBe(403);
    expect((gated.json() as { code?: string }).code).toBe("awaiting_approval");

    // Channel-posting policy: an admins-only channel rejects a member's post with a code.
    await app.server.inject({
      method: "POST",
      url: `/api/access/users/${pending.userId}/approve`,
      headers: { cookie: admin.cookie },
    });
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
      payload: { name: "Announce", allowPosting: "admins" },
    });
    const channelId = (created.json() as { id: string }).id;
    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: pending.cookie },
      payload: { type: "channelPost", channelId, body: "hi" },
    });
    expect(post.statusCode).toBe(400);
    expect((post.json() as { code?: string }).code).toBe("channel_admins_post_only");
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

    // Presence lists visible users only: a banned user is excluded. Bring Dana online, confirm she
    // shows, then have admin-Alice ban her — Alice's next presence event drops her.
    const dana = await newSession(app);
    const danaSocket = await connect(dana.cookie);
    expect(
      await waitUntil(() =>
        aliceSocket.events.some(
          (event) => event.type === "presence" && !!event.onlineUserIds?.includes(dana.userId),
        ),
      ),
    ).toBe(true);
    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${dana.userId}`,
      headers: { cookie: alice.cookie },
      payload: { banned: true },
    });
    expect(
      await waitUntil(() => {
        const last = [...aliceSocket.events].reverse().find((event) => event.type === "presence");
        return !!last && !last.onlineUserIds?.includes(dana.userId);
      }),
    ).toBe(true);
    danaSocket.socket.close();

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

describe("sync peer authentication (shared token)", () => {
  const TOKEN = "mesh-shared-secret-token-01";

  function digest(app: LoamApp, token?: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "GET",
      url: "/api/sync/digest",
      headers: token ? { "x-loam-sync-token": token } : {},
    });
  }

  it("serves the digest openly when no token is configured", async () => {
    const app = await makeApp({ sync: { enabled: true } });
    expect((await digest(app)).statusCode).toBe(200);
  });

  it("404s an unauthenticated or wrong-token peer, 200s the right token", async () => {
    const app = await makeApp({ sync: { enabled: true, token: TOKEN } });

    // Missing token and wrong token both look exactly like sync being disabled (404) — a prober
    // can't tell a token-guarded node from one without the feature.
    expect((await digest(app)).statusCode).toBe(404);
    expect((await digest(app, "not-the-token-xxxxxxxxxx")).statusCode).toBe(404);
    expect((await digest(app, TOKEN)).statusCode).toBe(200);
  });

  it("gates the messages endpoint on the same token", async () => {
    const app = await makeApp({ sync: { enabled: true, token: TOKEN } });

    const unauth = await app.server.inject({
      method: "POST",
      url: "/api/sync/messages",
      payload: { ids: ["message.unknown"] },
    });
    expect(unauth.statusCode).toBe(404);

    const authed = await app.server.inject({
      method: "POST",
      url: "/api/sync/messages",
      headers: { "x-loam-sync-token": TOKEN },
      payload: { ids: ["message.unknown"] },
    });
    expect(authed.statusCode).toBe(200);
    expect((authed.json() as { messages: unknown[] }).messages).toEqual([]);
  });

  it("clears the token when an admin PATCHes it to an empty string", async () => {
    const app = await makeApp({ sync: { enabled: true, token: TOKEN } });
    const admin = await newSession(app);

    // Confirmed guarded first.
    expect((await digest(app)).statusCode).toBe(404);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { token: "" } },
    });
    expect(patch.statusCode).toBe(200);

    // Token cleared → open again.
    expect((await digest(app)).statusCode).toBe(200);
  });

  it("attaches the configured token to outbound pulls (two-node end-to-end)", async () => {
    const meshToken = "mesh-shared-secret-token-02";

    // Peer node: token-guarded, offering one public channel + message.
    const peer = await makeApp({ sync: { enabled: true, token: meshToken } });
    const peerAdmin = await newSession(peer);
    const channel = (
      await peer.server.inject({
        method: "POST",
        url: "/api/channels",
        headers: { cookie: peerAdmin.cookie },
        payload: { name: "Mesh News" },
      })
    ).json() as { id: string };
    await peer.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: peerAdmin.cookie },
      payload: { type: "channelPost", channelId: channel.id, body: "hello from the peer" },
    });
    const peerUrl = await peer.server.listen({ host: "127.0.0.1", port: 0 });

    // A puller with the MATCHING token imports the peer's message — only possible if the pull loop
    // attached x-loam-sync-token (the peer 404s the digest otherwise).
    const puller = await makeApp({ sync: { enabled: true, token: meshToken, peers: [{ url: peerUrl }] } });
    const pullerAdmin = await newSession(puller);
    const run = await puller.server.inject({
      method: "POST",
      url: "/api/admin/sync/run",
      headers: { cookie: pullerAdmin.cookie },
    });
    expect(run.statusCode).toBe(200);
    const pulled = (
      await puller.server.inject({
        method: "GET",
        url: `/api/messages/${channel.id}`,
        headers: { cookie: pullerAdmin.cookie },
      })
    ).json() as { body: string }[];
    expect(pulled.some((message) => message.body === "hello from the peer")).toBe(true);

    // A puller with the WRONG token gets nothing — the peer really gates on the exact token, so the
    // channel is never imported and its messages 404 (existence is not leaked).
    const badPuller = await makeApp({
      sync: { enabled: true, token: "wrong-token-abcdefghij", peers: [{ url: peerUrl }] },
    });
    const badAdmin = await newSession(badPuller);
    await badPuller.server.inject({
      method: "POST",
      url: "/api/admin/sync/run",
      headers: { cookie: badAdmin.cookie },
    });
    const none = await badPuller.server.inject({
      method: "GET",
      url: `/api/messages/${channel.id}`,
      headers: { cookie: badAdmin.cookie },
    });
    expect(none.statusCode).toBe(404);
  });

  it("refuses to import messages attributed to a locally-authoritative identity (anti-impersonation)", async () => {
    const peer = await makeApp({ sync: { enabled: true } });
    const peerAdmin = await newSession(peer);
    const channel = (
      await peer.server.inject({
        method: "POST",
        url: "/api/channels",
        headers: { cookie: peerAdmin.cookie },
        payload: { name: "Mesh" },
      })
    ).json() as { id: string };
    const post = (body: string) =>
      peer.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: peerAdmin.cookie },
        payload: { type: "channelPost", channelId: channel.id, body },
      });
    await post("m1");
    const peerUrl = await peer.server.listen({ host: "127.0.0.1", port: 0 });

    const puller = await makeApp({ sync: { enabled: true, peers: [{ url: peerUrl }] } });
    const pullerAdmin = await newSession(puller);
    const sync = () =>
      puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });
    const bodies = async (): Promise<string[]> =>
      (
        (
          await puller.server.inject({
            method: "GET",
            url: `/api/messages/${channel.id}`,
            headers: { cookie: pullerAdmin.cookie },
          })
        ).json() as { body?: string }[]
      ).map((message) => message.body ?? "");

    // First sync imports m1 and creates a local (authority-stripped) copy of the peer's author.
    await sync();
    expect(await bodies()).toContain("m1");

    // Promote that imported identity to a LOCAL admin — its id is now locally authoritative.
    const promote = await puller.server.inject({
      method: "POST",
      url: `/api/admin/users/${peerAdmin.userId}/promote`,
      headers: { cookie: pullerAdmin.cookie },
    });
    expect(promote.statusCode).toBe(200);

    // A further message the peer serves under that same id is now refused — a peer can't inject
    // content that renders as authored by an identity this node treats as an authority.
    await post("m2");
    await sync();
    const seen = await bodies();
    expect(seen).toContain("m1"); // the pre-promotion import stays
    expect(seen).not.toContain("m2"); // the impersonating message is dropped
  });
});

describe("anonymous identity minting limit", () => {
  it("429s new identities from one IP past the cap but lets cookie'd requests through", async () => {
    const app = await makeApp(undefined, { maxNewIdentitiesPerWindow: 3 });

    const first = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(first.statusCode).toBe(200);
    const cookie = sessionCookie(first);

    // Two more fresh mints (count 2, 3) are allowed; the 4th cookieless request exceeds the cap.
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(429);

    // A request that carries an existing session cookie mints nothing, so it's unaffected.
    const returning = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie } });
    expect(returning.statusCode).toBe(200);
  });
});

describe("on-device LLM provider", () => {
  const BOT_ID = "llm.ollama.gemma4"; // shared bot identity, default botId

  afterEach(() => {
    delete (globalThis as { __loamOnDeviceChat?: unknown }).__loamOnDeviceChat;
  });

  async function assistantReply(app: LoamApp, cookie: string): Promise<string | undefined> {
    // The bot reply is created + streamed asynchronously after the DM POST returns; poll the thread.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const thread = (
        await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie } })
      ).json() as { authorId: string; body?: string }[];
      const reply = thread.find((message) => message.authorId === BOT_ID && (message.body ?? "").length > 0);
      if (reply) {
        return reply.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
  }

  it("streams a reply from the on-device hook, persists it, and shows the bot when enabled", async () => {
    (globalThis as { __loamOnDeviceChat?: unknown }).__loamOnDeviceChat = (
      _messages: unknown,
      callbacks: { onDelta: (t: string) => void; onEnd: () => void; onError: (m: string) => void },
    ) => {
      callbacks.onDelta("Hello ");
      callbacks.onDelta("from the phone");
      callbacks.onEnd();
    };

    const app = await makeApp({ llm: { onDevice: { enabled: true, model: "gemma-test" } } });
    const user = await newSession(app);

    // The bot DM contact appears once a backend is enabled (here: on-device, with Ollama still off).
    const users = (
      await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: user.cookie } })
    ).json() as { id: string; type: string }[];
    expect(users.some((entry) => entry.id === BOT_ID && entry.type === "bot")).toBe(true);

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });
    expect(dm.statusCode).toBe(201);

    expect(await assistantReply(app, user.cookie)).toBe("Hello from the phone");
  });

  it("degrades to a graceful error when no on-device hook is present (e.g. desktop/CI)", async () => {
    // No globalThis.__loamOnDeviceChat installed — every non-Android host.
    const app = await makeApp({ llm: { onDevice: { enabled: true, model: "gemma-test" } } });
    const user = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });

    const reply = await assistantReply(app, user.cookie);
    expect(reply).toMatch(/LLM error/i);
    expect(reply).toMatch(/not available/i);
  });

  it("keeps the bot hidden and does not respond when no backend is enabled (default)", async () => {
    const app = await makeApp();
    const user = await newSession(app);

    const users = (
      await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: user.cookie } })
    ).json() as { id: string }[];
    expect(users.some((entry) => entry.id === BOT_ID)).toBe(false);
  });
});

describe("opportunistic mesh: sealed mailbox (docs/16)", () => {
  const MESH = { enabled: true, relay: true, ttlMs: 3_600_000, hopLimit: 6, maxCarried: 1000, maxContacts: 1000 };

  function listen(app: LoamApp): Promise<string> {
    return app.server.listen({ host: "127.0.0.1", port: 0 });
  }
  async function adminOf(app: LoamApp): Promise<{ cookie: string; userId: string }> {
    const session = await newSession(app);
    return { cookie: session.cookie, userId: session.userId };
  }
  function setPeers(app: LoamApp, cookie: string, urls: string[]): Promise<InjectResponse> {
    return app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { sync: { peers: urls.map((url) => ({ url })) } },
    });
  }
  function syncNow(app: LoamApp, cookie: string): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  }
  async function roster(app: LoamApp, cookie: string): Promise<{ id: string }[]> {
    return (await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie } })).json() as {
      id: string;
    }[];
  }
  async function dmBodies(app: LoamApp, cookie: string, peerId: string): Promise<string[]> {
    return (
      (
        await app.server.inject({ method: "GET", url: `/api/dms/${peerId}`, headers: { cookie } })
      ).json() as { body?: string }[]
    ).map((message) => message.body ?? "");
  }
  /** Fetch a user's shareable mesh identity card (the out-of-band contact exchange). */
  async function meshCard(app: LoamApp, cookie: string): Promise<MeshIdentityCard> {
    const res = await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return MeshIdentityCardSchema.parse(res.json());
  }
  /** Add a mesh card to the caller's address book (POST /api/mesh/contacts). */
  function addContact(app: LoamApp, cookie: string, card: MeshIdentityCard): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/mesh/contacts", headers: { cookie }, payload: card });
  }

  it("404s /api/mesh/messages when mesh is disabled", async () => {
    const app = await makeApp();
    const user = await newSession(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: user.cookie },
      payload: { toMeshId: "mesh.absent", body: "hi" },
    });
    expect(res.statusCode).toBe(404);
    // The whole mesh surface is absent when disabled — identity + contacts too.
    expect((await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie: user.cookie } })).statusCode).toBe(404);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/mesh/contacts",
          headers: { cookie: user.cookie },
          payload: { meshId: "mesh.absent", alg: "ed25519", sign: "AA", kx: "AA", kxSig: "AA", mailboxToken: "AA" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("delivers sealed mail to a contact as a DM (card exchange + seal + open on one node)", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app); // both get mesh identities via the session hook

    // Alice adds Bob out-of-band (his card), then seals to his self-certifying mesh id.
    const bobCard = await meshCard(app, bob.cookie);
    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);

    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "meet at the old bridge" },
    });
    expect(send.statusCode).toBe(200);

    // Delivery creates a "mesh.<sender>" contact and a DM to Bob from it.
    const contact = (await roster(app, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
    expect(contact).toBeDefined();
    expect(await dmBodies(app, bob.cookie, contact!.id)).toContain("meet at the old bridge");
  });

  it("keeps a mesh sender off the shared roster — visible only to the recipient it mailed", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const carol = await newSession(app); // uninvolved third party on the same node

    const bobCard = await meshCard(app, bob.cookie);
    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/mesh/messages",
          headers: { cookie: alice.cookie },
          payload: { toMeshId: bobCard.meshId, body: "quiet word" },
        })
      ).statusCode,
    ).toBe(200);

    // Bob (the recipient) resolves the mesh sender in his roster...
    expect((await roster(app, bob.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(true);
    // ...but Carol never learns a mesh sender appeared (no leak that Bob received sealed mail).
    expect((await roster(app, carol.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
  });

  it("404s a send to a mesh id that isn't a contact (sealing requires an added card)", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);
    // Alice never added Bob → cannot seal to him even though his id self-certifies.
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "hi" },
    });
    expect(send.statusCode).toBe(404);
  });

  it("rejects a forged mesh card (id/key mismatch and bad kx binding) so it can't be sealed to", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const mallory = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);
    const malloryCard = await meshCard(app, mallory.cookie);

    // Substitution attempt: Bob's id but Mallory's keys — meshId no longer derives from `sign`.
    const forgedId = { ...malloryCard, meshId: bobCard.meshId };
    expect((await addContact(app, alice.cookie, forgedId)).statusCode).toBe(400);

    // Tampered binding: valid id/sign, but kx swapped for Mallory's (kxSig no longer binds).
    const forgedKx = { ...bobCard, kx: malloryCard.kx };
    expect((await addContact(app, alice.cookie, forgedKx)).statusCode).toBe(400);

    // Neither forgery was stored, so a send to Bob's id 404s (no contact).
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "hijack" },
    });
    expect(send.statusCode).toBe(404);
  });

  it("rejects a malformed mesh card (non-base64url key field) with 400, never a 500", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);

    // A garbage `sign`/`mailboxToken` would otherwise reach the crypto's base64url decoder (which
    // throws) — the schema must reject it at the boundary as a clean 400.
    for (const bad of [
      { ...bobCard, sign: "!!!not-base64!!!" },
      { ...bobCard, mailboxToken: "has spaces" },
    ]) {
      expect((await addContact(app, alice.cookie, bad)).statusCode).toBe(400);
    }
    // And no forged card was stored, so a later send to Bob's id still 404s (no 500 anywhere).
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "hi" },
    });
    expect(send.statusCode).toBe(404);
  });

  it("caps the mesh address book at mesh.maxContacts (new ids blocked, refreshes allowed)", async () => {
    const app = await makeApp({ mesh: { ...MESH, maxContacts: 1 } });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const mallory = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);
    const malloryCard = await meshCard(app, mallory.cookie);

    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);
    // A second DISTINCT contact exceeds the cap of 1.
    expect((await addContact(app, alice.cookie, malloryCard)).statusCode).toBe(400);
    // Re-adding an existing contact (a key/name refresh) is still allowed at the cap.
    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);
  });

  it("silently drops a shadow-banned sender's sealed mail (200, but nothing delivered)", async () => {
    const app = await makeApp({ mesh: MESH });
    const admin = await newSession(app); // firstUser → admin (can moderate)
    const spammer = await newSession(app);
    const bob = await newSession(app);

    const bobCard = await meshCard(app, bob.cookie);
    expect((await addContact(app, spammer.cookie, bobCard)).statusCode).toBe(200);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${spammer.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    // The send looks successful to the shadow-banned sender...
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: spammer.cookie },
      payload: { toMeshId: bobCard.meshId, body: "spam spam spam" },
    });
    expect(send.statusCode).toBe(200);

    // ...but nothing was sealed or delivered — Bob has no mesh contact / DM.
    expect((await roster(app, bob.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
  });

  it("carries A→C→B: an intermediary relays sealed mail it cannot read", async () => {
    const nodeA = await makeApp({ sync: { enabled: true }, mesh: MESH });
    const nodeB = await makeApp({ sync: { enabled: true }, mesh: MESH });
    const nodeC = await makeApp({ sync: { enabled: true }, mesh: MESH });
    const aAdmin = await adminOf(nodeA);
    const bob = await adminOf(nodeB); // Bob is node B's real (admin) session user, not a seed
    const cAdmin = await adminOf(nodeC);

    const [aUrl, bUrl, cUrl] = await Promise.all([listen(nodeA), listen(nodeB), listen(nodeC)]);
    // Pull topology: C carries from A; B receives from C — A and B never meet directly.
    expect((await setPeers(nodeA, aAdmin.cookie, [bUrl])).statusCode).toBe(200);
    expect((await setPeers(nodeC, cAdmin.cookie, [aUrl])).statusCode).toBe(200);
    expect((await setPeers(nodeB, bob.cookie, [cUrl])).statusCode).toBe(200);

    // Alice and Bob exchange cards out-of-band (no reliance on public-post sync); Alice adds Bob.
    const bobCard = await meshCard(nodeB, bob.cookie);
    expect((await addContact(nodeA, aAdmin.cookie, bobCard)).statusCode).toBe(200);

    // Alice (node A) seals a message to Bob's mesh id.
    const send = await nodeA.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: aAdmin.cookie },
      payload: { toMeshId: bobCard.meshId, body: "the rendezvous is at dawn" },
    });
    expect(send.statusCode).toBe(200);

    await syncNow(nodeC, cAdmin.cookie); // C carries the sealed blob from A (cannot open it)
    await syncNow(nodeB, bob.cookie); // B pulls from C, recognises the tag, decrypts, delivers

    // Bob received the plaintext.
    const contact = (await roster(nodeB, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
    expect(contact).toBeDefined();
    expect(await dmBodies(nodeB, bob.cookie, contact!.id)).toContain("the rendezvous is at dawn");

    // The carrier C holds the sealed blob but never learned the plaintext — no DM anywhere on C
    // contains the secret, and its stored copy is opaque ciphertext.
    const cMessages = (
      await nodeC.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: cAdmin.cookie } })
    ).json() as { body?: string }[];
    expect(cMessages.some((m) => (m.body ?? "").includes("dawn"))).toBe(false);
    // C carried it: its store holds a sealed-type message whose serialized form doesn't contain the plaintext.
    const cStored = nodeC.store.loadMessages();
    const sealed = cStored.find((m) => m.type === "sealed");
    expect(sealed).toBeDefined();
    expect(JSON.stringify(sealed)).not.toContain("dawn");

    // Metadata privacy: the routing tag is derived from Bob's SECRET mailbox token, not his public kx —
    // so a carrier holding only public key material (as v1 leaked) cannot recompute it. The sealer
    // stamped `ttlExpiresAt = sendTime + ttlMs`, so we recover the exact send-time epoch.
    const sealedMsg = sealed as { ttlExpiresAt: number; toTag: string };
    const epoch = currentEpoch(sealedMsg.ttlExpiresAt - MESH.ttlMs, 24 * 3_600_000);
    expect(sealedMsg.toTag).toBe(mailboxTag(bobCard.mailboxToken, epoch));
    expect(sealedMsg.toTag).not.toBe(mailboxTag(bobCard.kx, epoch));
  });
});

describe("deploy hardening (docs/15)", () => {
  it("ends the caller's session so the next request mints a fresh identity (#4)", async () => {
    const app = await makeApp();
    const user = await newSession(app);

    const end = await app.server.inject({
      method: "POST",
      url: "/api/session/end",
      headers: { cookie: user.cookie },
    });
    expect(end.statusCode).toBe(200);
    // The Set-Cookie clears the session cookie (Max-Age=0).
    expect(String(end.headers["set-cookie"])).toContain("Max-Age=0");

    // Reusing the now-invalidated cookie mints a brand-new identity rather than the wiped one.
    const after = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: user.cookie } });
    const newId = (after.json() as { currentUser: { id: string } }).currentUser.id;
    expect(newId).not.toBe(user.userId);
  });

  it("session/end is a safe no-op on an absent/unknown cookie and never mints a session (#4)", async () => {
    const app = await makeApp();
    const usersBefore = app.store.loadUsers().length;

    // No cookie at all.
    const none = await app.server.inject({ method: "POST", url: "/api/session/end" });
    expect(none.statusCode).toBe(200);
    // An unknown token.
    const unknown = await app.server.inject({
      method: "POST",
      url: "/api/session/end",
      headers: { cookie: "loam_session=deadbeef" },
    });
    expect(unknown.statusCode).toBe(200);

    // Crucially, ending a session must not itself create an identity.
    expect(app.store.loadUsers().length).toBe(usersBefore);
  });

  it("mints a setup code when a PATCH switches bootstrap into setupCode, enabling claims (#8)", async () => {
    const app = await makeApp(); // firstUser bootstrap: the first session becomes admin
    const admin = await newSession(app);

    const before = (
      await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
    ).json() as { networkConfig: { allowAdminClaim: boolean } };
    expect(before.networkConfig.allowAdminClaim).toBe(false);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { admin: { bootstrap: "setupCode" } },
    });
    expect(patch.statusCode).toBe(200);

    const after = (
      await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })
    ).json() as { networkConfig: { allowAdminClaim: boolean } };
    expect(after.networkConfig.allowAdminClaim).toBe(true);
    expect(app.getAdminSetupCode()).toBeTruthy(); // a usable single-use code was actually minted
  });

  it("clears the setup code when bootstrap switches away, re-minting a fresh one on switching back (#8)", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const setBootstrap = (bootstrap: string) =>
      app.server.inject({
        method: "PATCH",
        url: "/api/admin/config",
        headers: { cookie: admin.cookie },
        payload: { admin: { bootstrap } },
      });

    await setBootstrap("setupCode");
    const code1 = app.getAdminSetupCode();
    expect(code1).toBeTruthy();

    // Switching away invalidates the outstanding code immediately.
    await setBootstrap("firstUser");
    expect(app.getAdminSetupCode()).toBeUndefined();

    // Switching back mints a FRESH code, not the abandoned one.
    await setBootstrap("setupCode");
    expect(app.getAdminSetupCode()).toBeTruthy();
    expect(app.getAdminSetupCode()).not.toBe(code1);
  });

  it("prunes peerSyncStatus when a peer is removed via config PATCH (#9)", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://peer-a.invalid" }] } });
    const admin = await newSession(app);

    // Force a sync attempt so the peer gets a live status entry, then confirm it's reported.
    await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: admin.cookie } });
    const before = (
      await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie: admin.cookie } })
    ).json() as { peers: { url: string; status?: unknown }[] };
    expect(before.peers.some((peer) => peer.url === "http://peer-a.invalid" && peer.status)).toBe(true);

    // Remove the peer; its status must be pruned, not linger.
    await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { peers: [] } },
    });
    const after = (
      await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie: admin.cookie } })
    ).json() as { peers: { url: string }[] };
    expect(after.peers.some((peer) => peer.url === "http://peer-a.invalid")).toBe(false);

    // Re-adding the same peer creates a fresh status entry — the prune cleared the slot, it didn't
    // just filter the report.
    await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { peers: [{ url: "http://peer-a.invalid" }] } },
    });
    await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: admin.cookie } });
    const readded = (
      await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie: admin.cookie } })
    ).json() as { peers: { url: string; status?: unknown }[] };
    expect(readded.peers.some((peer) => peer.url === "http://peer-a.invalid" && peer.status)).toBe(true);
  });
});
