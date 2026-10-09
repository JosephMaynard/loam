import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import {
  claim,
  cleanups,
  type InjectResponse,
  makeApp,
  newSession,
  openTransport08,
  reopenApp,
  resumeIdentity,
  teardownApps,
  tunnelInner,
} from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("admin bootstrap", () => {
  it("firstUser (default): the first session becomes admin, later ones do not", async () => {
    const app = await makeApp();

    const first = await newSession(app);
    expect(first.isAdmin).toBe(true);

    const second = await newSession(app);
    expect(second.isAdmin).toBe(false);
  });

  it("removes legacy demo seed users so a live node ships no fake contacts and bootstrap governs admin", async () => {
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
        {
          id: "user_reactor",
          displayName: "Reactor",
          type: "human",
          isAdmin: false,
          createdAt: 1_704_067_200_000,
          ephemeral: true,
        },
      ]),
    );
    // A DM from the demo user, plus a reaction ON it authored by a real user — the reaction must be
    // cascaded away with its target (no orphan reaction pointing at a deleted message).
    writeFileSync(
      join(dataDir, "messages.json"),
      JSON.stringify([
        {
          id: "msg_demo1",
          type: "dm",
          authorId: "user.1234",
          recipientUserId: "user_reactor",
          body: "hello",
          createdAt: 1_704_067_200_000,
        },
        {
          id: "msg_react1",
          type: "reaction",
          authorId: "user_reactor",
          targetMessageId: "msg_demo1",
          reaction: "👍",
          createdAt: 1_704_067_200_001,
        },
      ]),
    );

    const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    // The legacy demo user is GONE (a fresh node never seeds it, and a pre-existing DB is cleaned at boot),
    // so it can't clutter the DM list or hold admin.
    const users = app.store.loadUsers();
    expect(users.find((user) => user.id === "user.1234")).toBeUndefined();
    // The real reactor survives — only the demo user is purged.
    expect(users.find((user) => user.id === "user_reactor")).toBeDefined();

    // The demo user's message AND the reaction targeting it are both gone (no orphan reaction).
    const messages = app.store.loadMessages();
    expect(messages.find((message) => message.id === "msg_demo1")).toBeUndefined();
    expect(messages.find((message) => message.id === "msg_react1")).toBeUndefined();

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

describe("admin claim under access.joinPolicy approval", () => {
  async function expectActiveAdmin(app: LoamApp, cookie: string): Promise<void> {
    const config = (await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie } })).json() as {
      currentUser: { isAdmin: boolean; pending?: boolean };
    };
    expect(config.currentUser.isAdmin).toBe(true);
    expect(config.currentUser.pending).not.toBe(true);
    // Not locked out: the participation-gated roster and the approval queue both answer.
    expect((await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/access/pending", headers: { cookie } })).statusCode).toBe(200);
  }

  it("setupCode: the claimer becomes an ACTIVE admin (pending cleared, persisted)", async () => {
    const { app, dataDir } = await makeApp({ admin: { bootstrap: "setupCode" }, access: { joinPolicy: "approval" } });
    const session = await newSession(app);
    const code = app.getAdminSetupCode();
    expect(code).toBeDefined();
    expect((await claim(app, session.cookie, code as string)).statusCode).toBe(200);
    await expectActiveAdmin(app, session.cookie);

    const reopened = await reopenApp(app, dataDir);
    const stored = reopened.store.loadUsers().find((user) => user.id === session.userId);
    expect(stored?.isAdmin).toBe(true);
    expect(stored?.pending).not.toBe(true);
  });

  it("passphrase: the claimer becomes an ACTIVE admin", async () => {
    const app = await makeApp({
      admin: { bootstrap: "passphrase", passphrase: "correct horse battery" },
      access: { joinPolicy: "approval" },
    });
    const session = await newSession(app);
    expect((await claim(app, session.cookie, "correct horse battery")).statusCode).toBe(200);
    await expectActiveAdmin(app, session.cookie);
  });

  it("hostDevice: the host's claim becomes an ACTIVE admin", async () => {
    const hostToken = "h".repeat(43);
    const app = await makeApp({ access: { joinPolicy: "approval" } }, { hostToken });
    const session = await newSession(app);
    expect(session.isAdmin).toBe(false);
    expect((await claim(app, session.cookie, hostToken)).statusCode).toBe(200);
    await expectActiveAdmin(app, session.cookie);
  });
});

