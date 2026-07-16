// Smoke test for the Vitest harness itself (see apps/app/vitest.config.ts,
// src/test-utils/mocks.ts): proves a real pure-logic module (db-encryption.ts) can be exercised
// end-to-end against the in-memory expo-secure-store/expo-crypto mocks, matching the security
// invariants documented at the top of db-encryption.ts (device secret minted once and reused;
// passphrase-mode key is exactly `SHA256(passphrase + ':' + deviceSecret)`).
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSecureStoreFailure,
  cryptoMock,
  failSecureStoreItem,
  resetCryptoMock,
  resetSecureStoreMock,
  secureStoreMock,
} from "@/test-utils/mocks";

vi.mock("expo-secure-store", () => secureStoreMock);
vi.mock("expo-crypto", () => cryptoMock);

const {
  DB_ENCRYPTION_MODE_READ_ERROR,
  DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE,
  applyDbModeChange,
  clearStoredPassphrase,
  dbEncryptionRecoveryForCode,
  dbModeSelectionIsDestructive,
  getDbEncryptionMode,
  hasStoredPassphrase,
  markPassphraseKeyMigrated,
  mayBootPlaintextOnLockedError,
  registerDbEncryption,
  requestDbStartFresh,
  resolveDbKey,
  setDbEncryptionMode,
  setDbModeHint,
  setPassphraseCandidate,
  setStoredPassphrase,
} = await import("@/lib/db-encryption");
type BridgeChannel = import("@/lib/db-encryption").BridgeChannel;
type DbEncryptionMode = import("@/lib/db-encryption").DbEncryptionMode;
type DbEncryptionModeOrError = import("@/lib/db-encryption").DbEncryptionModeOrError;
type SetDbEncryptionModeResult = import("@/lib/db-encryption").SetDbEncryptionModeResult;
type SetDbModeHintResult = import("@/lib/db-encryption").SetDbModeHintResult;

const PASSPHRASE_ITEM = "loam-db-encryption-passphrase";
const PASSPHRASE_CANDIDATE_ITEM = "loam-db-encryption-passphrase-candidate";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Flush pending async work for `registerDbEncryption`'s `onRequest`/`onMigrated` handlers (themselves
 * awaiting several chained SecureStore/Crypto mock calls) before asserting on `channel.posted` or on a
 * follow-up `resolveDbKey` call's observable effect. A macrotask boundary (rather than a fixed count of
 * microtask turns) is used deliberately — it's robust regardless of exactly how many awaits the chain
 * happens to have. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Minimal in-memory `BridgeChannel` test double — an event-name -> handler-set map, matching the
 * addListener/removeListener/post surface `registerDbEncryption` uses. `emit` synchronously invokes
 * every currently-registered handler for `name`. */
function makeFakeChannel(): BridgeChannel & { emit: (name: string, payload?: unknown) => void; posted: { name: string; payload: unknown }[] } {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const posted: { name: string; payload: unknown }[] = [];
  return {
    posted,
    addListener(name, handler) {
      if (!handlers.has(name)) {
        handlers.set(name, new Set());
      }
      handlers.get(name)!.add(handler);
    },
    removeListener(name, handler) {
      handlers.get(name)?.delete(handler);
    },
    post(name, payload) {
      posted.push({ name, payload });
    },
    emit(name, payload) {
      for (const handler of handlers.get(name) ?? []) {
        handler(payload);
      }
    },
  };
}

