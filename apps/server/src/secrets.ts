// scrypt-hashed secret storage + constant-time comparison. Extracted from app.ts (2026-09-04 split).
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const secretHashPrefix = "scrypt:";

export const secretHashPattern = /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/;

export const secretCompareLength = 256;

/**
 * Compare two short secrets in constant time by padding both to a fixed length. Suitable only for
 * high-entropy, memory-only values (the one-time setup code) — stored secrets use scrypt instead.
 */
export function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftPadded = Buffer.alloc(secretCompareLength);
  const rightPadded = Buffer.alloc(secretCompareLength);
  Buffer.from(left).copy(leftPadded);
  Buffer.from(right).copy(rightPadded);
  return timingSafeEqual(leftPadded, rightPadded) && left.length === right.length;
}

/**
 * Hash a user-chosen secret (admin passphrase / panic token) for storage, so a seized node's
 * config never reveals the secret itself.
 *
 * @returns A self-describing `scrypt:<salt-hex>:<hash-hex>` string
 */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 32);
  return `${secretHashPrefix}${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function isHashedSecret(value: string): boolean {
  // Match the full format, not just the prefix — a malformed "scrypt:…" value is treated as a
  // plaintext secret and hashed, rather than stored unverifiable.
  return secretHashPattern.test(value);
}

/**
 * Verify a candidate secret against a stored `scrypt:` hash in constant time.
 */
export function verifySecret(candidate: string, stored: string): boolean {
  if (!isHashedSecret(stored)) {
    return timingSafeEqualStrings(candidate, stored);
  }

  const [saltHex = "", hashHex = ""] = stored.slice(secretHashPrefix.length).split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(candidate, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}
