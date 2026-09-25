/**
 * The last identity the SERVER confirmed for this browser (not the pre-hydration placeholder id), kept so
 * a boot can tell when the node handed back a different identity — its session was reset (Emergency
 * Reset, an expired cookie, a revoked token) while this browser was away and missed the `wipe` event.
 * The locally cached content then belongs to someone else and is purged (pre-release review 2026-09-25).
 */
export const CONFIRMED_USER_KEY = "loam.confirmedUserId";

/**
 * Record `userId` as the server-confirmed identity. Returns `true` when a DIFFERENT identity had been
 * confirmed before — the caller must purge cached content before using the new identity. The first-ever
 * confirmation (nothing stored) is not a change. Storage failures read as "no change".
 */
export function recordConfirmedIdentity(userId: string): boolean {
  let previous: string | null = null;
  try {
    previous = localStorage.getItem(CONFIRMED_USER_KEY);
    localStorage.setItem(CONFIRMED_USER_KEY, userId);
  } catch {
    return false;
  }
  return previous !== null && previous !== userId;
}

/** Forget the confirmed identity (part of a wipe). */
export function forgetConfirmedIdentity(): void {
  try {
    localStorage.removeItem(CONFIRMED_USER_KEY);
  } catch {
    // Nothing durable to clear.
  }
}
