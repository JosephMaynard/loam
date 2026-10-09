import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, type LoamApp } from "./app.js";
import { createInviteIssuer, INVITE_WINDOW_MS } from "./invites.js";

/**
 * Rotating invite codes (invites.ts): the issuer itself, the launcher-only `GET /api/host/invite` the host
 * app reads for its share screen and display mode, and `POST /api/access/redeem`, which admits a newcomer
 * waiting in the approval queue.
 */

const HOST_TOKEN = "invite-test-host-token-0123456789abcdef";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function makeApp(config?: unknown): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-invite-test-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, hostToken: HOST_TOKEN });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

async function session(app: LoamApp): Promise<{ cookie: string; user: { id: string; pending?: boolean } }> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
  return { cookie, user: (response.json() as { currentUser: { id: string; pending?: boolean } }).currentUser };
}

async function hostInvite(app: LoamApp, headers: Record<string, string> = { "x-loam-host-token": HOST_TOKEN }) {
  return app.server.inject({ method: "GET", url: "/api/host/invite", headers });
}

function redeem(app: LoamApp, cookie: string, code: string) {
  return app.server.inject({ method: "POST", url: "/api/access/redeem", headers: { cookie }, payload: { code } });
}

describe("createInviteIssuer", () => {
  it("accepts a code for its own window and the next, then refuses it", () => {
    let now = 5 * INVITE_WINDOW_MS + 1234;
    const issuer = createInviteIssuer(() => now);
    const { code, expiresAt } = issuer.current();
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBe(7 * INVITE_WINDOW_MS);
    expect(issuer.verify(code)).toBe(true);

    now = 6 * INVITE_WINDOW_MS + 5;
    expect(issuer.current().code).not.toBe(code);
    expect(issuer.verify(code)).toBe(true);

    now = 7 * INVITE_WINDOW_MS;
    expect(issuer.verify(code)).toBe(false);
  });

  it("refuses everything issued before a rotation, and malformed input", () => {
    const issuer = createInviteIssuer();
    const { code } = issuer.current();
    issuer.rotate();
    expect(issuer.verify(code)).toBe(false);
    for (const bad of ["", "short", `${code}x`, "!".repeat(22)]) {
      expect(issuer.verify(bad)).toBe(false);
    }
  });
});

describe("GET /api/host/invite", () => {
  it("gives the launcher a code on an approval-only node, and null on an open one", async () => {
    const approval = await makeApp({ access: { joinPolicy: "approval" } });
    const body = (await hostInvite(approval)).json() as { code: string; expiresAt: number };
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    const open = await makeApp();
    expect((await hostInvite(open)).json()).toEqual({ code: null, expiresAt: null });
  });

  it("answers the launcher on a node that refuses plaintext (the Private preset)", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" }, security: { profile: "hardened" } });
    expect((await hostInvite(app)).statusCode).toBe(200);
    expect((await hostInvite(app, { "x-loam-host-token": "wrong" })).statusCode).toBe(401);
  });

  it("answers only the launcher (loopback and its host token)", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    expect((await hostInvite(app, {})).statusCode).toBe(404);
    expect((await hostInvite(app, { "x-loam-host-token": "wrong" })).statusCode).toBe(404);
    const remote = await app.server.inject({
      method: "GET",
      url: "/api/host/invite",
      headers: { "x-loam-host-token": HOST_TOKEN },
      remoteAddress: "192.168.4.7",
    });
    expect(remote.statusCode).toBe(404);
  });
});

describe("POST /api/access/redeem", () => {
  it("admits a pending newcomer with the host's current code", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const newcomer = await session(app);
    expect(newcomer.user.pending).toBe(true);
    const { code } = (await hostInvite(app)).json() as { code: string };

    const response = await redeem(app, newcomer.cookie, code);

    expect(response.statusCode).toBe(200);
    expect((response.json() as { pending?: boolean }).pending).toBe(false);
    const after = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: newcomer.cookie } });
    expect((after.json() as { currentUser: { pending?: boolean } }).currentUser.pending).toBe(false);
  });

  it("refuses a wrong code or a malformed request, and leaves the newcomer queued", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const newcomer = await session(app);
    const refused = await redeem(app, newcomer.cookie, "A".repeat(22));
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "invite_invalid" });
    const malformed = await app.server.inject({
      method: "POST",
      url: "/api/access/redeem",
      headers: { cookie: newcomer.cookie },
      payload: { code: 42 },
    });
    expect(malformed.statusCode).toBe(400);
    const after = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: newcomer.cookie } });
    expect((after.json() as { currentUser: { pending?: boolean } }).currentUser.pending).toBe(true);
  });

  it("never lifts a ban", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const host = await session(app);
    await app.server.inject({
      method: "POST",
      url: "/api/admin/claim",
      headers: { cookie: host.cookie },
      payload: { secret: HOST_TOKEN },
    });
    const newcomer = await session(app);
    const denied = await app.server.inject({
      method: "POST",
      url: `/api/access/users/${newcomer.user.id}/deny`,
      headers: { cookie: host.cookie },
    });
    expect(denied.statusCode).toBe(200);
    const { code } = (await hostInvite(app)).json() as { code: string };
    expect((await redeem(app, newcomer.cookie, code)).statusCode).toBe(403);
  });

  it("stops accepting codes shown before an Emergency Reset", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const { code } = (await hostInvite(app)).json() as { code: string };
    expect((await app.emergencyReset()).complete).toBe(true);
    const newcomer = await session(app);
    expect((await redeem(app, newcomer.cookie, code)).statusCode).toBe(403);
  });
});
