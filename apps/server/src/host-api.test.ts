import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAdminClaimCodes, ADMIN_CLAIM_CODE_TTL_MS, MAX_ADMIN_CLAIM_CODES } from "./admin-links.js";
import { buildApp, type AppOptions, type LoamApp } from "./app.js";

/**
 * The in-process host API (`LoamApp.host`, host-api.ts) the `loamnet` terminal UI drives, and the one-time
 * admin claim codes (admin-links.ts) behind its "open as admin" link.
 */

const HOST_TOKEN = "host-api-test-host-token-0123456789abcdef";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function makeApp(config?: unknown, opts: Partial<AppOptions> = {}): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-host-api-test-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({
    dataDir,
    logger: false,
    maxNewIdentitiesPerWindow: 1_000_000,
    hostToken: HOST_TOKEN,
    version: "9.9.9",
    ...opts,
  });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

type Session = { cookie: string; user: { id: string; isAdmin: boolean; pending?: boolean }; joinUrl: string };

async function session(app: LoamApp, cookie?: string): Promise<Session> {
  const response = await app.server.inject({ method: "GET", url: "/api/config", headers: cookie ? { cookie } : {} });
  const setCookie = response.headers["set-cookie"];
  const fresh = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  const body = response.json() as { currentUser: Session["user"]; joinUrl: string };
  return { cookie: cookie ?? fresh!, user: body.currentUser, joinUrl: body.joinUrl };
}

function claim(app: LoamApp, cookie: string, secret: string) {
  return app.server.inject({ method: "POST", url: "/api/admin/claim", headers: { cookie }, payload: { secret } });
}

describe("admin claim codes", () => {
  it("are single-use, expire, and keep only the newest few", () => {
    let now = 1_000;
    const codes = createAdminClaimCodes(() => now);

    const first = codes.mint();
    expect(first.expiresAt).toBe(1_000 + ADMIN_CLAIM_CODE_TTL_MS);
    expect(codes.consume(first.code)).toBe(true);
    expect(codes.consume(first.code)).toBe(false);

    const expiring = codes.mint();
    now += ADMIN_CLAIM_CODE_TTL_MS;
    expect(codes.consume(expiring.code)).toBe(false);

    const minted = Array.from({ length: MAX_ADMIN_CLAIM_CODES + 1 }, () => codes.mint());
    expect(codes.consume(minted[0]!.code)).toBe(false);
    expect(codes.consume(minted.at(-1)!.code)).toBe(true);

    expect(codes.consume("not a code")).toBe(false);
    const cleared = codes.mint();
    codes.clear();
    expect(codes.consume(cleared.code)).toBe(false);
  });

  it("make the presenting session an admin once, with a host token, and nobody becomes admin by being first", async () => {
    const app = await makeApp();
    const first = await session(app);
    expect(first.user.isAdmin).toBe(false);

    const { code } = app.host.adminClaimCode()!;
    const claimed = await claim(app, first.cookie, code);
    expect(claimed.statusCode).toBe(200);
    expect((claimed.json() as { isAdmin: boolean }).isAdmin).toBe(true);

    const second = await session(app);
    expect((await claim(app, second.cookie, code)).statusCode).toBe(403);
  });

  it("aren't minted on a node without a host token, and are forgotten by an Emergency Reset", async () => {
    const plain = await makeApp(undefined, { hostToken: undefined });
    expect(plain.host.adminClaimCode()).toBeNull();

    const app = await makeApp({ killSwitch: { enabled: true } });
    const { code } = app.host.adminClaimCode()!;
    expect((await app.host.emergencyReset()).complete).toBe(true);
    const after = await session(app);
    expect((await claim(app, after.cookie, code)).statusCode).toBe(403);
  });
});

describe("admin claim codes and who presents them", () => {
  it("can't make a banned person admin, and aren't spent trying", async () => {
    const app = await makeApp();
    const admin = await session(app);
    await claim(app, admin.cookie, app.host.adminClaimCode()!.code);
    const banned = await session(app);
    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${banned.user.id}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const { code } = app.host.adminClaimCode()!;
    expect((await claim(app, banned.cookie, code)).statusCode).toBe(403);
    const other = await session(app);
    expect((await claim(app, other.cookie, code)).statusCode).toBe(200);
  });

  it("are spent by a browser that was already admin, so nobody else can use them", async () => {
    const app = await makeApp();
    const admin = await session(app);
    await claim(app, admin.cookie, app.host.adminClaimCode()!.code);

    const { code } = app.host.adminClaimCode()!;
    expect((await claim(app, admin.cookie, code)).statusCode).toBe(200);
    const other = await session(app);
    expect((await claim(app, other.cookie, code)).statusCode).toBe(403);
  });

  it("can be revoked by the screen that showed them", async () => {
    const app = await makeApp();
    const { code } = app.host.adminClaimCode()!;
    app.host.revokeAdminClaimCode(code);
    const someone = await session(app);
    expect((await claim(app, someone.cookie, code)).statusCode).toBe(403);
  });

  it("make a waiting person an approved admin", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const waiting = await session(app);
    expect(waiting.user.pending).toBe(true);
    const claimed = await claim(app, waiting.cookie, app.host.adminClaimCode()!.code);
    expect(claimed.json()).toMatchObject({ isAdmin: true, pending: false });
  });
});

