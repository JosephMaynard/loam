/**
 * Kiosk mode's password. Kept only as a scrypt hash (in memory, and in cli.json when the operator asks to
 * start locked), compared in constant time, and slowed down after a few wrong guesses so someone at the
 * keyboard can't run through a list of them.
 *
 * Kiosk mode locks the terminal UI, not the computer: anyone at an unlocked keyboard can still close the
 * window or open another terminal. The UI says so when kiosk mode is switched on.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 32;

/** The shortest password accepted. */
export const KIOSK_PASSWORD_MIN_LENGTH = 4;

/** `scrypt:<salt>:<hash>` for `password`. */
export function hashKioskPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFC"), salt, KEY_BYTES, SCRYPT);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

/** Whether `password` matches `stored`. A malformed `stored` never matches. */
export function verifyKioskPassword(password: string, stored: string): boolean {
  const [scheme, saltText, hashText] = stored.split(":");
  if (scheme !== "scrypt" || !saltText || !hashText) {
    return false;
  }
  const expected = Buffer.from(hashText, "base64url");
  if (expected.length !== KEY_BYTES) {
    return false;
  }
  const actual = scryptSync(password.normalize("NFC"), Buffer.from(saltText, "base64url"), KEY_BYTES, SCRYPT);
  return timingSafeEqual(actual, expected);
}

/** Wrong guesses allowed before each further guess has to wait. */
const FREE_ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;

export type KioskGuard = {
  /** Milliseconds until another guess is accepted (0 = now). */
  waitMs(): number;
  failed(): void;
  succeeded(): void;
};

/** After three wrong guesses, each further one waits twice as long as the last (2 s, 4 s … up to a minute). */
export function createKioskGuard(now: () => number = Date.now): KioskGuard {
  let failures = 0;
  let nextAllowedAt = 0;
  return {
    waitMs: () => Math.max(0, nextAllowedAt - now()),
    failed() {
      failures += 1;
      if (failures >= FREE_ATTEMPTS) {
        nextAllowedAt = now() + Math.min(MAX_WAIT_MS, 1_000 * 2 ** (failures - FREE_ATTEMPTS + 1));
      }
    },
    succeeded() {
      failures = 0;
      nextAllowedAt = 0;
    },
  };
}
