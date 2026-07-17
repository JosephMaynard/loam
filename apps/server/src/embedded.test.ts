import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { buildApp } from "./app.js";

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

describe("resolveEphemeralDbKey (P1-3, Sol round 3)", () => {
  it("is true for the LOAM_DB_KEY=\"ephemeral\" literal — the only contract this checks", () => {
    expect(resolveEphemeralDbKey("ephemeral")).toBe(true);
  });

  it("P1-3: is false when LOAM_DB_KEY is unset, even though a caller might still declare " +
    "LOAM_DB_ENCRYPTION_MODE=\"ephemeral\" separately — the mode no longer feeds this decision at all. " +
    "This is exactly main.js's encrypted-driver-unavailable downgrade path: it now also resets the " +
    "mode to \"off\", but even if it didn't, this function alone must not resolve to ephemeral without " +
    "the literal — the P1-3 bug was resolving true from the mode alone with no key and nothing to " +
    "generate a key against, so the caller (embedded.ts) would set ephemeralDbKey=true and openStore " +
    "would then try to require the very encrypted native module main.js just proved was missing.", () => {
    expect(resolveEphemeralDbKey(undefined)).toBe(false);
  });

  it("is false for a real (non-literal) key, regardless of what it looks like", () => {
    expect(resolveEphemeralDbKey("a real passphrase")).toBe(false);
    expect(resolveEphemeralDbKey("9f1c...a real hex key...b7")).toBe(false);
  });

  it("is false when LOAM_DB_KEY is unset (unencrypted boot)", () => {
    expect(resolveEphemeralDbKey(undefined)).toBe(false);
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

describe("P1-3 regression (Sol round 3): main.js's encrypted-driver-unavailable downgrade must not crash-loop boot", () => {
  it("mode=ephemeral downgraded to 'off' with no LOAM_DB_KEY (main.js's fixed downgrade branch) boots UNENCRYPTED, no crash, posture reported as 'off'", async () => {
    // Reproduces exactly what apps/app/nodejs-project-template/main.js's encrypted-driver-unavailable
    // branch leaves behind AFTER the P1-3 fix: LOAM_DB_ENCRYPTION_MODE downgraded to 'off' (not left at
    // 'ephemeral') and LOAM_DB_KEY never set for this boot. Before the fix, LOAM_DB_ENCRYPTION_MODE
    // stayed 'ephemeral' and `resolveEphemeralDbKey(undefined, 'ephemeral')` returned true from the
    // mode alone (with no real key involved) — `embedded.ts` would then set `ephemeralDbKey: true`,
    // `buildApp` would generate a random key, and `openStore` would try to `require
    // ("better-sqlite3-multiple-ciphers")` — the exact native module main.js had just determined was
    // MISSING — crash-looping boot instead of degrading to plaintext.
    const dbKeyEnv: string | undefined = undefined; // main.js never sets LOAM_DB_KEY on this path
    const mode = parseDbEncryptionMode("off"); // main.js's fixed downgrade (was "ephemeral" before P1-3)
    const ephemeralDbKey = resolveEphemeralDbKey(dbKeyEnv);
    expect(ephemeralDbKey).toBe(false);

    const dataDir = mkdtempSync(join(tmpdir(), "loam-p1-3-regression-test-"));
    try {
      // Mirrors exactly what `startEmbeddedServer` (embedded.ts) passes to `buildApp` from these
      // derived values — the plaintext `node-sqlite` default driver, not `better-sqlite3`, since the
      // driver choice itself is orthogonal to this regression (the bug was never reaching a driver
      // choice at all — it crashed inside the encrypted-key branch before that).
      const app = await buildApp({
        dataDir,
        logger: false,
        dbEncryptionKey: ephemeralDbKey ? undefined : dbKeyEnv,
        ephemeralDbKey,
        dbEncryptionMode: mode,
      });
      try {
        const config = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
          networkConfig: { dbEncryption: string };
        };
        expect(config.networkConfig.dbEncryption).toBe("off");
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
