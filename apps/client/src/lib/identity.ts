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

/** The identity the server last confirmed for this browser, if any (storage failures read as none). */
export function readConfirmedIdentity(): string | undefined {
  try {
    return localStorage.getItem(CONFIRMED_USER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Watch for ANOTHER tab confirming a different identity (pre-release review 2026-09-25). Tabs share
 * IndexedDB and localStorage: when one of them learns the node reset this browser's identity, it purges the
 * shared cache — but a sibling tab still holds the previous identity's content in memory (and may have
 * hydrated it just before the purge). `mine()` is the identity this tab's content belongs to (`undefined`
 * while it holds none); `onChange` runs when a sibling records a different one. A removal (a wipe) is left
 * to the wipe listener. Returns an unsubscribe.
 */
export function listenForIdentityChange(mine: () => string | undefined, onChange: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== CONFIRMED_USER_KEY || event.newValue === null) {
      return;
    }
    const current = mine();
    if (current !== undefined && current !== event.newValue) {
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** Forget the confirmed identity (part of a wipe). */
export function forgetConfirmedIdentity(): void {
  try {
    localStorage.removeItem(CONFIRMED_USER_KEY);
  } catch {
    // Nothing durable to clear.
  }
}
