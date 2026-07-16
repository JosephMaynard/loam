// Tests the pure per-attempt boot-env decision extracted from nodejs-project-template/main.js into
// boot-config.js (Sol Fable-round-3 P1). main.js itself can't be `require`d from this harness (rn-bridge +
// boot side effects at import), so this dependency-free helper is the unit-testable seam.
//
// THE FINDING: `resolveDbEncryptionAndBoot` mutated process.env incrementally and never cleared LOAM_DB_KEY,
// so an off/locked/downgrade retry in the same process could inherit a key from an earlier encrypted attempt
// (db.ts gives encryptionKey precedence over the plaintext driver → an "off" retry still opens SQLCipher).
// The fix: every attempt is a FRESH configuration — the caller DELETES all ENV_KEYS then applies ONLY the
// returned `env`. These tests assert (a) the returned env per scenario carries no stale key, and (b) the
// clear-then-apply contract removes a pre-existing stale key for a plaintext resolution.
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeDbBootEnv, applyBootEnvTo, DB_KEY_LOCKED_ERROR } = require("../../nodejs-project-template/boot-config.js");

const withDriver = () => ({ probeEncryptedDriver: () => true });
const noDriver = () => ({ probeEncryptedDriver: () => false });
const absentHint = { status: "absent" as const };

/** Exercise the PRODUCTION `applyBootEnvTo` (the same clear-then-apply main.js uses on `process.env`, per
 * CodeRabbit) against a seeded environment, so the "no stale key survives" contract is verified end-to-end
 * with no duplicated test logic. */
function applyContract(seed: Record<string, string>, env: Record<string, string>): Record<string, string | undefined> {
  return applyBootEnvTo({ ...seed }, env);
}

describe("computeDbBootEnv — no stale key leaks across attempts (Sol Fable-round-3 P1)", () => {
  it("off resolution carries NO key, and the clear-then-apply contract removes a stale LOAM_DB_KEY", () => {
    const cfg = computeDbBootEnv({ mode: "off" }, { hint: absentHint, dbExists: false, ...withDriver() });
    expect(cfg.outcome).toBe("proceed");
    expect(cfg.env.LOAM_DB_KEY).toBeUndefined();
    expect(cfg.env.LOAM_DB_ENCRYPTION_MODE).toBe("off");
    expect(cfg.env.LOAM_DB_DRIVER).toBe("better-sqlite3");
    // A prior encrypted attempt left LOAM_DB_KEY / MIGRATE_FROM / REQUEST_ID — they must be GONE now.
    const applied = applyContract(
      { LOAM_DB_KEY: "stale-encrypted-key", LOAM_DB_KEY_MIGRATE_FROM: "stale-legacy", LOAM_DB_KEY_REQUEST_ID: "r0" },
      cfg.env,
    );
    expect(applied.LOAM_DB_KEY).toBeUndefined();
    expect(applied.LOAM_DB_KEY_MIGRATE_FROM).toBeUndefined();
    expect(applied.LOAM_DB_KEY_REQUEST_ID).toBeUndefined();
    expect(applied.LOAM_DB_ENCRYPTION_MODE).toBe("off");
  });

  it("a missing-SQLCipher-driver downgrade of an encrypted key resolves to plaintext WITHOUT the key", () => {
    const cfg = computeDbBootEnv(
      { mode: "passphrase", key: "an-encrypted-key" },
      { hint: { status: "present", mode: "passphrase" }, dbExists: true, ...noDriver() },
    );
    expect(cfg.outcome).toBe("proceed");
    expect(cfg.env.LOAM_DB_KEY).toBeUndefined();
    expect(cfg.env.LOAM_DB_ENCRYPTION_MODE).toBe("off");
    expect(cfg.env.LOAM_DB_DRIVER).toBe("better-sqlite3");
    expect(cfg.bootError?.code).toBe("db_encryption_unavailable");
    expect(applyContract({ LOAM_DB_KEY: "an-encrypted-key" }, cfg.env).LOAM_DB_KEY).toBeUndefined();
  });

  it("a locked-error where plaintext IS permitted (hint off) boots plaintext with no key", () => {
    const cfg = computeDbBootEnv(
      { mode: DB_KEY_LOCKED_ERROR, key: "leftover" },
      { hint: { status: "present", mode: "off" }, dbExists: true, ...withDriver() },
    );
    expect(cfg.outcome).toBe("proceed");
    expect(cfg.env.LOAM_DB_KEY).toBeUndefined();
    expect(cfg.env.LOAM_DB_ENCRYPTION_MODE).toBe("off");
    expect(applyContract({ LOAM_DB_KEY: "leftover" }, cfg.env).LOAM_DB_KEY).toBeUndefined();
  });

  it("a locked-error where plaintext is NOT permitted locks, sets no key, and reports db_encryption_locked", () => {
    const cfg = computeDbBootEnv(
      { mode: DB_KEY_LOCKED_ERROR, key: "leftover" },
      { hint: absentHint, dbExists: true, ...withDriver() },
    );
    expect(cfg.outcome).toBe("locked");
    expect(cfg.env.LOAM_DB_KEY).toBeUndefined();
    expect(cfg.bootError?.code).toBe("db_encryption_locked");
    expect(applyContract({ LOAM_DB_KEY: "leftover" }, cfg.env).LOAM_DB_KEY).toBeUndefined();
  });

  it("persistent/passphrase with NO key locks (never plaintext) and sets no key", () => {
    const cfg = computeDbBootEnv({ mode: "passphrase" }, { hint: absentHint, dbExists: false, ...withDriver() });
    expect(cfg.outcome).toBe("locked");
    expect(cfg.env.LOAM_DB_KEY).toBeUndefined();
    expect(cfg.writeHint).toBe("passphrase");
    expect(cfg.bootError?.code).toBe("db_encryption_locked");
  });

  it("passphrase WITH a key threads key + legacy + request-id and leaves the driver unset", () => {
    const cfg = computeDbBootEnv(
      { mode: "passphrase", key: "K", legacyKey: "L", requestId: "dbkey-9" },
      { hint: absentHint, dbExists: false, ...withDriver() },
    );
    expect(cfg.outcome).toBe("proceed");
    expect(cfg.env).toEqual({
      LOAM_DB_ENCRYPTION_MODE: "passphrase",
      LOAM_DB_KEY: "K",
      LOAM_DB_KEY_MIGRATE_FROM: "L",
      LOAM_DB_KEY_REQUEST_ID: "dbkey-9",
    });
    expect(cfg.env.LOAM_DB_DRIVER).toBeUndefined();
    expect(cfg.writeHint).toBe("passphrase");
  });

  it("ephemeral resolves to the literal key + stale-DB deletion, no legacy/request-id", () => {
    const cfg = computeDbBootEnv({ mode: "ephemeral" }, { hint: absentHint, dbExists: false, ...withDriver() });
    expect(cfg.outcome).toBe("proceed");
    expect(cfg.env).toEqual({ LOAM_DB_ENCRYPTION_MODE: "ephemeral", LOAM_DB_KEY: "ephemeral" });
    expect(cfg.deleteStaleEphemeralDb).toBe(true);
    expect(cfg.writeHint).toBe("ephemeral");
  });
});
