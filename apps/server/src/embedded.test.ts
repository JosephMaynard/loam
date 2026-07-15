import { afterEach, describe, expect, it } from "vitest";

// Importing this module must not boot a server (the auto-start lives in embedded-main.ts) — if it
// did, this test file would try to listen on load. That it imports cleanly is itself the assertion
// behind CodeRabbit's "unsafe to load" finding.
import {
  firstLanIPv4,
  parseDbDriver,
  parseDbEncryptionMode,
  parsePort,
  resolveEphemeralDbKey,
  startEmbeddedServer,
} from "./embedded.js";

describe("parsePort", () => {
  it("parses a valid port", () => {
    expect(parsePort("8080", 3000)).toBe(8080);
  });

  it("falls back for missing, non-numeric, or out-of-range values", () => {
    expect(parsePort(undefined, 3000)).toBe(3000);
    expect(parsePort("", 3000)).toBe(3000);
    expect(parsePort("not-a-port", 3000)).toBe(3000);
    expect(parsePort("0", 3000)).toBe(3000);
    expect(parsePort("70000", 3000)).toBe(3000);
    expect(parsePort("-1", 3000)).toBe(3000);
  });

  it("accepts the boundary ports", () => {
    expect(parsePort("1", 3000)).toBe(1);
    expect(parsePort("65535", 3000)).toBe(65535);
  });
});

describe("firstLanIPv4", () => {
  it("returns a string (an address or the localhost fallback)", () => {
    expect(typeof firstLanIPv4()).toBe("string");
  });
});

describe("parseDbDriver", () => {
  it("returns the supported driver values verbatim", () => {
    expect(parseDbDriver("better-sqlite3")).toBe("better-sqlite3");
    expect(parseDbDriver("node-sqlite")).toBe("node-sqlite");
  });

  it("returns undefined for missing or unrecognised values (leaving the buildApp default)", () => {
    expect(parseDbDriver(undefined)).toBeUndefined();
    expect(parseDbDriver("")).toBeUndefined();
    expect(parseDbDriver("better_sqlite3")).toBeUndefined();
    expect(parseDbDriver("sqlite")).toBeUndefined();
    expect(parseDbDriver("node:sqlite")).toBeUndefined();
  });
});

describe("parseDbEncryptionMode", () => {
  it("returns the four known modes verbatim", () => {
    expect(parseDbEncryptionMode("off")).toBe("off");
    expect(parseDbEncryptionMode("ephemeral")).toBe("ephemeral");
    expect(parseDbEncryptionMode("persistent")).toBe("persistent");
    expect(parseDbEncryptionMode("passphrase")).toBe("passphrase");
  });

  it("returns undefined for missing or unrecognised values", () => {
    expect(parseDbEncryptionMode(undefined)).toBeUndefined();
    expect(parseDbEncryptionMode("")).toBeUndefined();
    expect(parseDbEncryptionMode("hardware-hsm")).toBeUndefined();
  });
});

describe("resolveEphemeralDbKey (SF1/P1-1)", () => {
  it("is true for the legacy LOAM_DB_KEY=\"ephemeral\" literal, independent of the mode", () => {
    expect(resolveEphemeralDbKey("ephemeral", undefined)).toBe(true);
    expect(resolveEphemeralDbKey("ephemeral", "passphrase")).toBe(true);
  });

  it("P1-1: is true when the mode is ephemeral even though LOAM_DB_KEY carries a REAL hex key — the " +
    "exact Android repro that the literal-only check used to treat as a FIXED key", () => {
    expect(resolveEphemeralDbKey("9f1c...a real hex key...b7", "ephemeral")).toBe(true);
  });

  it("is false for a real key with a non-ephemeral (or absent) mode", () => {
    expect(resolveEphemeralDbKey("a real passphrase", "persistent")).toBe(false);
    expect(resolveEphemeralDbKey("a real passphrase", undefined)).toBe(false);
  });

  it("is false when neither LOAM_DB_KEY nor the mode is set (unencrypted boot)", () => {
    expect(resolveEphemeralDbKey(undefined, undefined)).toBe(false);
  });
});

describe("startEmbeddedServer env validation", () => {
  const envKeys = ["LOAM_DATA_DIR", "LOAM_CLIENT_DIST"] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  function stashEnv(): void {
    for (const key of envKeys) {
      saved[key] = process.env[key];
    }
  }

  it("rejects when LOAM_DATA_DIR is missing (before touching Fastify)", async () => {
    stashEnv();
    delete process.env.LOAM_DATA_DIR;
    delete process.env.LOAM_CLIENT_DIST;
    await expect(startEmbeddedServer()).rejects.toThrow(/LOAM_DATA_DIR/);
  });

  it("rejects when LOAM_CLIENT_DIST is missing", async () => {
    stashEnv();
    process.env.LOAM_DATA_DIR = "/tmp/loam-embedded-test-nonexistent";
    delete process.env.LOAM_CLIENT_DIST;
    await expect(startEmbeddedServer()).rejects.toThrow(/LOAM_CLIENT_DIST/);
  });
});
