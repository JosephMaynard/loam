import { afterEach, describe, expect, it } from "vitest";

// Importing this module must not boot a server (the auto-start lives in embedded-main.ts) — if it
// did, this test file would try to listen on load. That it imports cleanly is itself the assertion
// behind CodeRabbit's "unsafe to load" finding.
import { firstLanIPv4, parsePort, startEmbeddedServer } from "./embedded.js";

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
