import { describe, expect, it } from "vitest";

// Importing this module must not boot a server (the auto-start lives in embedded-main.ts) — if it
// did, this test file would try to listen on load. That it imports cleanly is itself the assertion
// behind CodeRabbit's "unsafe to load" finding.
import { firstLanIPv4, parsePort } from "./embedded.js";

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
