import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createKioskGuard, hashKioskPassword, KIOSK_PASSWORD_MIN_LENGTH, parseKioskHash, verifyKioskPassword } from "./kiosk.js";

/** A hash as versions before the written-out cost saved it: `scrypt:<salt>:<hash>` at N = 2^15. */
function legacyHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFC"), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

describe("kiosk password", () => {
  it("matches only the right password, and never a malformed hash", () => {
    const stored = hashKioskPassword("open sesame");
    expect(stored).toMatch(/^scrypt:17:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(verifyKioskPassword("open sesame", stored)).toBe(true);
    expect(verifyKioskPassword("open sesam", stored)).toBe(false);
    expect(hashKioskPassword("open sesame")).not.toBe(stored);
    expect(verifyKioskPassword("x", "plain:x")).toBe(false);
    expect(verifyKioskPassword("x", "scrypt:abc:short")).toBe(false);
    expect(verifyKioskPassword("x", "scrypt:17:8:1:abc:short")).toBe(false);
    expect(verifyKioskPassword("x", "scrypt:17:8:abc:short")).toBe(false);
  });

  it("writes the cost beside a new hash at N = 2^17", () => {
    const parsed = parseKioskHash(hashKioskPassword("open sesame"));
    expect(parsed?.cost).toEqual({ logN: 17, r: 8, p: 1 });
    expect(parsed?.salt).toHaveLength(16);
    expect(parsed?.hash).toHaveLength(32);
  });

  it("still unlocks with a hash an older version saved, at the cost it used", () => {
    const stored = legacyHash("abcd");
    expect(parseKioskHash(stored)?.cost).toEqual({ logN: 15, r: 8, p: 1 });
    expect(verifyKioskPassword("abcd", stored)).toBe(true);
    expect(verifyKioskPassword("abce", stored)).toBe(false);
    expect("abcd".length).toBeLessThan(KIOSK_PASSWORD_MIN_LENGTH);
  });

  it("refuses a stored cost outside the bounds, or one that isn't a number", () => {
    const [, , , , salt, hash] = hashKioskPassword("open sesame").split(":");
    expect(parseKioskHash(`scrypt:19:8:1:${salt}:${hash}`)).toBeUndefined();
    expect(parseKioskHash(`scrypt:9:8:1:${salt}:${hash}`)).toBeUndefined();
    expect(parseKioskHash(`scrypt:17:9:1:${salt}:${hash}`)).toBeUndefined();
    expect(parseKioskHash(`scrypt:17:8:5:${salt}:${hash}`)).toBeUndefined();
    expect(parseKioskHash(`scrypt:1e1:8:1:${salt}:${hash}`)).toBeUndefined();
    expect(parseKioskHash(`scrypt:17:8:1:${salt}:${hash}`)).toBeDefined();
    expect(verifyKioskPassword("open sesame", `scrypt:19:8:1:${salt}:${hash}`)).toBe(false);
  });

  it("asks for at least eight characters", () => {
    expect(KIOSK_PASSWORD_MIN_LENGTH).toBe(8);
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
