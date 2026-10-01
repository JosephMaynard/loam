import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, type LoamApp } from "./app.js";
import { createLinkRequests, LINK_REQUEST_TTL_MS, MAX_LINK_REQUESTS, peerUrlFor } from "./sync-links.js";

/**
 * Link requests (sync-links.ts): a node that lists a peer asks it to sync back; the peer's admin accepts
 * (the asker becomes a pinned sync peer and sync switches on) or declines.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function makeApp(config?: unknown): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-link-test-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000 });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

/** The first session on a `firstUser` node is its admin. */
async function adminCookie(app: LoamApp): Promise<string> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const setCookie = response.headers["set-cookie"];
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}

const KEY = "a".repeat(43);

function askToLink(app: LoamApp, remoteAddress: string, payload: unknown = { port: 3000, transportKey: KEY, name: "Riverside" }) {
  return app.server.inject({ method: "POST", url: "/api/sync/link-request", remoteAddress, payload });
}

type SyncReport = {
  enabled: boolean;
  peers: { url: string; label?: string; transportKey?: string; link?: string }[];
  linkRequests?: { id: string; url: string; name?: string }[];
};

async function syncReport(app: LoamApp, cookie: string): Promise<SyncReport> {
  return (await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie } })).json() as SyncReport;
}

describe("peerUrlFor", () => {
  it("builds the asker's address, and refuses loopback or unspecified ones", () => {
    expect(peerUrlFor("192.168.4.20", 3000)).toBe("http://192.168.4.20:3000");
    expect(peerUrlFor("::ffff:10.0.0.7", 8080)).toBe("http://10.0.0.7:8080");
    expect(peerUrlFor("fe80::1", 3000)).toBe("http://[fe80::1]:3000");
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "0.0.0.0", "not an address"]) {
      expect(peerUrlFor(address, 3000)).toBeUndefined();
    }
  });
});

describe("createLinkRequests", () => {
  it("keeps one entry per address (same id on a repeat), caps the list, and expires entries", () => {
    let now = 1_000;
    const requests = createLinkRequests(() => now);
    const first = requests.add("10.0.0.1", { port: 3000 })!;
    expect(requests.add("10.0.0.1", { port: 3000, name: "Again" })!.id).toBe(first.id);
    expect(requests.list()).toHaveLength(1);

    for (let index = 2; index <= MAX_LINK_REQUESTS + 2; index += 1) {
      requests.add(`10.0.0.${index}`, { port: 3000 });
    }
    expect(requests.list()).toHaveLength(MAX_LINK_REQUESTS);
    expect(requests.list().some((entry) => entry.url === "http://10.0.0.1:3000")).toBe(false);

    now += LINK_REQUEST_TTL_MS + 1;
    expect(requests.list()).toEqual([]);
  });
});

describe("POST /api/sync/link-request", () => {
  it("parks a request for the admin, even with sync off, and accepting links both ways", async () => {
    const app = await makeApp();
    const cookie = await adminCookie(app);

    const asked = await askToLink(app, "192.168.4.20");
    expect(asked.json()).toEqual({ status: "pending" });
    const before = await syncReport(app, cookie);
    expect(before.enabled).toBe(false);
    expect(before.linkRequests).toMatchObject([{ url: "http://192.168.4.20:3000", name: "Riverside" }]);

    const accepted = await app.server.inject({
      method: "POST",
      url: `/api/admin/sync/link-requests/${before.linkRequests![0]!.id}/accept`,
      headers: { cookie },
    });
    expect(accepted.statusCode).toBe(200);
    const after = accepted.json() as SyncReport;
    expect(after.enabled).toBe(true);
    expect(after.peers).toMatchObject([{ url: "http://192.168.4.20:3000", label: "Riverside", transportKey: KEY }]);
    expect(after.linkRequests).toEqual([]);

    // Asking again now gets "linked", and parks nothing.
    expect((await askToLink(app, "192.168.4.20")).json()).toEqual({ status: "linked" });
    expect((await syncReport(app, cookie)).linkRequests).toEqual([]);
  });

  it("lets an admin decline, and only an admin decide", async () => {
    const app = await makeApp();
    const cookie = await adminCookie(app);
    await askToLink(app, "192.168.4.21");
    const { id } = (await syncReport(app, cookie)).linkRequests![0]!;

    const member = await adminCookie(app); // the second session is an ordinary member
    for (const action of ["accept", "decline"]) {
      const response = await app.server.inject({
        method: "POST",
        url: `/api/admin/sync/link-requests/${id}/${action}`,
        headers: { cookie: member },
      });
      expect(response.statusCode).toBe(403);
    }

    const declined = await app.server.inject({ method: "POST", url: `/api/admin/sync/link-requests/${id}/decline`, headers: { cookie } });
    expect((declined.json() as SyncReport).linkRequests).toEqual([]);
    expect((declined.json() as SyncReport).enabled).toBe(false);
    const again = await app.server.inject({ method: "POST", url: `/api/admin/sync/link-requests/${id}/accept`, headers: { cookie } });
    expect(again.statusCode).toBe(404);
  });

  it("refuses a malformed request and a loopback asker", async () => {
    const app = await makeApp();
    expect((await askToLink(app, "192.168.4.22", { port: 0 })).statusCode).toBe(400);
    expect((await askToLink(app, "192.168.4.22", { port: 3000, transportKey: "not base64url!" })).statusCode).toBe(400);
    expect((await askToLink(app, "127.0.0.1")).statusCode).toBe(400);
  });

  it("forgets waiting requests on an Emergency Reset", async () => {
    const app = await makeApp();
    await askToLink(app, "192.168.4.23");
    await app.emergencyReset();
    const cookie = await adminCookie(app);
    expect((await syncReport(app, cookie)).linkRequests).toEqual([]);
  });
});

describe("asking peers to link back", () => {
  it("asks each peer once per boot and reports its answer", async () => {
    const received: { port: number; name?: string; transportKey?: string }[] = [];
    const peer = createServer((request: IncomingMessage, response) => {
      if (request.method === "POST" && request.url === "/api/sync/link-request") {
        let raw = "";
        request.on("data", (chunk) => (raw += chunk));
        request.on("end", () => {
          received.push(JSON.parse(raw) as { port: number; name?: string; transportKey?: string });
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "pending" }));
        });
        return;
      }
      // No transport posture (an older or plaintext peer) and no sync content: the pull itself fails.
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => peer.close(() => resolve())));
    const peerUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;

    const app = await makeApp({ node: { name: "Hilltop" }, sync: { enabled: true, peers: [{ url: peerUrl }] } });
    const cookie = await adminCookie(app);
    for (let round = 0; round < 2; round += 1) {
      await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
    }

    // It sends the key a joiner would pin from its QR, so the peer can pin it too.
    const bootstrap = (await app.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as {
      networkConfig: { transportPublicKey: string };
    };
    expect(bootstrap.networkConfig.transportPublicKey).toBeTruthy();
    expect(received).toEqual([{ port: 3000, name: "Hilltop", transportKey: bootstrap.networkConfig.transportPublicKey }]);
    expect((await syncReport(app, cookie)).peers).toMatchObject([{ url: peerUrl, link: "pending" }]);
  });
});
