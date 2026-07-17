'use strict';

// Pure decision for how ONE boot attempt should configure the embedded server's DB-encryption env
// (Sol Fable-round-3 P1) — split out of main.js's `resolveDbEncryptionAndBoot` so the "every attempt is a
// FRESH boot configuration" contract is unit-testable (see apps/app/src/lib/boot-config.test.ts). main.js
// pulls in `rn-bridge` + boot side effects at import time, so it can't be `require`d from Vitest — same
// pattern as db-key-gate.js / start-fresh-marker.js / config-write.js.
//
// THE BUG THIS FIXES: `resolveDbEncryptionAndBoot` mutated `process.env` incrementally per attempt and never
// cleared `LOAM_DB_KEY` / `LOAM_DB_KEY_MIGRATE_FROM`. In the SAME Node process, an encrypted attempt could
// install `LOAM_DB_KEY`, then a retry resolve to `off` (or a driver-unavailable downgrade, or a
// plaintext-permitted locked-error recovery) — and inherit that stale key. `db.ts` gives `encryptionKey`
// precedence over the plaintext driver, so the supposedly-"off" retry would still open through SQLCipher:
// posture reports "off" while an encrypted backend is used, and an "off" mode hint may be written before a
// later cold start tries to open that encrypted DB as plaintext.
//
// THE CONTRACT: this returns ONLY the env vars to SET for the selected branch. The caller deletes ALL of
// `ENV_KEYS` first, then applies `env`, so no value from a prior attempt can leak in. Every proceeding
// branch sets `LOAM_DB_ENCRYPTION_MODE` (and, for plaintext branches, `LOAM_DB_DRIVER`) explicitly; encrypted
// branches leave `LOAM_DB_DRIVER` unset (openStore's encryptionKey path takes precedence). Locked outcomes
// set no key at all. Side effects (marker/hint writes, stale-DB deletion, boot-error notices) are returned as
// flags for the caller to perform, keeping this function pure.

// The literal `requestDbKey` resolves to when RN couldn't report its mode/key at all (timeout / read error /
// malformed) — NOT the same signal as a genuine `off`. Kept here and imported by main.js so the two agree.
var DB_KEY_LOCKED_ERROR = 'locked-error';

// Every per-attempt boot env var this decision owns. The caller DELETES all of these before applying the
// returned `env`, so a stale value from an earlier attempt can never survive into a later one.
var ENV_KEYS = [
  'LOAM_DB_ENCRYPTION_MODE',
  'LOAM_DB_DRIVER',
  'LOAM_DB_KEY',
  'LOAM_DB_KEY_MIGRATE_FROM',
  'LOAM_DB_KEY_REQUEST_ID',
];

/**
 * Whether a plaintext boot is authorized on a `locked-error` (RN couldn't report its mode). Mirrors
 * `mayBootPlaintextOnLockedError` in apps/app/src/lib/db-encryption.ts (harness-tested there; this CJS copy
 * is kept in sync by hand). Plaintext ONLY when the last-known mode was explicitly `off`, or the node is
 * genuinely fresh (confirmed-absent hint AND no DB file). Everything else LOCKS.
 */
function mayBootPlaintextOnLockedError(hint, dbExists) {
  return (hint.status === 'present' && hint.mode === 'off') || (hint.status === 'absent' && dbExists === false);
}

/**
 * Compute the boot configuration for one attempt.
 *
 * @param {{mode: string, key?: string, legacyKey?: string, requestId?: string}} result — `requestDbKey`'s result.
 * @param {{hint: {status: string, mode?: string}, dbExists: boolean, probeEncryptedDriver: () => boolean}} ctx
 * @returns {{outcome: 'proceed'|'locked', env: Object, writeHint?: string, clearEphemeralMarker?: boolean,
 *            deleteStaleEphemeralDb?: boolean, bootError?: {message: string, code: string}}}
 */
