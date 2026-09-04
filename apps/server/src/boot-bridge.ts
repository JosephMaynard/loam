// Best-effort reporters onto the Android launcher's `globalThis.__loam*` bridge hooks. Silent no-ops
// on every other host. Extracted from app.ts (2026-09-04 split).
/**
 * Best-effort report of a NON-FATAL boot notice to the RN host bridge (F4, docs/15). Reuses the same
 * `globalThis.__loamReportBootError` hook `embedded-main.ts` uses for fatal startup failures — the
 * launcher (`apps/app/nodejs-project-template/main.js`) installs it on `global` before requiring the
 * server bundle, same pattern as {@link OnDeviceChatHook} above. Absent on every other host
 * (desktop/Pi/CI, and most tests), so this is a silent no-op there. Used when the encrypted-DB open
 * degrades instead of failing boot outright (`db_encryption_open_failed` / `db_encryption_unreadable`)
 * so the RN host screen can still surface a "change encryption settings" action even though boot
 * itself succeeded. Never pass the key or any derived secret in `message`.
 */
export function reportBootNotice(message: string, code: string): void {
  try {
    const reporter = (globalThis as { __loamReportBootError?: (message: string, code: string) => void })
      .__loamReportBootError;
    reporter?.(message, code);
  } catch (reportError) {
    console.error("Failed to report boot notice to the RN host:", reportError);
  }
}

/**
 * Best-effort signal to the RN host bridge that a passphrase-mode DB was just migrated to the current
 * key derivation (P1-1, Sol round 5 — see `AppOptions.dbEncryptionMigrateFromKey` and `openInitialStore`
 * below). `globalThis.__loamReportDbKeyMigrated` is installed by `nodejs-project-template/main.js`
 * before requiring the server bundle, same pattern as {@link reportBootNotice}; on the Android host it
 * forwards to `db-encryption.ts`'s `markPassphraseKeyMigrated()` so future boots stop offering the
 * legacy key. Absent (a silent no-op) on every other host and in tests that don't install it. Never
 * passes any key material — this is a bare signal, not a payload.
 *
 * `requestId` is the launcher's IMMUTABLE per-boot key-handoff id (Sol Fable-round-2 P1-B), threaded from
 * `AppOptions.dbKeyRequestId` (which `embedded.ts` reads from `LOAM_DB_KEY_REQUEST_ID` once at boot). The RN
 * side promotes only the candidate bound to THIS id, so a duplicate/later unlock can't mis-tag the report.
 * It is NOT key material — just the correlation id already visible in the clear on the bridge.
 */
export function reportDbKeyMigrated(requestId?: string): void {
  try {
    const reporter = (globalThis as { __loamReportDbKeyMigrated?: (requestId?: string) => void })
      .__loamReportDbKeyMigrated;
    reporter?.(requestId);
  } catch (reportError) {
    console.error("Failed to report DB key migration to the RN host:", reportError);
  }
}
