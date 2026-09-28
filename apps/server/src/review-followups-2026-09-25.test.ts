import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTransport, sealTransport, transportClientDerive, transportClientHello } from "@loam/crypto";
import { TransportHandshakeResponseSchema } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import { defaultLoamConfig } from "./config.js";
import type { AppOptions } from "./types.js";

/**
 * Follow-ups to the 2026-09-25 pre-release review. Each security test was mutation-checked: with its fix
 * reverted, it fails.
 */

// Candidate ids the session-id minter must try first (each is still checked against the caller's
// `isTaken` predicate, exactly like the real minter); empty → the real random minter.
const identityMock = vi.hoisted(() => ({ forced: [] as string[] }));
vi.mock("./identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity.js")>();
  return {
    ...actual,
    makeSessionUserId: (isTaken?: (id: string) => boolean): string => {
      for (;;) {
        const id = identityMock.forced.shift() ?? actual.makeSessionUserId();
        if (!isTaken?.(id)) {
          return id;
        }
      }
    },
  };
});

// Fault injection for the keyed (SQLCipher) open and the driver probe; unset → the real implementations.
const dbMock = vi.hoisted(() => ({
  keyedOpen: undefined as ((path: string) => never) | undefined,
  driverError: undefined as Error | undefined,
}));
vi.mock("./db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db.js")>();
  return {
    ...actual,
    openStore: (path: string, options?: Parameters<typeof actual.openStore>[1]) => {
      if (options?.encryptionKey && dbMock.keyedOpen) {
        dbMock.keyedOpen(path);
      }
      return actual.openStore(path, options);
    },
    probeEncryptedDriver: () => dbMock.driverError ?? actual.probeEncryptedDriver(),
  };
});

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  identityMock.forced.length = 0;
  dbMock.keyedOpen = undefined;
  dbMock.driverError = undefined;
  delete (globalThis as { __loamReportBootError?: unknown }).__loamReportBootError;
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** A fresh temp data dir, removed after the test. */
function tempDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-followup-0925-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

/** Boot an app on `dataDir` (closed after the test). */
async function boot(dataDir: string, opts?: Partial<AppOptions>): Promise<LoamApp> {
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(() => app.close());
  return app;
}

/** Capture the codes reported over the launcher's boot-error bridge. */
function captureBootReports(): string[] {
  const codes: string[] = [];
  (globalThis as { __loamReportBootError?: (message: string, code: string) => void }).__loamReportBootError = (
    _message,
    code,
  ) => {
    codes.push(code);
  };
  return codes;
}

describe("the sealed resume mint never aliases an existing identity", () => {
  it("a colliding candidate id is skipped, so a fresh device can't inherit the admin's account", async () => {
    const app = await boot(tempDataDir());
    const config = await app.server.inject({ method: "GET", url: "/api/config" });
    const admin = (config.json() as { currentUser: { id: string; isAdmin: boolean } }).currentUser;
    expect(admin.isAdmin).toBe(true);

    // Handshake, then resume with no token → the server mints a new identity. Force its first candidate to
    // the admin's id: only the collision-checked minter rejects it.
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
    identityMock.forced.push(admin.id);
    const aad = "POST /api/session/resume";
    const res = await app.server.inject({
      method: "POST",
      url: "/api/session/resume",
      headers: { "x-loam-enc": handshake.sessionId, "content-type": "application/json" },
      payload: { enc: sealTransport(key, JSON.stringify({ s: 1, b: {} }), aad) },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(openTransport(key, (res.json() as { enc: string }).enc, aad) as string) as {
      currentUser: { id: string; isAdmin: boolean };
    };
    expect(body.currentUser.id).not.toBe(admin.id);
    expect(body.currentUser.isAdmin).toBe(false);
  });
});

describe("a wipe journal written by an older build is repaired, not treated as corrupt", () => {
  it("resumes with a snapshot holding transportEncryption \"off\" and an out-of-namespace bot id", async () => {
    const dataDir = tempDataDir();
    const first = await buildApp({ dataDir, logger: false });
    await first.close();

    const snapshot = defaultLoamConfig() as unknown as {
      security: Record<string, unknown>;
      llm: { ollama: Record<string, unknown> };
      killSwitch: Record<string, unknown>;
    };
    snapshot.security.transportEncryption = "off";
    snapshot.llm.ollama.botId = "user.legacybot";
    snapshot.killSwitch.enabled = true;
    writeFileSync(join(dataDir, ".loam-wipe-phase"), JSON.stringify({ phase: "delete-pending", config: snapshot }));

    const app = await boot(dataDir);
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
    const restored = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as {
      security: { transportEncryption: string };
      llm: { ollama: { botId: string } };
      killSwitch: { enabled: boolean };
    };
    expect(restored.security.transportEncryption).toBe("optional");
    expect(restored.llm.ollama.botId).toBe(defaultLoamConfig().llm.ollama.botId);
    // The admin config the journal carried survives the resume.
    expect(restored.killSwitch.enabled).toBe(true);
    const session = (await app.server.inject({ method: "GET", url: "/api/config" })).headers["set-cookie"];
    const cookie = String(Array.isArray(session) ? session[0] : session).split(";")[0];
    const live = await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie } });
    expect((live.json() as { killSwitch: { enabled: boolean } }).killSwitch.enabled).toBe(true);
  });

  it("still locks on a snapshot that is invalid for any other reason", async () => {
    const dataDir = tempDataDir();
    const first = await buildApp({ dataDir, logger: false });
    await first.close();
    const snapshot = defaultLoamConfig() as unknown as { llm: { ollama: Record<string, unknown> } };
    delete snapshot.llm.ollama.botId; // never had one: not a legacy value, so nothing to repair
    writeFileSync(join(dataDir, ".loam-wipe-phase"), JSON.stringify({ phase: "delete-pending", config: snapshot }));

    await expect(buildApp({ dataDir, logger: false })).rejects.toThrow(/INVALID config snapshot/);
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(true);
  });
});

