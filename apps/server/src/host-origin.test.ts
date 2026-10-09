import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import { hostHeaderName, hostNameAllowed, loggedRequest, originMatchesHost } from "./transport-server.js";
import type { AppOptions } from "./types.js";

// Host allowlist + WebSocket Origin check. Any `Host` used to be accepted, so on an
// internet-connected LAN a DNS-rebinding page could point its own hostname at the node and read public
// channels as a fresh identity; and a cross-site page could open `/ws` with the browser's cookie. Now a
// request is served only when its Host is an IP literal, `localhost`/`*.localhost`, an mDNS `*.local` name or
// the advertised join host (else 421), and a WebSocket upgrade whose Origin names another host is refused
// before the upgrade.

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function makeApp(config?: unknown, opts?: Partial<AppOptions>): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-host-origin-test-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

type RawWebSocket = {
  addEventListener: (event: string, listener: (event: unknown) => void) => void;
  send: (data: string) => void;
  close: () => void;
};

/** Open a socket with extra request headers (Node's WebSocket sends no Origin unless given one). */
function openWs(url: string, headers: Record<string, string>): RawWebSocket {
  const socket = new (WebSocket as unknown as new (url: string, opts?: unknown) => RawWebSocket)(url, { headers });
  cleanups.push(() => socket.close());
  return socket;
}

/** Resolves true when the socket opens, false when the server refuses the upgrade. */
function upgradeOutcome(socket: RawWebSocket): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true));
    socket.addEventListener("error", () => resolve(false));
  });
}

async function cookieSession(app: LoamApp): Promise<string> {
  const config = await app.server.inject({ method: "GET", url: "/api/config" });
  return String(config.headers["set-cookie"]).split(";")[0]!;
}

describe("Host header parsing and allowlist", () => {
  it("hostHeaderName strips the port, lowercases, unwraps IPv6 brackets and drops a trailing dot", () => {
    expect(hostHeaderName("localhost:3000")).toBe("localhost");
    expect(hostHeaderName("192.168.1.5")).toBe("192.168.1.5");
    expect(hostHeaderName("192.168.1.5:3000")).toBe("192.168.1.5");
    expect(hostHeaderName("[fe80::1]:3000")).toBe("fe80::1");
    expect(hostHeaderName("[::1]")).toBe("::1");
    expect(hostHeaderName("::1")).toBe("::1");
    expect(hostHeaderName("Pi.Local.")).toBe("pi.local");
    expect(hostHeaderName("  LOAM.example.ORG:80 ")).toBe("loam.example.org");
  });

  it("hostHeaderName is undefined for an empty or malformed value", () => {
    expect(hostHeaderName(undefined)).toBeUndefined();
    expect(hostHeaderName("")).toBeUndefined();
    expect(hostHeaderName("[fe80::1")).toBeUndefined();
    expect(hostHeaderName("[fe80::1]x")).toBeUndefined();
    expect(hostHeaderName("evil.example.com:abc")).toBeUndefined();
    expect(hostHeaderName("a:b:c")).toBeUndefined();
    expect(hostHeaderName(":3000")).toBeUndefined();
  });

  it("allows IP literals, localhost names, .local names and the join host, and nothing else", () => {
    const noJoinHost = () => undefined;
    for (const name of ["192.168.1.5", "10.0.0.1", "fe80::1", "::1", "localhost", "app.localhost", "pi.local", "loam-host.local"]) {
      expect(hostNameAllowed(name, noJoinHost), name).toBe(true);
    }
    for (const name of [undefined, "", "evil.example.com", "localhost.evil.com", "local", "localhost2", "pi.local.evil.com"]) {
      expect(hostNameAllowed(name, noJoinHost), String(name)).toBe(false);
    }
    expect(hostNameAllowed("loam.example.org", () => "loam.example.org")).toBe(true);
    expect(hostNameAllowed("loam.example.org", () => "LOAM.example.org:3000")).toBe(true);
    expect(hostNameAllowed("evil.example.com", () => "loam.example.org")).toBe(false);
  });

  it("consults the join host lazily: a name every node serves never triggers an interface scan", () => {
    const joinHost = vi.fn(() => "192.168.1.5");
    expect(hostNameAllowed("192.168.1.5", joinHost)).toBe(true);
    expect(hostNameAllowed("localhost", joinHost)).toBe(true);
    expect(joinHost).not.toHaveBeenCalled();
    expect(hostNameAllowed("somewhere.example", joinHost)).toBe(false);
    expect(joinHost).toHaveBeenCalledTimes(1);
  });

  it("originMatchesHost compares the Origin's host with the request's Host, ports aside", () => {
    expect(originMatchesHost("http://192.168.1.5:3000", "192.168.1.5:3000")).toBe(true);
    expect(originMatchesHost("http://192.168.1.5:8080", "192.168.1.5:3000")).toBe(true);
    expect(originMatchesHost("http://localhost:3000", "localhost:3000")).toBe(true);
    expect(originMatchesHost("http://[fe80::1]:3000", "[fe80::1]:3000")).toBe(true);
    expect(originMatchesHost("HTTP://Pi.Local", "pi.local:3000")).toBe(true);
    expect(originMatchesHost("http://evil.example.com", "192.168.1.5:3000")).toBe(false);
    expect(originMatchesHost("null", "192.168.1.5:3000")).toBe(false);
    expect(originMatchesHost("not a url", "192.168.1.5:3000")).toBe(false);
    expect(originMatchesHost("http://192.168.1.5:3000", undefined)).toBe(false);
  });

  it("the request log keeps an allowed Host and replaces any other with a placeholder", () => {
    expect(loggedRequest({ method: "GET", url: "/api/bootstrap", host: "192.168.1.5:3000" }).host).toBe("192.168.1.5:3000");
    expect(loggedRequest({ method: "GET", url: "/api/bootstrap", host: "localhost:3000" }).host).toBe("localhost:3000");
    expect(loggedRequest({ method: "GET", url: "/api/bootstrap", host: "evil.example.com" }).host).toBe("[hostname]");
    expect(loggedRequest({ method: "GET", url: "/api/bootstrap" }).host).toBe("[hostname]");
  });
});

