import { describe, expect, it } from "vitest";

import { chooseVersion, getVersionInfo } from "./capacity.js";
import type { QRVersion } from "./types.js";

describe("chooseVersion", () => {
  it("picks the smallest version that fits byte mode H payloads", () => {
    expect(chooseVersion(34)).toBe(4);
    expect(chooseVersion(35)).toBe(5);
    expect(chooseVersion(44)).toBe(5);
    expect(chooseVersion(45)).toBe(6);
    expect(chooseVersion(58)).toBe(6);
  });

  it("throws when the payload exceeds version 6-H", () => {
    expect(() => chooseVersion(59)).toThrow(/exceeds QR version 6-H capacity/);
  });

  it("throws when byte length is not a non-negative integer", () => {
    expect(() => chooseVersion(-1)).toThrow(/non-negative integer/);
    expect(() => chooseVersion(1.5)).toThrow(/non-negative integer/);
  });

  it("picks the smallest version for level M, at roughly double H's capacity (docs/15 #10)", () => {
    expect(chooseVersion(62, "M")).toBe(4);
    expect(chooseVersion(63, "M")).toBe(5);
    expect(chooseVersion(84, "M")).toBe(5);
    expect(chooseVersion(85, "M")).toBe(6);
    expect(chooseVersion(106, "M")).toBe(6);
  });

  it("throws when the payload exceeds version 6-M", () => {
    expect(() => chooseVersion(107, "M")).toThrow(/exceeds QR version 6-M capacity/);
  });

  it("defaults to level H when no level is given", () => {
    expect(chooseVersion(58)).toBe(chooseVersion(58, "H"));
  });
});

describe("getVersionInfo", () => {
  it("gives every level of a version the same total codeword count (data + EC across all blocks)", () => {
    // A structural cross-check on the ISO 18004 tables: total codewords for a version is fixed
    // regardless of error correction level (only the data/EC split within that budget changes).
    for (const version of [4, 5, 6] as const satisfies readonly QRVersion[]) {
      const totals = (["H", "M"] as const).map((level) => {
        const info = getVersionInfo(version, level);
        return info.blocks.reduce(
          (sum, group) => sum + group.count * (group.dataCodewords + (group.ecCodewordsPerBlock ?? info.ecCodewordsPerBlock)),
          0,
        );
      });

      expect(totals[0]).toBe(totals[1]);
    }
  });

  it("gives level M roughly double level H's byte capacity at each version", () => {
    for (const version of [4, 5, 6] as const satisfies readonly QRVersion[]) {
      const h = getVersionInfo(version, "H").byteCapacity;
      const m = getVersionInfo(version, "M").byteCapacity;

      expect(m).toBeGreaterThan(h * 1.5);
    }
  });
});