describe("resolveDbKey", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("persistent mode mints a device secret once and reuses it on later calls", async () => {
    const first = await resolveDbKey("persistent");
    expect(first.mode).toBe("persistent");
    expect(first.key).toBeTruthy();

    const second = await resolveDbKey("persistent");
    expect(second.key).toBe(first.key);
  });

  it("passphrase mode derives SHA256(passphrase + ':' + deviceSecret)", async () => {
    await setStoredPassphrase("hunter2");
    const { key: deviceSecret } = await resolveDbKey("persistent");
    expect(deviceSecret).toBeTruthy();

    const { key } = await resolveDbKey("passphrase");
    const expected = sha256Hex(`hunter2:${deviceSecret}`);
    expect(key).toBe(expected);
  });

  it("passphrase mode resolves with no key when no passphrase has been stored", async () => {
    const { key } = await resolveDbKey("passphrase");
    expect(key).toBeUndefined();
  });

  describe("P1-1 (Sol round 5): passphrase key-derivation migration", () => {
    it("includes legacyKey = SHA256(passphrase) alongside the current key when no migration is recorded yet", async () => {
      await setStoredPassphrase("hunter2");
      const result = await resolveDbKey("passphrase");

      expect(result.legacyKey).toBe(sha256Hex("hunter2"));
      // The current (non-legacy) key is still the round-4+ derivation, unchanged.
      const { key: deviceSecret } = await resolveDbKey("persistent");
      expect(result.key).toBe(sha256Hex(`hunter2:${deviceSecret}`));
    });

    it("omits legacyKey once markPassphraseKeyMigrated has been called", async () => {
      await setStoredPassphrase("hunter2");
      // Sanity: legacyKey is offered before migration is recorded.
      expect((await resolveDbKey("passphrase")).legacyKey).toBeTruthy();

      await markPassphraseKeyMigrated();

      const migrated = await resolveDbKey("passphrase");
      expect(migrated.legacyKey).toBeUndefined();
      expect(migrated.key).toBeTruthy();
    });

    it("a fresh install (passphrase set, migration never needed) still offers legacyKey until markPassphraseKeyMigrated is called — mirrors the server's 'never needed but still confirms' path", async () => {
      // No pre-existing DB simulation needed here — this module has no DB awareness; it just reflects
      // whether ITS OWN migration marker has been recorded, regardless of whether a legacy key would
      // ever actually be useful server-side.
      await setStoredPassphrase("a brand new passphrase");
      expect((await resolveDbKey("passphrase")).legacyKey).toBeTruthy();
      await markPassphraseKeyMigrated();
      expect((await resolveDbKey("passphrase")).legacyKey).toBeUndefined();
    });
  });
});

describe("getDbEncryptionMode (P1-3, Sol round 5)", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("resolves to 'off' after a SUCCESSFUL read that finds nothing stored (null)", async () => {
    await expect(getDbEncryptionMode()).resolves.toBe("off");
  });

  it("resolves to the distinct read-error sentinel — never 'off' — when the underlying read throws", async () => {
    failSecureStoreItem("loam-db-encryption-mode", new Error("Keystore unavailable"));
    await expect(getDbEncryptionMode()).resolves.toBe(DB_ENCRYPTION_MODE_READ_ERROR);
  });
});

describe("setDbEncryptionMode (P1-3, Sol round 5)", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("reports ok:true on a successful write", async () => {
    await expect(setDbEncryptionMode("persistent")).resolves.toEqual({ ok: true });
  });

  it("reports ok:false (never throws) when the underlying write throws", async () => {
    failSecureStoreItem("loam-db-encryption-mode", new Error("Keystore unavailable"));
    const result = await setDbEncryptionMode("persistent");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Keystore unavailable");
  });
});