function computeDbBootEnv(result, ctx) {
  var mode = result.mode;
  var key = result.key;
  var legacyKey = result.legacyKey;
  var requestId = result.requestId;

  if (mode === DB_KEY_LOCKED_ERROR) {
    if (mayBootPlaintextOnLockedError(ctx.hint, ctx.dbExists)) {
      // No secret to protect — boot plaintext (availability over a transient lock, RF-c). The hint is left
      // untouched: a FAILED resolution isn't authoritative enough to write one.
      return {
        outcome: 'proceed',
        env: { LOAM_DB_ENCRYPTION_MODE: 'off', LOAM_DB_DRIVER: 'better-sqlite3' },
        clearEphemeralMarker: true,
      };
    }
    // A DB exists and the hint is absent/unreadable or a secret-based mode — do NOT downgrade to plaintext.
    return {
      outcome: 'locked',
      env: {},
      clearEphemeralMarker: true,
      bootError: {
        message:
          'Could not determine the on-device encryption mode this boot (a device security-store read ' +
          'failed, the request timed out, or the response was malformed) — refusing to start unencrypted. ' +
          'Retry once the app is responsive.',
        code: 'db_encryption_locked',
      },
    };
  }

  if (mode === 'off') {
    // The true default — plaintext, unchanged, silent (never a downgrade notice). Record the hint so a later
    // transient key-request failure may boot plaintext.
    return {
      outcome: 'proceed',
      env: { LOAM_DB_ENCRYPTION_MODE: 'off', LOAM_DB_DRIVER: 'better-sqlite3' },
      clearEphemeralMarker: true,
      writeHint: 'off',
    };
  }

  if (mode !== 'ephemeral' && !key) {
    // persistent/passphrase with no usable key — never fall back to plaintext; stay LOCKED. Record the real
    // secret-based selection (RF-c) so a later transient failure LOCKS rather than plaintext-boots.
    return {
      outcome: 'locked',
      env: { LOAM_DB_ENCRYPTION_MODE: mode },
      clearEphemeralMarker: true,
      writeHint: mode,
      bootError: {
        message:
          'Encryption mode "' +
          mode +
          '" is selected but no key is available yet (no passphrase entered, or a device Keystore/RNG ' +
          'failure) — refusing to start unencrypted.' +
          (mode === 'passphrase' ? ' Enter the passphrase to unlock.' : ' Retry, or open Encryption settings.'),
        code: 'db_encryption_locked',
      },
    };
  }

  if (!ctx.probeEncryptedDriver()) {
    // The SQLCipher native module isn't in this build — the ONE case an encrypted mode still boots plaintext
    // (a build seam, distinct from a missing KEY). Downgrade the driver AND the declared mode to match reality.
    return {
      outcome: 'proceed',
      env: { LOAM_DB_ENCRYPTION_MODE: 'off', LOAM_DB_DRIVER: 'better-sqlite3' },
      clearEphemeralMarker: true,
      writeHint: 'off',
      bootError: {
        message:
          "Encrypted storage needs the SQLCipher native module, which isn't in this build yet — starting UNENCRYPTED.",
        code: 'db_encryption_unavailable',
      },
    };
  }

  if (mode === 'ephemeral') {
    // The LITERAL 'ephemeral' — NOT a generated key. The server generates + holds its own RAM-only key,
    // which the kill switch rotates on a wipe. Leave the driver unset (encryptionKey path takes precedence).
    return {
      outcome: 'proceed',
      env: { LOAM_DB_ENCRYPTION_MODE: 'ephemeral', LOAM_DB_KEY: 'ephemeral' },
      deleteStaleEphemeralDb: true,
      writeHint: 'ephemeral',
    };
  }

  // persistent/passphrase WITH a key. Leave the driver unset (openStore's encryptionKey path wins). The
  // legacy key (pre-round-4 derivation) is offered only when RN hasn't recorded a confirmed migration yet;
  // the request id is the immutable per-boot correlation for the migration ack (P1-B).
  var env = { LOAM_DB_ENCRYPTION_MODE: mode, LOAM_DB_KEY: key };
  if (legacyKey) {
    env.LOAM_DB_KEY_MIGRATE_FROM = legacyKey;
  }
  if (requestId) {
    env.LOAM_DB_KEY_REQUEST_ID = requestId;
  }
  return {
    outcome: 'proceed',
    env: env,
    clearEphemeralMarker: true,
    writeHint: mode,
  };
}

/**
 * Apply one attempt's boot config to an env object: DELETE every per-attempt boot var first (so nothing
 * from a prior attempt survives), then set ONLY the values this attempt selected (`undefined` skipped).
 * The single production implementation of the "every attempt is a fresh configuration" contract — main.js
 * calls it with `process.env`, the tests with a seeded object, so there is no duplicated logic to drift.
 */
function applyBootEnvTo(env, values) {
  ENV_KEYS.forEach(function (k) {
    delete env[k];
  });
  Object.keys(values).forEach(function (k) {
    if (values[k] !== undefined) {
      env[k] = values[k];
    }
  });
  return env;
}

module.exports = {
  DB_KEY_LOCKED_ERROR: DB_KEY_LOCKED_ERROR,
  ENV_KEYS: ENV_KEYS,
  computeDbBootEnv: computeDbBootEnv,
  applyBootEnvTo: applyBootEnvTo,
  mayBootPlaintextOnLockedError: mayBootPlaintextOnLockedError,
};
