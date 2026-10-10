// scrypt-hashed secret storage + constant-time comparison.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const secretHashPrefix = "scrypt:";

export const secretHashPattern = /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/;

/**
 * Compare two secrets in constant time, whatever their lengths: both are reduced to SHA-256 digests (always
 * 32 bytes) and the digests compared with `timingSafeEqual`, so neither the length nor the position of the
 * first difference shows in the timing, and two different strings never compare equal (no truncation).
 * Suitable only for high-entropy, memory-only values (the one-time setup code, the host token); stored
 * secrets use scrypt instead.
 */
export function timingSafeEqualStrings(left: string, right: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(left), digest(right));
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

/** Whether a stored secret is already in the `scrypt:<salt>:<hash>` form (vs plaintext from a config file / PATCH). */
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