describe("registerDbEncryption", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("P1-3: forwards a mode read-error as {mode:'error'} over the bridge, never {mode:'off'}", async () => {
    failSecureStoreItem("loam-db-encryption-mode", new Error("Keystore unavailable"));
    const channel = makeFakeChannel();
    const cleanup = registerDbEncryption(channel);
    try {
      channel.emit("loam-db-key-request");
      // The responder's work is async (it awaits getDbEncryptionMode/resolveDbKey) — flush microtasks.
      await flushMicrotasks();

      expect(channel.posted).toEqual([{ name: "loam-db-key-response", payload: { mode: "error" } }]);
    } finally {
      cleanup();
    }
  });

  it("LOW-6: echoes the launcher's requestId so a late reply can't satisfy a later request", async () => {
    await setStoredPassphrase("hunter2");
    await setDbEncryptionMode("passphrase");
    const channel = makeFakeChannel();
    const cleanup = registerDbEncryption(channel);
    try {
      channel.emit("loam-db-key-request", { requestId: "dbkey-7" });
      await flushMicrotasks();

      const payload = channel.posted[0]!.payload as { mode: string; requestId?: string };
      expect(payload.mode).toBe("passphrase");
      expect(payload.requestId).toBe("dbkey-7");
    } finally {
      cleanup();
    }
  });

  it("LOW-6: omits requestId when the launcher sends none (older-launcher tolerance)", async () => {
    await setDbEncryptionMode("off");
    const channel = makeFakeChannel();
    const cleanup = registerDbEncryption(channel);
    try {
      channel.emit("loam-db-key-request");
      await flushMicrotasks();

      const payload = channel.posted[0]!.payload as { mode: string; requestId?: string };
      expect(payload.mode).toBe("off");
      expect("requestId" in payload).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("P1-1: records a confirmed migration when the launcher signals loam-db-key-migrated", async () => {
    await setStoredPassphrase("hunter2");
    expect((await resolveDbKey("passphrase")).legacyKey).toBeTruthy();

    const channel = makeFakeChannel();
    const cleanup = registerDbEncryption(channel);
    try {
      channel.emit("loam-db-key-migrated");
      await flushMicrotasks();

      expect((await resolveDbKey("passphrase")).legacyKey).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("a normal request posts the resolved mode/key (and legacyKey when offered) back over the bridge", async () => {
    await setStoredPassphrase("hunter2");
    // Select passphrase mode via the persisted selection this responder actually reads.
    await setDbEncryptionMode("passphrase");

    const channel = makeFakeChannel();
    const cleanup = registerDbEncryption(channel);
    try {
      channel.emit("loam-db-key-request");
      await flushMicrotasks();

      expect(channel.posted).toHaveLength(1);
      const payload = channel.posted[0]!.payload as { mode: string; key?: string; legacyKey?: string };
      expect(payload.mode).toBe("passphrase");
      expect(payload.key).toBeTruthy();
      expect(payload.legacyKey).toBe(sha256Hex("hunter2"));
    } finally {
      cleanup();
    }
  });
});

describe("mayBootPlaintextOnLockedError (P1-1, Sol round 7 — tri-state hint)", () => {
  it("an existing encrypted install upgrading (confirmed-absent hint) with a DB present → LOCK (false)", () => {
    expect(mayBootPlaintextOnLockedError({ status: "absent" }, true)).toBe(false);
  });

  it("off→encrypted (present encrypted-mode hint) with a DB present + timeout → LOCK (false)", () => {
    expect(mayBootPlaintextOnLockedError({ status: "present", mode: "persistent" }, true)).toBe(false);
    expect(mayBootPlaintextOnLockedError({ status: "present", mode: "passphrase" }, true)).toBe(false);
    expect(mayBootPlaintextOnLockedError({ status: "present", mode: "ephemeral" }, true)).toBe(false);
  });

  it("a genuinely fresh node — CONFIRMED-absent hint AND no DB file — + timeout → plaintext is safe (true)", () => {
    expect(mayBootPlaintextOnLockedError({ status: "absent" }, false)).toBe(true);
  });

  it("RF6-c: a KNOWN encrypted-mode hint with NO DB file still LOCKS (false)", () => {
    // Ephemeral mode wipes its DB every boot (dbExists=false), and a freshly-selected persistent/
    // passphrase mode has no DB yet — but the operator explicitly chose an encrypted mode, so a
    // transient error must NOT boot plaintext and write an unencrypted loam.db (a confidentiality
    // downgrade vs. the chosen mode).
    expect(mayBootPlaintextOnLockedError({ status: "present", mode: "ephemeral" }, false)).toBe(false);
    expect(mayBootPlaintextOnLockedError({ status: "present", mode: "persistent" }, false)).toBe(false);
    expect(mayBootPlaintextOnLockedError({ status: "present", mode: "passphrase" }, false)).toBe(false);
  });

  it("an explicit present-'off' hint authorizes plaintext regardless of whether a DB exists (true)", () => {
    expect(mayBootPlaintextOnLockedError({ status: "present", mode: "off" }, true)).toBe(true);
    expect(mayBootPlaintextOnLockedError({ status: "present", mode: "off" }, false)).toBe(true);
  });

  it("P1-1 round-7 hole 1: a hint READ-ERROR always LOCKS, even ephemeral (no DB) — never plaintext", () => {
    // The ephemeral case: no DB at boot + a hint that FAILED to read. The old boolean gate collapsed this
    // to `undefined + no DB → plaintext`; the tri-state 'error' status must LOCK instead.
    expect(mayBootPlaintextOnLockedError({ status: "error" }, false)).toBe(false);
    expect(mayBootPlaintextOnLockedError({ status: "error" }, true)).toBe(false);
  });

  it("P1-1 round-7: a truncated/unrecognized hint surfaces as 'error' → LOCK (never treated as absent)", () => {
    // `readDbModeHint` (main.js) returns { status: 'error' } for malformed/truncated/unrecognized
    // contents — this helper must LOCK on it, not boot plaintext, regardless of the DB.
    expect(mayBootPlaintextOnLockedError({ status: "error" }, false)).toBe(false);
    expect(mayBootPlaintextOnLockedError({ status: "error" }, true)).toBe(false);
  });
});

describe("applyDbModeChange (P1-3, Sol round 8 — serialized, re-read, no mode/hint divergence)", () => {
  /** Build scripted `readMode`/`writeMode`/`writeHint` deps plus a call log so a test can assert BOTH the
   * outcome and that the writes happened in the divergence-safe order. `previous` is what `readMode`
   * returns (the committed mode re-read INSIDE the lock — no longer a positional arg). */
  function makeDeps(opts: { previous?: DbEncryptionModeOrError; modeOk?: boolean; hintOk?: boolean } = {}) {
    const previous = opts.previous ?? "off";
    const modeOk = opts.modeOk ?? true;
    const hintOk = opts.hintOk ?? true;
    const calls: string[] = [];
    return {
      calls,
      readMode: async (): Promise<DbEncryptionModeOrError> => previous,
      writeMode: async (m: DbEncryptionMode): Promise<SetDbEncryptionModeResult> => {
        calls.push(`mode:${m}`);
        return modeOk ? { ok: true } : { ok: false, error: "mode write failed" };
      },
      writeHint: async (m: DbEncryptionMode): Promise<SetDbModeHintResult> => {
        calls.push(`hint:${m}`);
        return hintOk ? { ok: true } : { ok: false, error: "hint write failed" };
      },
    };
  }

  it("off→encrypted with a hint WRITE FAILURE does NOT commit the SecureStore mode (prevents divergence)", async () => {
    const deps = makeDeps({ previous: "off", hintOk: false });
    const outcome = await applyDbModeChange("persistent", deps);
    expect(outcome.applied).toBe(false);
    expect(outcome.committedMode).toBe("off");
    // The hint is attempted FIRST; because it failed, the SecureStore mode write is never reached — so the
    // committed mode can never be 'persistent' while the hint still says 'off'.
    expect(deps.calls).toEqual(["hint:persistent"]);
  });

  it("an encrypted selection whose SecureStore write fails rolls the hint back to the RE-READ `previous`", async () => {
    const deps = makeDeps({ previous: "off", modeOk: false });
    const outcome = await applyDbModeChange("persistent", deps);
    expect(outcome.applied).toBe(false);
    expect(outcome.committedMode).toBe("off");
    // hint(persistent) succeeded, mode(persistent) failed → hint rolled back to the re-read previous 'off'.
    expect(deps.calls).toEqual(["hint:persistent", "mode:persistent", "hint:off"]);
  });

  it("an encrypted selection with BOTH writes succeeding is applied (hint first, then mode)", async () => {
    const deps = makeDeps({ previous: "off" });
    const outcome = await applyDbModeChange("passphrase", deps);
    expect(outcome).toEqual({ applied: true, committedMode: "passphrase" });
    expect(deps.calls).toEqual(["hint:passphrase", "mode:passphrase"]);
  });

  it("'off' commits directly and treats the hint as best-effort (a hint failure is only a soft warning)", async () => {
    const deps = makeDeps({ previous: "persistent", hintOk: false });
    const outcome = await applyDbModeChange("off", deps);
    expect(outcome.applied).toBe(true);
    expect(outcome.committedMode).toBe("off");
    expect(outcome.hintWarning).toBe(true);
    // 'off' writes the mode FIRST (a stale encrypted hint only over-locks, never downgrades).
    expect(deps.calls).toEqual(["mode:off", "hint:off"]);
  });

  it("'off' with a failing SecureStore write is NOT applied (and never touches the hint)", async () => {
    const deps = makeDeps({ previous: "persistent", modeOk: false });
    const outcome = await applyDbModeChange("off", deps);
    expect(outcome.applied).toBe(false);
    expect(outcome.committedMode).toBe("persistent");
    expect(deps.calls).toEqual(["mode:off"]);
  });

  it("a READ-ERROR on the committed mode ABORTS the transaction — no writes, no committedMode", async () => {
    // Without a known committed mode there is no safe rollback target, so the transaction refuses to touch
    // SecureStore or the hint at all.
    const deps = makeDeps({ previous: DB_ENCRYPTION_MODE_READ_ERROR });
    const outcome = await applyDbModeChange("persistent", deps);
    expect(outcome.applied).toBe(false);
    expect(outcome.committedMode).toBeUndefined();
    expect(outcome.error).toBeTruthy();
    expect(deps.calls).toEqual([]);
  });

  it("serializes concurrent transitions and re-reads the committed mode inside the lock — never leaves mode/hint divergent", async () => {
    // Reproduces the exact P1-3 A/B interleaving from off: A (off→persistent) and B (off→off) racing. A
    // shared backing store models SecureStore mode + the hint; readMode reflects prior committed writes.
    const store = { mode: "off" as DbEncryptionMode, hint: "off" as DbEncryptionMode };
    const readModes: DbEncryptionMode[] = [];

    // Gate A's FIRST writeHint so A is paused mid-transaction while we start B.
    let releaseAHint: () => void = () => undefined;
    const aHintGate = new Promise<void>((resolve) => {
      releaseAHint = resolve;
    });
    let firstHint = true;

    const deps = {
      readMode: async (): Promise<DbEncryptionModeOrError> => {
        readModes.push(store.mode);
        return store.mode;
      },
      writeMode: async (m: DbEncryptionMode): Promise<SetDbEncryptionModeResult> => {
        store.mode = m;
        return { ok: true };
      },
      writeHint: async (m: DbEncryptionMode): Promise<SetDbModeHintResult> => {
        if (firstHint) {
          firstHint = false;
          await aHintGate;
        }
        store.hint = m;
        return { ok: true };
      },
    };

    // A starts: acquires the lock, re-reads 'off', reaches the paused writeHint('persistent').
    const aPromise = applyDbModeChange("persistent", deps);
    await flushMicrotasks();
    // B starts WHILE A is paused mid-transaction.
    const bPromise = applyDbModeChange("off", deps);
    await flushMicrotasks();

    // The mutex must keep B from starting: only A's readMode has run, and A hasn't committed its mode yet
    // (its hint is still paused, before the mode write).
    expect(readModes).toEqual(["off"]);
    expect(store.mode).toBe("off");

    // Let A finish; B then runs to completion.
    releaseAHint();
    const [aOutcome, bOutcome] = await Promise.all([aPromise, bPromise]);

    expect(aOutcome.applied).toBe(true);
    expect(bOutcome.applied).toBe(true);
    // B re-read the ACTUALLY-committed 'persistent' inside its own lock turn — NOT the stale 'off' the
    // caller would have captured.
    expect(readModes).toEqual(["off", "persistent"]);
    // Final state is COHERENT — never the fail-open (SecureStore encrypted + hint 'off').
    expect(store.mode).toBe("off");
    expect(store.hint).toBe("off");
  });
});

describe("dbModeSelectionIsDestructive (P1-4-RN, Sol round 8)", () => {
  it("treats every encrypted mode as destructive (needs explicit confirmation) and 'off' as safe", () => {
    expect(dbModeSelectionIsDestructive("off")).toBe(false);
    expect(dbModeSelectionIsDestructive("ephemeral")).toBe(true);
    expect(dbModeSelectionIsDestructive("persistent")).toBe(true);
    expect(dbModeSelectionIsDestructive("passphrase")).toBe(true);
  });
});

describe("dbEncryptionRecoveryForCode (P1-4-RN, Sol round 8)", () => {
  it("maps the plaintext_unconverted boot code to the destructive plaintext-unconverted recovery UI", () => {
    expect(dbEncryptionRecoveryForCode(DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE)).toBe("plaintext-unconverted");
  });

  it("maps the other DB-encryption recovery codes to their own recovery UI", () => {
    expect(dbEncryptionRecoveryForCode("db_encryption_unreadable")).toBe("unreadable");
    expect(dbEncryptionRecoveryForCode("db_encryption_locked")).toBe("locked");
  });

  it("returns null for codes with no dedicated recovery (and for undefined)", () => {
    expect(dbEncryptionRecoveryForCode("boot_timeout")).toBeNull();
    expect(dbEncryptionRecoveryForCode("db_encryption_unavailable")).toBeNull();
    expect(dbEncryptionRecoveryForCode(undefined)).toBeNull();
  });
});

describe("setDbModeHint (P1-b, Sol round 6)", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("posts a loam-db-set-mode-hint carrying the mode NAME and resolves ok on a matching result", async () => {
    const channel = makeFakeChannel();
    const promise = setDbModeHint(channel, "persistent");

    const request = channel.posted.find((p) => p.name === "loam-db-set-mode-hint");
    expect(request).toBeTruthy();
    const payload = request!.payload as { requestId: string; mode: string };
    expect(payload.mode).toBe("persistent");
    expect(typeof payload.requestId).toBe("string");

    channel.emit("loam-db-set-mode-hint-result", { requestId: payload.requestId, ok: true });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("resolves ok:false on a timeout (host never answered)", async () => {
    const channel = makeFakeChannel();
    const result = await setDbModeHint(channel, "off", 5);
    expect(result.ok).toBe(false);
  });

  it("ignores a result for a different requestId", async () => {
    const channel = makeFakeChannel();
    const promise = setDbModeHint(channel, "passphrase", 50);
    channel.emit("loam-db-set-mode-hint-result", { requestId: "not-mine", ok: true });
    // Still pending → falls through to the timeout as ok:false.
    await expect(promise).resolves.toEqual({ ok: false, error: expect.any(String) });
  });
});

describe("requestDbStartFresh intent threading (Sol P1 / release blocker)", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("posts intent 'delete' in the loam-db-start-fresh payload (deliberate destructive mode change)", async () => {
    const channel = makeFakeChannel();
    const promise = requestDbStartFresh(channel, "delete");

    const request = channel.posted.find((p) => p.name === "loam-db-start-fresh");
    expect(request).toBeTruthy();
    const payload = request!.payload as { requestId: string; intent: string };
    expect(payload.intent).toBe("delete");
    expect(typeof payload.requestId).toBe("string");

    // The launcher acks only after durably writing the marker; a matching ack resolves the round trip.
    channel.emit("loam-db-start-fresh-result", { requestId: payload.requestId, ok: true });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("posts intent 'preserve' in the loam-db-start-fresh payload (accidental wrong/lost-key recovery)", async () => {
    const channel = makeFakeChannel();
    const promise = requestDbStartFresh(channel, "preserve");

    const request = channel.posted.find((p) => p.name === "loam-db-start-fresh");
    expect(request).toBeTruthy();
    const payload = request!.payload as { requestId: string; intent: string };
    expect(payload.intent).toBe("preserve");
    expect(typeof payload.requestId).toBe("string");

    channel.emit("loam-db-start-fresh-result", { requestId: payload.requestId, ok: true });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("keeps the requestId round-trip: a result for a different requestId is ignored (falls through to timeout)", async () => {
    const channel = makeFakeChannel();
    const promise = requestDbStartFresh(channel, "delete", 20);
    channel.emit("loam-db-start-fresh-result", { requestId: "not-mine", ok: true });
    await expect(promise).resolves.toEqual({ ok: false, error: expect.any(String) });
  });

  it("resolves ok:false (never throws) when post() throws", async () => {
    const channel = makeFakeChannel();
    const throwing: typeof channel = {
      ...channel,
      post: () => {
        throw new Error("bridge down");
      },
    };
    const result = await requestDbStartFresh(throwing, "delete");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bridge down");
  });

  it("resolves ok:false on a timeout (host never answered)", async () => {
    const channel = makeFakeChannel();
    const result = await requestDbStartFresh(channel, "preserve", 5);
    expect(result.ok).toBe(false);
  });
});

describe("passphrase unlock CANDIDATE (P2-a, Sol round 6)", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("setPassphraseCandidate does NOT commit the passphrase (hasStoredPassphrase stays 'absent')", async () => {
    await setPassphraseCandidate("a-guess");
    expect(await hasStoredPassphrase()).toBe("absent");
    expect(await secureStoreMock.getItemAsync(PASSPHRASE_ITEM)).toBeNull();
  });

  it("resolveDbKey('passphrase') falls back to the candidate when nothing is committed", async () => {
    await setPassphraseCandidate("a-guess");
    const { key: deviceSecret } = await resolveDbKey("persistent");
    const { key } = await resolveDbKey("passphrase");
    expect(key).toBe(sha256Hex(`a-guess:${deviceSecret}`));
  });

  it("a committed passphrase takes precedence over a leftover candidate", async () => {
    await setStoredPassphrase("committed");
    await setPassphraseCandidate("stale-guess");
    const { key: deviceSecret } = await resolveDbKey("persistent");
    const { key } = await resolveDbKey("passphrase");
    expect(key).toBe(sha256Hex(`committed:${deviceSecret}`));
  });

  it("markPassphraseKeyMigrated PROMOTES a verified candidate to the committed passphrase and clears it", async () => {
    await setPassphraseCandidate("verified-guess");
    // Simulate main.js resolving the key from the candidate, then the server confirming the DB opened.
    await resolveDbKey("passphrase");
    await markPassphraseKeyMigrated();

    expect(await secureStoreMock.getItemAsync(PASSPHRASE_ITEM)).toBe("verified-guess");
    expect(await hasStoredPassphrase()).toBe("present");
    expect(await secureStoreMock.getItemAsync(PASSPHRASE_CANDIDATE_ITEM)).toBeNull();
  });

  it("markPassphraseKeyMigrated never CLOBBERS a committed passphrase with a stale candidate", async () => {
    await setStoredPassphrase("correct");
    await setPassphraseCandidate("wrong-leftover");
    await markPassphraseKeyMigrated();

    // The committed passphrase that actually opened the DB is preserved; the stale candidate is dropped.
    expect(await secureStoreMock.getItemAsync(PASSPHRASE_ITEM)).toBe("correct");
    expect(await secureStoreMock.getItemAsync(PASSPHRASE_CANDIDATE_ITEM)).toBeNull();
  });
});

describe("hasStoredPassphrase tri-state (P1-3, Sol round 7)", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("returns 'absent' after a SUCCESSFUL read that finds nothing committed", async () => {
    await expect(hasStoredPassphrase()).resolves.toBe("absent");
  });

  it("returns 'present' when a committed passphrase exists", async () => {
    await setStoredPassphrase("committed");
    await expect(hasStoredPassphrase()).resolves.toBe("present");
  });

  it("returns 'error' (NEVER 'absent') on a SecureStore read failure — the UI must not expose overwrite entry", async () => {
    // A transient read failure used to collapse to `false`/'absent', which showed "No passphrase set" and
    // re-exposed the first-time-entry (committed-overwrite) path even though a passphrase was in fact set.
    await setStoredPassphrase("still-committed");
    failSecureStoreItem(PASSPHRASE_ITEM, new Error("Keystore unavailable"));
    await expect(hasStoredPassphrase()).resolves.toBe("error");
  });
});

describe("clearStoredPassphrase verified deletion (P1-3, Sol round 7)", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("reports ok:true and removes BOTH the committed passphrase and any pending candidate on success", async () => {
    await setStoredPassphrase("committed");
    await setPassphraseCandidate("pending");
    await expect(clearStoredPassphrase()).resolves.toEqual({ ok: true });
    expect(await secureStoreMock.getItemAsync(PASSPHRASE_ITEM)).toBeNull();
    expect(await secureStoreMock.getItemAsync(PASSPHRASE_CANDIDATE_ITEM)).toBeNull();
  });

  it("reports ok:false on a delete failure — and the committed passphrase is NOT removed (no false 'forgotten')", async () => {
    await setStoredPassphrase("committed");
    failSecureStoreItem(PASSPHRASE_ITEM, new Error("Keystore unavailable"));

    const result = await clearStoredPassphrase();
    expect(result.ok).toBe(false);
    expect(result.error).toContain(PASSPHRASE_ITEM);

    // Clear the injected failure and confirm the committed passphrase is still there — so the UI, which
    // only reports "forgotten" on ok:true, keeps `hasStoredPassphrase === 'present'` and never re-exposes
    // the first-time-entry path that would overwrite it.
    clearSecureStoreFailure(PASSPHRASE_ITEM);
    expect(await secureStoreMock.getItemAsync(PASSPHRASE_ITEM)).toBe("committed");
  });
});

describe("passphrase settings entry uses the CANDIDATE flow (P1-3, Sol round 7)", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("an existing DB + no committed SecureStore entry: a settings passphrase entry never overwrites the committed value", async () => {
    // Simulate the locked-settings path: a passphrase was previously committed (the DB is encrypted under
    // it), and the operator opens settings and types a DIFFERENT passphrase. The settings entry stores a
    // CANDIDATE (setPassphraseCandidate) — it must NOT clobber the committed passphrase, so the DB stays
    // recoverable under the original.
    await setStoredPassphrase("original-committed");
    await setPassphraseCandidate("new-entry-from-settings");

    // The committed value is untouched; resolveDbKey still derives from the COMMITTED passphrase.
    expect(await secureStoreMock.getItemAsync(PASSPHRASE_ITEM)).toBe("original-committed");
    const { key: deviceSecret } = await resolveDbKey("persistent");
    const { key } = await resolveDbKey("passphrase");
    expect(key).toBe(sha256Hex(`original-committed:${deviceSecret}`));
  });
});
