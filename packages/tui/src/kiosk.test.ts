import { describe, expect, it } from "vitest";

import { createKioskGuard, hashKioskPassword, verifyKioskPassword } from "./kiosk.js";

describe("kiosk password", () => {
  it("matches only the right password, and never a malformed hash", () => {
    const stored = hashKioskPassword("open sesame");
    expect(stored).toMatch(/^scrypt:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(verifyKioskPassword("open sesame", stored)).toBe(true);
    expect(verifyKioskPassword("open sesam", stored)).toBe(false);
    expect(hashKioskPassword("open sesame")).not.toBe(stored);
    expect(verifyKioskPassword("x", "plain:x")).toBe(false);
    expect(verifyKioskPassword("x", "scrypt:abc:short")).toBe(false);
  });

  it("slows guessing down after three wrong passwords, doubling up to a minute", () => {
    let now = 0;
    const guard = createKioskGuard(() => now);
    guard.failed();
    guard.failed();
    expect(guard.waitMs()).toBe(0);
    guard.failed();
    expect(guard.waitMs()).toBe(2_000);
    now += 2_000;
    guard.failed();
    expect(guard.waitMs()).toBe(4_000);
    for (let index = 0; index < 10; index += 1) {
      guard.failed();
    }
    expect(guard.waitMs()).toBe(60_000);
    guard.succeeded();
    expect(guard.waitMs()).toBe(0);
  });
});
