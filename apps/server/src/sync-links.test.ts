import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, type AppOptions, type LoamApp } from "./app.js";
import { createLinkCodes, LINK_CODE_TTL_MS, MAX_LINK_CODES, peerUrlFor } from "./sync-links.js";
import { handshakeWithPeer, sealedFetch } from "./sync-transport.js";

/**
 * Linking nodes with a "Link a node" code (sync-links.ts): an admin shows a single-use code, the new node
 * presents it sealed, and a valid one links both ways.
 */

const cleanups: (() => Promise<void> | void)[] = [];
const HOST_TOKEN = "link-test-host-token-0123456789abcdef";

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** This machine's own LAN address: linking refuses loopback askers, so the round trips run over it. */
const LAN_ADDRESS = Object.values(networkInterfaces())
  .flat()
  .find((info) => info && info.family === "IPv4" && !info.internal)?.address;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function makeApp(config?: unknown, opts: Partial<AppOptions> = {}): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-link-test-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

/** A node listening on the LAN address at a known port (the port it reports when it links). */
async function lanNode(config?: unknown): Promise<{ app: LoamApp; url: string; key: string }> {
  const port = await freePort();
  const app = await makeApp(config, { clientPort: port });
  await app.server.listen({ port, host: LAN_ADDRESS });
  const bootstrap = (await app.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as {
    networkConfig: { transportPublicKey: string };
  };
  return { app, url: `http://${LAN_ADDRESS}:${port}`, key: bootstrap.networkConfig.transportPublicKey };
}

/** The first session on a `firstUser` node is its admin. */
async function sessionCookie(app: LoamApp): Promise<string> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const setCookie = response.headers["set-cookie"];
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}

async function mintCode(app: LoamApp, cookie: string): Promise<string> {
  const response = await app.server.inject({ method: "POST", url: "/api/admin/sync/link-code", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { code: string }).code;
}

/** Present a link code to `node` the way a new node does: sealed to the key from the QR. */
async function link(node: { url: string; key: string }, body: Record<string, unknown>) {
  const session = await handshakeWithPeer(node.url, { expectedHostKey: node.key });
  return sealedFetch(session, node.url, "/api/sync/link", { body });
}

type SyncReport = {
  enabled: boolean;
  peers: { url: string; label?: string; transportKey?: string; link?: string; linkCode?: string }[];
};

async function syncReport(app: LoamApp, cookie: string): Promise<SyncReport> {
  return (await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie } })).json() as SyncReport;
}

describe("peerUrlFor", () => {
  it("builds the linking node's address, and refuses loopback or unspecified ones", () => {
    expect(peerUrlFor("192.168.4.20", 3000)).toBe("http://192.168.4.20:3000");
    expect(peerUrlFor("::ffff:10.0.0.7", 8080)).toBe("http://10.0.0.7:8080");
    expect(peerUrlFor("fe80::1", 3000)).toBe("http://[fe80::1]:3000");
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "0.0.0.0", "not an address"]) {
      expect(peerUrlFor(address, 3000)).toBeUndefined();
    }
  });
});

describe("createLinkCodes", () => {
  it("accepts each code once (and its own repeat), until it expires", () => {
    let now = 1_000;
    const codes = createLinkCodes(() => now);
    const first = codes.mint();
    expect(first.code).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(first.expiresAt).toBe(1_000 + LINK_CODE_TTL_MS);
    expect(codes.check(first.code, "node-a")).toBe("fresh");
    codes.spend(first.code, "node-a");
    // The same node again (its answer was lost) may repeat; anyone else is refused.
    expect(codes.check(first.code, "node-a")).toBe("repeat");
    expect(codes.check(first.code, "node-b")).toBe("invalid");

    const second = codes.mint();
    now += LINK_CODE_TTL_MS;
    expect(codes.check(second.code, "node-a")).toBe("invalid");
    expect(codes.check(first.code, "node-a")).toBe("invalid");
  });

  it("keeps only the newest few, and refuses malformed or cleared codes", () => {
    const codes = createLinkCodes();
    const minted = Array.from({ length: MAX_LINK_CODES + 1 }, () => codes.mint().code);
    expect(codes.check(minted[0]!, "node")).toBe("invalid");
    for (const bad of ["", "short", `${minted[1]}x`, "!".repeat(16)]) {
      expect(codes.check(bad, "node")).toBe("invalid");
    }
    codes.clear();
    expect(codes.check(minted[1]!, "node")).toBe("invalid");
  });
});