describe("LoamApp.host", () => {
  it("reports the node's status", async () => {
    const app = await makeApp({ node: { name: "Field kitchen" } });
    await session(app);
    await session(app);

    const status = app.host.status();
    expect(status).toMatchObject({
      nodeName: "Field kitchen",
      version: "9.9.9",
      transportEncryption: "optional",
      dbEncryption: "off",
      joinPolicy: "open",
      devMode: false,
      // inject() connects no sockets, and a loopback peer would never count anyway.
      clients: [],
      people: { total: 2, online: 0, pending: 0, admins: 0 },
      quarantined: 0,
      logLevel: "info",
      resets: 0,
      resetting: false,
    });
  });

  it("counts Emergency Resets and deletes the diagnostics files the screen wrote", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-host-api-test-"));
    const app = await buildApp({ dataDir, logger: false, hostToken: HOST_TOKEN, maxNewIdentitiesPerWindow: 1_000_000 });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    const report = join(dataDir, "loam-diagnostics-2026-10-06T09-00-00-000Z.txt");
    writeFileSync(report, "LOAM diagnostics\n");
    writeFileSync(join(dataDir, "keep-me.txt"), "not ours\n");

    expect((await app.host.emergencyReset()).complete).toBe(true);
    expect(app.host.status()).toMatchObject({ resets: 1, resetting: false });
    expect(existsSync(report)).toBe(false);
    expect(existsSync(join(dataDir, "keep-me.txt"))).toBe(true);
  });

  it("changes config exactly as the admin route does, refusals included", async () => {
    const app = await makeApp();
    const admin = await session(app);
    await claim(app, admin.cookie, app.host.adminClaimCode()!.code);

    const renamed = app.host.updateConfig({ node: { name: "Library" } });
    expect(renamed.ok).toBe(true);
    expect(app.host.status().nodeName).toBe("Library");
    const read = await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: admin.cookie } });
    expect((read.json() as { node: { name: string } }).node.name).toBe("Library");

    const host = app.host.updateConfig({ admin: { bootstrap: "passphrase" } });
    const route = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { admin: { bootstrap: "passphrase" } },
    });
    expect(route.statusCode).toBe(400);
    expect(host).toEqual({ ok: false, error: (route.json() as { error: string }).error });

    expect(app.host.updateConfig({ node: { name: 42 } } as never)).toEqual({
      ok: false,
      error: "Invalid config update request",
    });

    // The assistant may not take over a person's id, through either door.
    const hijack = { llm: { ollama: { enabled: true, botId: admin.user.id } } };
    const routeHijack = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: hijack,
    });
    expect(routeHijack.statusCode).toBe(400);
    expect(app.host.updateConfig(hijack)).toEqual({ ok: false, error: (routeHijack.json() as { error: string }).error });

    // A link code can't be added by a save.
    const linked = app.host.updateConfig({ sync: { peers: [{ url: "http://192.0.2.4:3000", linkCode: "abcdefghijklmnop" }] } });
    expect(linked.ok && linked.value.sync.peers).toEqual([{ url: "http://192.0.2.4:3000" }]);
  });

  it("lists people and makes one an admin, approving them first if they were waiting", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const waiting = await session(app);
    expect(waiting.user.pending).toBe(true);

    expect(app.host.users()).toEqual([
      expect.objectContaining({ id: waiting.user.id, pending: true, isAdmin: false, online: false }),
    ]);
    expect(app.host.status().people).toMatchObject({ total: 0, pending: 1 });

    const made = app.host.makeAdmin(waiting.user.id);
    expect(made).toMatchObject({ ok: true, value: { id: waiting.user.id, isAdmin: true, pending: false } });
    expect((await session(app, waiting.cookie)).user).toMatchObject({ isAdmin: true, pending: false });
    // Saved, not just changed in memory.
    expect(app.store.loadUsers().find((user) => user.id === waiting.user.id)).toMatchObject({
      isAdmin: true,
      pending: false,
    });

    expect(app.host.makeAdmin("user.0000000000000000")).toEqual({ ok: false, error: "User does not exist" });
  });

  it("refuses to make a banned person an admin", async () => {
    const app = await makeApp();
    const admin = await session(app);
    await claim(app, admin.cookie, app.host.adminClaimCode()!.code);
    const banned = await session(app);
    const ban = await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${banned.user.id}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });
    expect(ban.statusCode).toBe(200);

    expect(app.host.makeAdmin(banned.user.id)).toEqual({
      ok: false,
      error: "Approve or unban this user before promoting them",
    });
  });

  it("gives an invite only on an approval-only node, and link codes the sync route accepts the shape of", async () => {
    const open = await makeApp();
    expect(open.host.invite()).toBeNull();

    const approval = await makeApp({ access: { joinPolicy: "approval" } });
    expect(approval.host.invite()?.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(open.host.linkCode().code).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("pins the join address and changes the log level", async () => {
    const app = await makeApp(undefined, { joinHost: "192.0.2.10" });
    expect(app.host.status().joinHost).toBe("192.0.2.10");

    app.host.setJoinHost("198.51.100.7");
    expect(app.host.status().joinHost).toBe("198.51.100.7");
    expect((await session(app)).joinUrl).toContain("198.51.100.7");

    app.host.setLogLevel("debug");
    expect(app.host.status().logLevel).toBe("debug");
    app.host.setLogLevel("info");
    expect(app.host.status().logLevel).toBe("info");

    expect(app.host.transportPublicKey()).toBe(app.getTransportPublicKey());
  });
});
