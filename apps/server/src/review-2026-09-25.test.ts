import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTransport, sealTransport, transportClientDerive, transportClientHello } from "@loam/crypto";
import { TransportHandshakeResponseSchema } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import type { AppOptions } from "./types.js";

/**
 * Pre-release review 2026-09-25 — sync / mesh / kill-switch / transport fixes. Each security test here
 * was mutation-checked: with its fix reverted, it fails.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** A fresh app on its own temp data dir (optional config.json + options), cleaned up after the test. */
async function makeApp(config?: unknown, opts?: Partial<AppOptions>): Promise<{ app: LoamApp; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-review-0925-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
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

describe("Emergency Reset sweeps preserve-recovery snapshots in every branch (#7)", () => {
  /** Plant a `.loam-recovery-*` snapshot dir (with an old DB copy) + the recovery anchor after boot. */
  function plantRecoveryArtifacts(dataDir: string): string[] {
    const snapshot = join(dataDir, ".loam-recovery-1700000000000-abcd");
    mkdirSync(join(snapshot, "avatars"), { recursive: true });
    writeFileSync(join(snapshot, "loam.db"), "old still-readable database");
    writeFileSync(join(snapshot, "avatars", "a.png"), "old avatar");
    const anchor = join(dataDir, ".loam-recovery-state");
    writeFileSync(anchor, ".loam-recovery-1700000000000-abcd");
    return [snapshot, anchor];
  }

  async function wipe(app: LoamApp): Promise<number> {
    const admin = await newSession(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    return res.statusCode;
  }

  it("plaintext (logical) wipe removes the snapshot dir and the anchor", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const planted = plantRecoveryArtifacts(dataDir);
    expect(await wipe(app)).toBe(200);
    for (const path of planted) {
      expect(existsSync(path)).toBe(false);
    }
  });

  it("ephemeral-key (cryptographic) wipe removes the snapshot dir and the anchor", async () => {
    const { app, dataDir } = await makeApp(
      { killSwitch: { enabled: true } },
      { ephemeralDbKey: true, dbEncryptionMode: "ephemeral" },
    );
    const planted = plantRecoveryArtifacts(dataDir);
    expect(await wipe(app)).toBe(200);
    for (const path of planted) {
      expect(existsSync(path)).toBe(false);
    }
  });
});

describe("request logs never reveal tunnelled paths or query strings (#10)", () => {
  /** An app whose logs are captured line-by-line. */
  async function makeLoggedApp(): Promise<{ app: LoamApp; logs: string[] }> {
    const logs: string[] = [];
    const { app } = await makeApp(undefined, { logger: true, logStream: { write: (line) => void logs.push(line) } });
    return { app, logs };
  }

  /** Handshake + bind a transport session (docs/08 + docs/20), returning a sealed-tunnel GET sender. */
  async function boundTunnel(app: LoamApp): Promise<(path: string) => Promise<number>> {
    const hello = transportClientHello();
    const handshake = TransportHandshakeResponseSchema.parse(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/transport/handshake",
          payload: { clientEphemeralPublic: hello.ephemeralPublic },
        })
      ).json(),
    );
    const key = transportClientDerive({
      clientEphemeralSecret: hello.ephemeralSecret,
      hostPublic: handshake.hostPublicKey,
      hostEphemeralPublic: handshake.hostEphemeralPublic,
    });
    let seq = 0;
    const sealed = (path: string, body: unknown) =>
      app.server.inject({
        method: "POST",
        url: path,
        headers: { "x-loam-enc": handshake.sessionId, "content-type": "application/json" },
        payload: { enc: sealTransport(key, JSON.stringify({ s: ++seq, b: body }), `POST ${path}`) },
      });
    expect((await sealed("/api/session/resume", {})).statusCode).toBe(200);
    return async (path) => {
      const res = await sealed("/api/transport/tunnel", { m: "GET", p: path });
      const opened = openTransport(key, (res.json() as { enc: string }).enc, "POST /api/transport/tunnel");
      return (JSON.parse(opened as string) as { status: number }).status;
    };
  }

  it("a tunnelled request's real path + query never reach the log; the outer tunnel request does", async () => {
    const { app, logs } = await makeLoggedApp();
    const tunnel = await boundTunnel(app);
    expect(await tunnel("/api/search?q=TUNNELLED_SECRET_TERM")).toBe(200);
    const text = logs.join("");
    expect(text).toContain("/api/transport/tunnel");
    expect(text).not.toContain("TUNNELLED_SECRET_TERM");
    expect(text).not.toContain("/api/search");
  });

  it("strips the query string from every logged request URL", async () => {
    const { app, logs } = await makeLoggedApp();
    expect((await app.server.inject({ method: "GET", url: "/api/health?probe=DIRECT_QUERY_SECRET" })).statusCode).toBe(200);
    const text = logs.join("");
    expect(text).toContain("/api/health");
    expect(text).not.toContain("DIRECT_QUERY_SECRET");
  });
});