describe("host-device admin bootstrap", () => {
  const HOST_TOKEN = "host-token-for-tests-0123456789abcdefghijklmn";

  it("hostDevice: with a launcher host token no LAN session becomes admin, and only the token claims", async () => {
    const app = await makeApp(undefined, { hostToken: HOST_TOKEN });
    const first = await newSession(app);
    expect(first.isAdmin).toBe(false);
    const second = await newSession(app);
    expect(second.isAdmin).toBe(false);

    const config = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: first.cookie } });
    expect((config.json() as { networkConfig: { allowAdminClaim: boolean } }).networkConfig.allowAdminClaim).toBe(false);

    const claim = (cookie: string, secret: string) =>
      app.server.inject({ method: "POST", url: "/api/admin/claim", headers: { cookie }, payload: { secret } });
    expect((await claim(first.cookie, "not-the-token")).statusCode).toBe(403);
    const promoted = await claim(first.cookie, HOST_TOKEN);
    expect(promoted.statusCode).toBe(200);
    expect((promoted.json() as { isAdmin: boolean }).isAdmin).toBe(true);

    // A read-time projection: the persisted strategy is untouched (the same data dir booted without a
    // token on a desktop resolves to it), and a plain session still can't claim.
    const adminConfig = await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: first.cookie } });
    expect((adminConfig.json() as { admin: { bootstrap: string } }).admin.bootstrap).toBe("firstUser");
    expect((await claim(second.cookie, "guess")).statusCode).toBe(403);
  });
});

describe("host-device admin bootstrap: the claim budget and setup codes", () => {
  const HOST_TOKEN = "host-token-round-two-0123456789abcdefghijklmnop";

  function claim(app: LoamApp, cookie: string, secret: string): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/admin/claim", headers: { cookie }, payload: { secret } });
  }

  it("hostDevice: the CORRECT host token is honoured even after the per-IP attempt budget is spent on wrong guesses", async () => {
    const app = await makeApp(undefined, { hostToken: HOST_TOKEN });
    const host = await newSession(app);
    // A co-located app (same loopback IP) burns the semantic attempt budget (5 per 5 min) with guesses.
    for (let i = 0; i < 5; i += 1) {
      expect((await claim(app, host.cookie, `guess-${i}`)).statusCode).toBe(403);
    }
    expect((await claim(app, host.cookie, "guess-6")).statusCode).toBe(429);
    // The host's own claim with the real token still succeeds — a 256-bit token can't be guessed, so the
    // limiter has nothing to protect there, and a hostDevice node has no other way to gain an admin.
    const promoted = await claim(app, host.cookie, HOST_TOKEN);
    expect(promoted.statusCode).toBe(200);
    expect((promoted.json() as { isAdmin: boolean }).isAdmin).toBe(true);
  });

  it("counts claim guesses per IPv6 /64, so a guesser cycling addresses gets no more tries", async () => {
    const app = await makeApp(undefined, { hostToken: HOST_TOKEN });
    const guesser = await newSession(app);
    const from = (remoteAddress: string, secret: string) =>
      app.server.inject({ method: "POST", url: "/api/admin/claim", headers: { cookie: guesser.cookie }, payload: { secret }, remoteAddress });
    for (let host = 1; host <= 5; host += 1) {
      expect((await from(`2001:db8:5:6::${host}`, `guess-${host}`)).statusCode).toBe(403);
    }
    expect((await from("2001:db8:5:6::99", "guess-6")).statusCode).toBe(429);
    expect((await from("2001:db8:5:7::1", "guess-7")).statusCode).toBe(403); // another /64 is another host
  });

  it("hostDevice CONFIGURED on a node with no launcher token behaves like `none` and never touches the limiter", async () => {
    const app = await makeApp({ admin: { bootstrap: "hostDevice" } });
    const user = await newSession(app);
    expect(user.isAdmin).toBe(false);
    const response = await claim(app, user.cookie, "anything");
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: string }).error).toBe("Admin claiming is not enabled on this LOAM node");
    expect(app.rateLimiterEntryCounts().claim).toBe(0);
  });

  it("a host-token node that PATCHes admin.bootstrap to setupCode saves the intent but mints no unusable code", async () => {
    const app = await makeApp(undefined, { hostToken: HOST_TOKEN });
    const host = await newSession(app);
    expect((await claim(app, host.cookie, HOST_TOKEN)).statusCode).toBe(200);
    const patched = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: host.cookie },
      payload: { admin: { bootstrap: "setupCode" } },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { admin: { bootstrap: string } }).admin.bootstrap).toBe("setupCode"); // persisted intent
    expect(app.getAdminSetupCode()).toBeUndefined(); // nothing minted/logged — it could never be claimed here
    const config = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: host.cookie } });
    expect((config.json() as { networkConfig: { allowAdminClaim: boolean } }).networkConfig.allowAdminClaim).toBe(false);
  });
});

