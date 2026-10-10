// The constant-time comparison and scrypt storage helpers in secrets.ts.
import { describe, expect, it } from "vitest";

import { hashSecret, timingSafeEqualStrings, verifySecret } from "./secrets.js";

describe("timingSafeEqualStrings", () => {
  it("tells apart strings that differ only past the first 256 bytes", () => {
    const prefix = "a".repeat(300);
    expect(timingSafeEqualStrings(`${prefix}x`, `${prefix}y`)).toBe(false);
    expect(timingSafeEqualStrings(`${prefix}x`, `${prefix}x`)).toBe(true);
  });

  it("tells apart strings of the same length in UTF-16 units but different bytes", () => {
    expect(timingSafeEqualStrings("é", "e")).toBe(false);
    expect(timingSafeEqualStrings("", "")).toBe(true);
    expect(timingSafeEqualStrings("code", "code ")).toBe(false);
  });

  it("is what verifySecret falls back to for a plaintext stored secret", () => {
    const long = "b".repeat(400);
    expect(verifySecret(`${long}1`, `${long}2`)).toBe(false);
    expect(verifySecret("hunter2", hashSecret("hunter2"))).toBe(true);
    expect(verifySecret("hunter3", hashSecret("hunter2"))).toBe(false);
  });
});
