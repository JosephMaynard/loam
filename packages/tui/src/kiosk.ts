/**
 * Kiosk mode's password. Kept only as a scrypt hash (in memory, and in cli.json when the operator asks to
 * start locked), compared in constant time, and slowed down after a few wrong guesses so someone at the
 * keyboard can't run through a list of them.
 *
 * Kiosk mode locks the terminal UI, not the computer: anyone at an unlocked keyboard can still close the
 * window or open another terminal. The UI says so when kiosk mode is switched on.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type ScryptCost = { logN: number; r: number; p: number };

/**
 * The cost of a NEW hash: N = 2^17, r = 8, p = 1, about 128 MiB and a fraction of a second on a laptop, a few
 * seconds on a small board. It is written beside the hash, so raising it later leaves every saved password
 * working.
 */
const COST: ScryptCost = { logN: 17, r: 8, p: 1 };
/** The cost of a hash saved before the parameters were written with it (`scrypt:<salt>:<hash>`). */
const LEGACY_COST: ScryptCost = { logN: 15, r: 8, p: 1 };
/**
 * What a stored parameter set may ask for. cli.json is the operator's own file, but a typo in it must never
 * make unlocking allocate gigabytes or run for minutes.
 */
const COST_BOUNDS = { logN: [10, 18], r: [1, 8], p: [1, 4] } as const;
const KEY_BYTES = 32;

/** The shortest password accepted when one is chosen (a saved shorter one still unlocks). */
export const KIOSK_PASSWORD_MIN_LENGTH = 8;

function scryptOptions(cost: ScryptCost) {
  const N = 2 ** cost.logN;
  // Node refuses when 128 * N * r exceeds maxmem; allow twice what the parameters need.
  return { N, r: cost.r, p: cost.p, maxmem: 256 * N * cost.r };
}

function derive(password: string, salt: Buffer, cost: ScryptCost): Buffer {
  return scryptSync(password.normalize("NFC"), salt, KEY_BYTES, scryptOptions(cost));
}

/** `scrypt:<log2 N>:<r>:<p>:<salt>:<hash>` for `password`, at the current cost. */
export function hashKioskPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = derive(password, salt, COST);
  return `scrypt:${COST.logN}:${COST.r}:${COST.p}:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

function inBounds(value: number, [low, high]: readonly [number, number]): boolean {
  return Number.isInteger(value) && value >= low && value <= high;
}

/**
 * The parts of a stored kiosk hash: the current six-field form, or the three-field form older versions
 * wrote (read at the cost they used). Undefined for anything else, a parameter out of bounds included.
 */
export function parseKioskHash(stored: string): { cost: ScryptCost; salt: Buffer; hash: Buffer } | undefined {
  const parts = stored.split(":");
  if (parts[0] !== "scrypt") {
    return undefined;
  }
  let cost: ScryptCost;
  let saltText: string | undefined;
  let hashText: string | undefined;
  if (parts.length === 3) {
    cost = LEGACY_COST;
    [, saltText, hashText] = parts;
  } else if (parts.length === 6) {
    const [, logNText, rText, pText] = parts;
    if (![logNText, rText, pText].every((field) => /^\d{1,2}$/.test(field ?? ""))) {
      return undefined;
    }
    cost = { logN: Number(logNText), r: Number(rText), p: Number(pText) };
    if (!inBounds(cost.logN, COST_BOUNDS.logN) || !inBounds(cost.r, COST_BOUNDS.r) || !inBounds(cost.p, COST_BOUNDS.p)) {
      return undefined;
    }
    [, , , , saltText, hashText] = parts;
  } else {
    return undefined;
  }
  if (!saltText || !hashText) {
    return undefined;
  }
  const salt = Buffer.from(saltText, "base64url");
  const hash = Buffer.from(hashText, "base64url");
  if (salt.length < 8 || hash.length !== KEY_BYTES) {
    return undefined;
  }
  return { cost, salt, hash };
}

/** Whether `password` matches `stored`. A malformed `stored` never matches. */
export function verifyKioskPassword(password: string, stored: string): boolean {
  const parsed = parseKioskHash(stored);
  if (!parsed) {
    return false;
  }
  return timingSafeEqual(derive(password, parsed.salt, parsed.cost), parsed.hash);
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