describe("setup code follows the bootstrap strategy", () => {
  it("mints a setup code when a PATCH switches bootstrap into setupCode, enabling claims", async () => {
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

  it("clears the setup code when bootstrap switches away, re-minting a fresh one on switching back", async () => {
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

  it("defaults dbEncryption to off and reflects a PATCHed value in /api/config when the store is actually keyed, independent of the security profile", async () => {
    // `networkConfig.dbEncryption` reports the EFFECTIVE posture, not the merely-configured
    // value — so this round-trip only shows the PATCHed value while a real key is active. The `off` →
    // false-report case (no real key) is covered separately below.
    const app = await makeApp(undefined, { dbEncryptionKey: "a fixed host passphrase" });
    const admin = await newSession(app);

    const before = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string };
    };
    expect(before.networkConfig.dbEncryption).toBe("off");

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { dbEncryption: "ephemeral" } },
    });
    expect(patch.statusCode).toBe(200);

    const after = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string; securityProfile: string };
    };
    expect(after.networkConfig.dbEncryption).toBe("ephemeral");
    // dbEncryption is not one of the axes a named profile forces (only transportEncryption /
    // joinPolicy / messageTtlMs / killSwitch are), so switching profiles must not clobber it.
    expect(after.networkConfig.securityProfile).toBe("custom");

    const rejected = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { dbEncryption: "hardware-hsm" } },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("reports the EFFECTIVE dbEncryption posture (off) when no real key is active, even after PATCHing a non-off value", async () => {
    // No dbEncryptionKey/ephemeralDbKey passed — the store is genuinely unencrypted, whatever the
    // config says. `security.dbEncryption` is a declarative admin setting decoupled from the real key
    // (see the comment on `encryptionEnabled` in app.ts); the wire must never claim encryption that
    // isn't active.
    const app = await makeApp();
    const admin = await newSession(app);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { security: { dbEncryption: "persistent" } },
    });
    expect(patch.statusCode).toBe(200);

    const after = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string };
    };
    expect(after.networkConfig.dbEncryption).toBe("off");

    // The admin config view (the raw, redacted config) still reflects what was actually configured —
    // only the client-facing networkConfig is truthed up to the effective posture.
    const adminConfig = (await app.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
    })).json() as { security: { dbEncryption: string } };
    expect(adminConfig.security.dbEncryption).toBe("persistent");
  });

  it("applies, enforces, broadcasts shape, and persists feature flag changes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const initialApp = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
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

describe("config robustness", () => {
  it("ABORTS startup when the config file is malformed JSON (never falls back to defaults)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    writeFileSync(join(dataDir, "config.json"), "{ this is not json");
    // A present-but-invalid config must fail closed: silently starting from defaults could downgrade an
    // intended `required` posture to `off` (docs/08). The operator must fix or remove the file.
    await expect(buildApp({ requireRulesAcceptance: false, dataDir, logger: false })).rejects.toThrow(/Invalid configuration/);
  });

  it("ABORTS startup when the persisted config row is malformed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const initialApp = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
    initialApp.store.setConfigValue("config", "{ broken");
    await initialApp.close();

    await expect(buildApp({ requireRulesAcceptance: false, dataDir, logger: false })).rejects.toThrow(/Invalid configuration/);
  });

  it("ABORTS startup when the persisted config row is present but EMPTY (not silently skipped)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const initialApp = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
    initialApp.store.setConfigValue("config", ""); // a corrupt/empty row is present, not absent
    await initialApp.close();

    await expect(buildApp({ requireRulesAcceptance: false, dataDir, logger: false })).rejects.toThrow(/Invalid configuration/);
  });

  it("ABORTS rather than silently serving `off` when a required-mode config has an invalid field", async () => {
    // The exact footgun: a `required` node whose `sync.token` is under the 16-char minimum invalidates the
    // whole document. It must NOT boot advertising `off` — it must refuse to start.
    const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ security: { transportEncryption: "required" }, sync: { enabled: true, token: "short" } }),
    );
    await expect(buildApp({ requireRulesAcceptance: false, dataDir, logger: false })).rejects.toThrow(/Invalid configuration/);
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

  it("hardened forces its coherent bundle: approval join, ephemeral TTL, armed kill switch, encryption", async () => {
    const app = await makeApp({ security: { profile: "hardened" } });

    // `hardened` forces `required` transport, so there is no cookie identity: the first client binds a
    // secure identity over the sealed channel (docs/20) and, being first, becomes the `firstUser` admin.
    // The public bootstrap advertises the forced axes cookie-free.
    const network = (
      await app.server.inject({ method: "GET", url: "/api/bootstrap" })
    ).json() as { networkConfig: { joinPolicy: string; securityProfile: string; transportEncryption: string } };
    expect(network.networkConfig.securityProfile).toBe("hardened");
    expect(network.networkConfig.joinPolicy).toBe("approval");
    expect(network.networkConfig.transportEncryption).toBe("required");

    const session = await openTransport08(app);
    const bound = await resumeIdentity(app, session, 1);
    expect(bound.status).toBe(200);
    expect(bound.currentUser.isAdmin).toBe(true); // first user under the secure model → firstUser admin

    // The admin config is content — under `required` it is reachable ONLY through the tunnel, and the
    // bound session (not a cookie) authorises it.
    const inner = await tunnelInner(app, session, 2, { m: "GET", p: "/api/admin/config" });
    expect(inner.status).toBe(200);
    const full = JSON.parse(inner.body.toString("utf8")) as {
      access: { joinPolicy: string };
      retention: { messageTtlMs: number };
      killSwitch: { enabled: boolean };
    };
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

describe("join address resolution", () => {
  it("re-resolves the join host on every request when no explicit joinHost is configured", async () => {
    let currentAddress = "10.0.0.1";
    const { app } = await makeApp(undefined, { resolveLanAddress: () => currentAddress });

    const first = (await app.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as { joinUrl: string };
    expect(first.joinUrl).toContain("10.0.0.1");

    // Simulate the Android hotspot interface coming up (or changing) after boot — a later request
    // must reflect it, not whatever was resolved when the process started.
    currentAddress = "192.168.49.1";

    const second = (await app.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as { joinUrl: string };
    expect(second.joinUrl).toContain("192.168.49.1");
    expect(second.joinUrl).not.toContain("10.0.0.1");

    // /api/config (used post-hydration) resolves the same live way.
    const config = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as { joinUrl: string };
    expect(config.joinUrl).toContain("192.168.49.1");
  });

  it("an explicit joinHost wins outright and is never re-resolved (desktop/Pi: the boot address is fine)", async () => {
    const { app } = await makeApp(undefined, {
      joinHost: "pinned.example",
      resolveLanAddress: () => "should-never-be-used",
    });

    const response = (await app.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as { joinUrl: string };
    expect(response.joinUrl).toContain("pinned.example");
    expect(response.joinUrl).not.toContain("should-never-be-used");
  });
});

describe("network settings, admin promotion and presence", () => {
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
    const versioned = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, version: "9.9.9" });
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
      llm: { ollama: { enabled: true, baseUrl: "http://localhost:11434", model: "m", botId: "llm.bot.test", botDisplayName: "Bot" } },
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
      url: "/api/admin/users/llm.bot.test/promote",
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