describe("a failed keyed open never creates or misreports a plaintext database", () => {
  it("a SQLCipher driver that won't load is a distinct fatal, and no plaintext loam.db is created", async () => {
    const dataDir = tempDataDir();
    const reports = captureBootReports();
    dbMock.driverError = Object.assign(new Error("Cannot find module 'better-sqlite3-multiple-ciphers'"), {
      code: "MODULE_NOT_FOUND",
    });
    dbMock.keyedOpen = () => {
      throw dbMock.driverError;
    };

    await expect(buildApp({ dataDir, logger: false, dbEncryptionKey: "a key" })).rejects.toMatchObject({
      code: "db_encryption_driver_missing",
    });
    expect(reports).toContain("db_encryption_driver_missing");
    expect(reports).not.toContain("db_encryption_plaintext_unconverted");
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
  });

  it("a driver that won't load never offers recovery for an EXISTING encrypted database either", async () => {
    const dataDir = tempDataDir();
    const first = await buildApp({ dataDir, logger: false, dbEncryptionKey: "a key" });
    await first.close();
    const before = readFileSync(join(dataDir, "loam.db"));
    const reports = captureBootReports();
    dbMock.driverError = new Error("dlopen failed: wrong ELF class");
    dbMock.keyedOpen = () => {
      throw dbMock.driverError;
    };

    await expect(buildApp({ dataDir, logger: false, dbEncryptionKey: "a key" })).rejects.toMatchObject({
      code: "db_encryption_driver_missing",
    });
    expect(reports).toEqual(["db_encryption_driver_missing"]);
    expect(readFileSync(join(dataDir, "loam.db")).equals(before)).toBe(true);
  });

  it("a fresh node whose keyed open writes plaintext (codec never engaged) leaves no file behind", async () => {
    const dataDir = tempDataDir();
    const reports = captureBootReports();
    // What a cipher-less driver build does: the file is created as ordinary SQLite, then openStore's
    // post-open header check refuses it.
    dbMock.keyedOpen = (path) => {
      writeFileSync(path, Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(4080)]));
      throw new Error("Refusing to use the database: it was opened with an encryption key but is PLAINTEXT on disk");
    };

    await expect(buildApp({ dataDir, logger: false, dbEncryptionKey: "a key" })).rejects.toThrow(/PLAINTEXT on disk/);
    expect(reports).not.toContain("db_encryption_plaintext_unconverted");
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
  });

  it("an existing PLAINTEXT database under an encrypted mode is still reported as unconverted", async () => {
    const dataDir = tempDataDir();
    const first = await buildApp({ dataDir, logger: false });
    await first.close();
    const reports = captureBootReports();

    await expect(buildApp({ dataDir, logger: false, dbEncryptionKey: "a key" })).rejects.toMatchObject({
      code: "db_encryption_plaintext_unconverted",
    });
    expect(reports).toContain("db_encryption_plaintext_unconverted");
  });
});

describe("mesh identity rows are deleted, not overwritten", () => {
  it("boot removes a `null` placeholder row an earlier build left behind", async () => {
    const dataDir = tempDataDir();
    const first = await buildApp({ dataDir, logger: false });
    const config = await first.server.inject({ method: "GET", url: "/api/config" });
    const userId = (config.json() as { currentUser: { id: string } }).currentUser.id;
    first.store.upsertMeshIdentity(userId, "null");
    await first.close();

    const app = await boot(dataDir);
    expect(app.store.loadMeshIdentities().some((row) => row.userId === userId)).toBe(false);
  });
});

describe("a persisted config row repaired at load is written back once", () => {
  it("rewrites a legacy row at boot, and leaves a valid row untouched", async () => {
    const dataDir = tempDataDir();
    const first = await buildApp({ dataDir, logger: false });
    first.store.setConfigValue(
      "config",
      JSON.stringify({ node: { name: "Kept" }, security: { transportEncryption: "off" }, llm: { ollama: { botId: "user.x" } } }),
    );
    await first.close();

    const second = await buildApp({ dataDir, logger: false });
    const row = JSON.parse(second.store.getConfigValue("config") ?? "{}") as {
      node?: { name?: string };
      security?: { transportEncryption?: string };
      llm?: { ollama?: { botId?: string } };
    };
    expect(row.security?.transportEncryption).toBe("optional");
    expect(row.llm?.ollama?.botId).toBeUndefined();
    expect(row.node?.name).toBe("Kept");
    const network = await second.server.inject({ method: "GET", url: "/api/config" });
    expect((network.json() as { networkConfig: { nodeName: string } }).networkConfig.nodeName).toBe("Kept");

    // A row that needs no repair is not rewritten (byte-identical, formatting included).
    const valid = '{ "node": { "name": "Untouched" } }';
    second.store.setConfigValue("config", valid);
    await second.close();
    const third = await boot(dataDir);
    expect(third.store.getConfigValue("config")).toBe(valid);
  });
});