describe("Host allowlist on every route", () => {
  it("a request addressed to a foreign hostname gets 421 and mints no identity", async () => {
    const app = await makeApp();
    for (const url of ["/api/bootstrap", "/api/config", "/"]) {
      const response = await app.server.inject({ method: "GET", url, headers: { host: "evil.example.com" } });
      expect(response.statusCode, url).toBe(421);
      expect(response.json(), url).toEqual({ error: "This address isn't served by this LOAM node", code: "host_not_allowed" });
      expect(response.headers["set-cookie"], url).toBeUndefined();
    }
    expect((await app.server.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "evil.example.com:3000" } })).statusCode).toBe(421);
    expect(app.store.loadUsers().filter((user) => user.type === "human")).toHaveLength(0);
  });

  it("IP literals, localhost, .local names and the inject default are served", async () => {
    const app = await makeApp();
    for (const host of ["192.168.1.5:3000", "[fe80::1]:3000", "[::1]:3000", "10.0.0.1", "localhost:3000", "localhost", "pi.local:3000", "app.localhost:3000"]) {
      const response = await app.server.inject({ method: "GET", url: "/api/bootstrap", headers: { host } });
      expect(response.statusCode, host).toBe(200);
    }
    // `server.inject` without a Host header (light-my-request's `localhost:80`), as every other test relies on.
    expect((await app.server.inject({ method: "GET", url: "/api/bootstrap" })).statusCode).toBe(200);
  });

  it("the advertised join host is served by name, including one pinned later from the host screen", async () => {
    const app = await makeApp(undefined, { joinHost: "loam.example.org" });
    const pinned = await app.server.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "loam.example.org:3000" } });
    expect(pinned.statusCode).toBe(200);
    expect((pinned.json() as { joinUrl: string }).joinUrl).toContain("loam.example.org");
    expect((await app.server.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "other.example.org" } })).statusCode).toBe(421);

    app.host.setJoinHost("other.example.org");
    expect((await app.server.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "other.example.org" } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "loam.example.org" } })).statusCode).toBe(421);
  });

  it("a refused hostname never reaches the request log", async () => {
    const logs: string[] = [];
    const app = await makeApp(undefined, { logger: true, logStream: { write: (line) => void logs.push(line) } });
    expect((await app.server.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "evil-rebinder.example.com" } })).statusCode).toBe(421);
    expect((await app.server.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "192.168.1.5:3000" } })).statusCode).toBe(200);
    const text = logs.join("");
    expect(text).toContain("/api/bootstrap");
    expect(text).toContain("192.168.1.5:3000");
    expect(text).not.toContain("evil-rebinder");
  });
});

describe("WebSocket Origin check", () => {
  it("refuses an upgrade whose Origin names another host, before any session work", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const cookie = await cookieSession(app);
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const wsUrl = `${baseUrl.replace("http", "ws")}/ws`;

    const foreign = openWs(wsUrl, { cookie, origin: "http://evil.example.com" });
    expect(await upgradeOutcome(foreign)).toBe(false);
    const opaque = openWs(wsUrl, { cookie, origin: "null" });
    expect(await upgradeOutcome(opaque)).toBe(false);
    // Nothing was admitted: no socket session exists for the (valid) cookie identity.
    expect(app.sockets.size).toBe(0);
  });

  it("admits an upgrade whose Origin is the host it was addressed to, and one with no Origin at all", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const cookie = await cookieSession(app);
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const wsUrl = `${baseUrl.replace("http", "ws")}/ws`;

    const same = openWs(wsUrl, { cookie, origin: baseUrl });
    expect(await upgradeOutcome(same)).toBe(true);
    // The page's port needn't be the socket's (a dev proxy, a reverse proxy): the host is what must match.
    const otherPort = openWs(wsUrl, { cookie, origin: "http://127.0.0.1:1" });
    expect(await upgradeOutcome(otherPort)).toBe(true);
    const none = openWs(wsUrl, { cookie });
    expect(await upgradeOutcome(none)).toBe(true);
  });

  it("refuses an upgrade addressed to a foreign Host even with a matching Origin", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const cookie = await cookieSession(app);
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const wsUrl = `${baseUrl.replace("http", "ws")}/ws`;

    const rebound = openWs(wsUrl, { cookie, host: "evil.example.com", origin: "http://evil.example.com" });
    expect(await upgradeOutcome(rebound)).toBe(false);
  });
});