describe("showing a link code", () => {
  it("is for admins, or for the host phone's launcher", async () => {
    const app = await makeApp(undefined, { hostToken: HOST_TOKEN });
    const member = await sessionCookie(app); // hostDevice bootstrap: no session is admin without the token
    const refused = await app.server.inject({ method: "POST", url: "/api/admin/sync/link-code", headers: { cookie: member } });
    expect(refused.statusCode).toBe(403);

    const host = await app.server.inject({ method: "POST", url: "/api/host/link-code", headers: { "x-loam-host-token": HOST_TOKEN } });
    expect(host.json()).toMatchObject({ code: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/) });
    const wrong = await app.server.inject({ method: "POST", url: "/api/host/link-code", headers: { "x-loam-host-token": "wrong" } });
    expect(wrong.statusCode).toBe(404);
    const remote = await app.server.inject({
      method: "POST",
      url: "/api/host/link-code",
      headers: { "x-loam-host-token": HOST_TOKEN },
      remoteAddress: "192.168.4.7",
    });
    expect(remote.statusCode).toBe(404);
  });
});

describe("POST /api/sync/link", () => {
  it("refuses a code sent unsealed", async () => {
    const app = await makeApp();
    const code = await mintCode(app, await sessionCookie(app));
    const response = await app.server.inject({
      method: "POST",
      url: "/api/sync/link",
      remoteAddress: "192.168.4.20",
      payload: { code, port: 3000 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "link_unencrypted" });
  });

  it.skipIf(!LAN_ADDRESS)("links a node with a valid code, once, and hands over the mesh token", async () => {
    const existing = await lanNode({ node: { name: "Riverside" }, sync: { enabled: false, peers: [], token: "mesh-secret-0123456789" } });
    const cookie = await sessionCookie(existing.app);
    const code = await mintCode(existing.app, cookie);

    const linked = await link(existing, { code, port: 3456, transportKey: "a".repeat(43), name: "Hilltop" });
    expect(linked.status).toBe(200);
    expect(JSON.parse(linked.text)).toEqual({ name: "Riverside", token: "mesh-secret-0123456789" });
    const report = await syncReport(existing.app, cookie);
    expect(report.enabled).toBe(true);
    expect(report.peers).toEqual([
      expect.objectContaining({ url: `http://${LAN_ADDRESS}:3456`, label: "Hilltop", transportKey: "a".repeat(43) }),
    ]);

    // The same node asking again (its answer was lost) gets the same answer, and no second peer appears.
    const repeat = await link(existing, { code, port: 3456, transportKey: "a".repeat(43), name: "Hilltop" });
    expect(JSON.parse(repeat.text)).toEqual({ name: "Riverside", token: "mesh-secret-0123456789" });
    expect((await syncReport(existing.app, cookie)).peers).toHaveLength(1);
    // The same code from anyone else (a photo of the QR) is refused.
    expect((await link(existing, { code, port: 3457 })).status).toBe(403);
  });

  it.skipIf(!LAN_ADDRESS)("forgets every shown code on an Emergency Reset", async () => {
    const existing = await lanNode();
    const code = await mintCode(existing.app, await sessionCookie(existing.app));
    await existing.app.emergencyReset();
    // The reset rotates the node's key too: present the old code under the new one.
    const bootstrap = (await existing.app.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as {
      networkConfig: { transportPublicKey: string };
    };
    expect(bootstrap.networkConfig.transportPublicKey).not.toBe(existing.key);
    expect((await link({ url: existing.url, key: bootstrap.networkConfig.transportPublicKey }, { code, port: 3456 })).status).toBe(403);
  });
});

describe("a new node using its link code", () => {
  it.skipIf(!LAN_ADDRESS)("links both ways on its first sync round, then forgets the code", async () => {
    const existing = await lanNode({ node: { name: "Riverside" }, sync: { enabled: false, peers: [], token: "mesh-secret-0123456789" } });
    const existingAdmin = await sessionCookie(existing.app);
    const code = await mintCode(existing.app, existingAdmin);

    // What the setup screens write for a joining phone: the scanned node as a pinned peer holding the code.
    const joining = await lanNode({
      node: { name: "Hilltop" },
      sync: { enabled: true, peers: [{ url: existing.url, transportKey: existing.key, linkCode: code }] },
    });
    const joiningAdmin = await sessionCookie(joining.app);
    expect((await syncReport(joining.app, joiningAdmin)).peers[0]).toMatchObject({ link: "linking" });

    await joining.app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: joiningAdmin } });

    // The existing node now lists the joining one, key pinned, with sync on.
    expect((await syncReport(existing.app, existingAdmin)).peers).toEqual([
      expect.objectContaining({ url: joining.url, label: "Hilltop", transportKey: joining.key }),
    ]);
    // The joining node dropped the spent code, named the peer, and adopted the mesh token.
    const after = await syncReport(joining.app, joiningAdmin);
    expect(after.peers[0]).toMatchObject({ url: existing.url, label: "Riverside" });
    expect(after.peers[0]!.link).toBeUndefined();
    expect(after.peers[0]!.linkCode).toBeUndefined();
    const config = (
      await joining.app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: joiningAdmin } })
    ).json() as { sync: { token?: string; peers: { linkCode?: string }[] } };
    expect(config.sync.token).toBe("mesh-secret-0123456789");
    expect(config.sync.peers[0]!.linkCode).toBeUndefined();
  });

  it("never lets an admin save put back (or add) a link code", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://192.168.4.30:3000", linkCode: "B".repeat(16) }] } });
    const cookie = await sessionCookie(app);
    const save = (peers: unknown[]) =>
      app.server.inject({ method: "PATCH", url: "/api/admin/config", headers: { cookie }, payload: { sync: { peers } } });
    const peers = async () =>
      ((await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie } })).json() as {
        sync: { peers: { url: string; linkCode?: string }[] };
      }).sync.peers;

    await save([{ url: "http://192.168.4.30:3000", linkCode: "B".repeat(16) }, { url: "http://192.168.4.31:3000", linkCode: "C".repeat(16) }]);
    expect(await peers()).toEqual([
      { url: "http://192.168.4.30:3000", linkCode: "B".repeat(16) },
      { url: "http://192.168.4.31:3000" },
    ]);
    await save([{ url: "http://192.168.4.30:3000", linkCode: "D".repeat(16) }]);
    expect(await peers()).toEqual([{ url: "http://192.168.4.30:3000" }]);
  });

  it.skipIf(!LAN_ADDRESS)("drops a link answer that arrives after an Emergency Reset", async () => {
    const existing = await lanNode({ sync: { enabled: false, peers: [], token: "mesh-secret-0123456789" } });
    const code = await mintCode(existing.app, await sessionCookie(existing.app));
    const joining = await lanNode({
      sync: { enabled: true, peers: [{ url: existing.url, transportKey: existing.key, linkCode: code }] },
    });
    const cookie = await sessionCookie(joining.app);

    // Hold the link answer until the reset has finished.
    const realFetch = globalThis.fetch;
    let arrived!: () => void;
    const answerArrived = new Promise<void>((resolve) => (arrived = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await realFetch(input, init);
      if (String(input).endsWith("/api/sync/link")) {
        arrived();
        await released;
      }
      return response;
    }) as typeof fetch;
    cleanups.push(() => {
      globalThis.fetch = realFetch;
    });

    const round = joining.app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
    await answerArrived;
    await joining.app.emergencyReset();
    release();
    await round;

    const config = (
      await joining.app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: await sessionCookie(joining.app) } })
    ).json() as { sync: { token?: string } };
    expect(config.sync.token).toBeUndefined();
  });

  it.skipIf(!LAN_ADDRESS)("drops a link answer that arrives after an admin removed the peer", async () => {
    // Review 2026-10-03 #4: the answer used to install the removed peer's token into the saved config.
    const existing = await lanNode({ sync: { enabled: false, peers: [], token: "mesh-secret-0123456789" } });
    const code = await mintCode(existing.app, await sessionCookie(existing.app));
    const joining = await lanNode({
      sync: { enabled: true, peers: [{ url: existing.url, transportKey: existing.key, linkCode: code }] },
    });
    const cookie = await sessionCookie(joining.app);

    const realFetch = globalThis.fetch;
    let arrived!: () => void;
    const answerArrived = new Promise<void>((resolve) => (arrived = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await realFetch(input, init);
      if (String(input).endsWith("/api/sync/link")) {
        arrived();
        await released;
      }
      return response;
    }) as typeof fetch;
    cleanups.push(() => {
      globalThis.fetch = realFetch;
    });

    const round = joining.app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
    await answerArrived;
    const save = await joining.app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { sync: { enabled: false, peers: [] } },
    });
    expect(save.statusCode).toBe(200);
    release();
    await round;

    const config = (
      await joining.app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie } })
    ).json() as { sync: { enabled: boolean; peers: unknown[]; token?: string } };
    expect(config.sync).toMatchObject({ enabled: false, peers: [] });
    expect(config.sync.token).toBeUndefined();
  });

  it.skipIf(!LAN_ADDRESS)("reports a refused code and doesn't try it again", async () => {
    const existing = await lanNode();
    const joining = await lanNode({
      sync: { enabled: true, peers: [{ url: existing.url, transportKey: existing.key, linkCode: "A".repeat(16) }] },
    });
    const cookie = await sessionCookie(joining.app);
    await joining.app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
    expect((await syncReport(joining.app, cookie)).peers[0]).toMatchObject({ link: "refused" });
  });
});
