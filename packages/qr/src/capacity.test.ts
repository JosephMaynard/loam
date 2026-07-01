import { describe, expect, it } from "vitest";

import { chooseVersion } from "./capacity.js";

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
});
