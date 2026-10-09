// RN-side key resolution for on-device DB encryption (docs/01, docs/21). This is the other half
// of `nodejs-project-template/main.js`'s key-handoff request/response: the embedded server has no
// Keystore access of its own, so the operator's chosen mode — and any generated/derived key material —
// lives entirely here, backed by `expo-secure-store` (Android Keystore). main.js REQUESTS a key at
// boot and this module ANSWERS; see `registerDbEncryption` below.
//
// Security invariants (do not relax without re-reading CLAUDE.md's transport/encryption sections):
//   - Key material for 'persistent'/'passphrase' modes lives ONLY in `expo-secure-store`, never in
//     AsyncStorage or a plain file. The mode selection itself is not secret, but is stored the same way
//     for simplicity (one storage primitive, one dependency).
//   - The ephemeral key is generated fresh on every call and is NEVER persisted anywhere.
//   - Nothing in this module ever logs key or passphrase material.
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { addOwnListener, type BridgeSubscription } from './bridge-listener';

export type DbEncryptionMode = 'off' | 'ephemeral' | 'persistent' | 'passphrase';

export const DB_ENCRYPTION_MODES: readonly DbEncryptionMode[] = ['off', 'ephemeral', 'persistent', 'passphrase'];
// Each mode's name and one-line description for the picker live in the catalogs (`encryption.mode*` /
// `encryption.desc*` in src/lib/i18n), read by components/db-encryption-settings.tsx.

const MODE_ITEM = 'loam-db-encryption-mode';
const PERSISTENT_KEY_ITEM = 'loam-db-encryption-persistent-key';
/**
 * LEGACY: older installs COMMITTED the operator's passphrase here, so every boot auto-unlocked from the
 * device, which made passphrase mode protect nothing beyond `persistent` (anyone holding the unlocked phone
 * had both the device secret and the passphrase). It is NEVER written. It is still READ, once: an existing
 * install's DB opens under it for that boot, and the confirmed-open ack ({@link markPassphraseKeyMigrated})
 * then deletes it. From then on the passphrase is asked for at every start and is at rest on the device only
 * as a transient boot {@link PASSPHRASE_CANDIDATE_ITEM}.
 */
const PASSPHRASE_ITEM = 'loam-db-encryption-passphrase';
/**
 * Non-secret marker (`'1'`) that a passphrase GOVERNS this database — set once the DB has actually opened
 * under one (the confirmed-open ack). Replaces "is a passphrase committed?" as the settings UI's notion of
 * "set", since the passphrase itself is never stored. Cleared by Forget.
 */
const PASSPHRASE_SET_ITEM = 'loam-db-encryption-passphrase-set';
/**
 * The boot-time passphrase ENTRY. Entered on the `db_encryption_locked`
 * / unreadable recovery screens (or pre-entered in Settings for the next start) and stored HERE only until
 * `resolveDbKey('passphrase')` reads it — which CONSUMES it. It is tried, never committed: a WRONG entry
 * fails to open the intact database (recoverable — the operator enters it again), and a RIGHT one needs
 * nothing further. So the passphrase is at rest on the device only between the operator typing it and the
 * next key resolution, never across a boot: every start asks for it again, which is what makes this mode
 * actually stronger than `persistent` (a stolen unlocked phone holds the device secret but not the
 * passphrase). NOTE: an authenticated, in-place passphrase-REKEY transaction — atomically re-keying the
 * existing DB so its data survives a passphrase change — is a documented FUTURE enhancement (docs/21); it
 * does not exist today, so CHANGING a passphrase is only possible via the explicit destructive start-fresh
 * flow (which discards the existing encrypted data).
 */
const PASSPHRASE_CANDIDATE_ITEM = 'loam-db-encryption-passphrase-candidate';
/**
 * The one piece of key material a wipe can actually DISCARD. A user-chosen passphrase can never itself
 * be made cryptographically discardable (the operator can always type it again), so `persistent`/
 * `passphrase` mode both key off this random, device-generated secret instead: `persistent` uses it
 * directly, `passphrase` mixes it into the passphrase's digest (see `resolveDbKey` below). Deleting THIS
 * item (and minting a fresh one on next use) is what makes a wipe of either mode genuinely rotate the key,
 * even though the operator's passphrase is unchanged by the wipe.
 */
const DEVICE_SECRET_ITEM = 'loam-db-encryption-device-secret';
/**
 * Marks a passphrase-mode DB as confirmed-migrated to the CURRENT key derivation. The passphrase key was
 * once `SHA256(passphrase)` (legacy) and is now `SHA256(passphrase + ':' + deviceSecret)` (current); a
 * passphrase DB created under the old scheme can only be opened with the legacy derivation. Absent (or
 * any value other than {@link CURRENT_PASSPHRASE_KEY_VERSION}) means "not confirmed migrated yet", so `resolveDbKey` keeps
 * offering the legacy key alongside the current one until the server confirms a successful migration
 * (`markPassphraseKeyMigrated`, called from `registerDbEncryption`'s `loam-db-key-migrated` listener).
 */
const PASSPHRASE_KEY_VERSION_ITEM = 'loam-db-passphrase-key-version';
const CURRENT_PASSPHRASE_KEY_VERSION = '2';

// Outstanding passphrase-mode key-handoff attempts keyed by the launcher's opaque per-request id. The flow
// is correlated end-to-end: main.js posts `loam-db-key-request { requestId }`; the responder records the
// attempt id here (only the id, never the entry itself); main.js accepts exactly the response whose id
// matches and echoes it back in the `loam-db-key-migrated { requestId }` ack; `markPassphraseKeyMigrated`
// then acts ONLY for an attempt still present here, recording that a passphrase governs the DB and retiring
// any legacy stored copy (it never stores the passphrase). A candidate replacement
// (`setPassphraseCandidate`) or a forget (`clearStoredPassphrase`) INVALIDATES every outstanding attempt, so
// a stale/late ack can neither confirm an attempt the operator moved past nor resurrect a forgotten
// passphrase's "set" state. Bounded so a run of timed-out attempts can't grow it without limit.
const pendingPassphraseAttempts = new Set<string>();
const MAX_PENDING_PASSPHRASE_ATTEMPTS = 16;

// Passphrase-state MUTEX. Invalidating `pendingPassphraseAttempts` only clears
// attempts ALREADY inserted — it does nothing about a resolve that has read the old candidate but is still
// awaiting SecureStore/digest work before it inserts, nor about a promotion paused mid-way across a Forget's
// deletion. Both let a forgotten/replaced candidate get resurrected. So EVERY operation that touches
// passphrase candidate/commit state runs to completion under this single lock: the responder's resolve+
// remember (as one critical section — locking the resolve alone leaves a gap before the remember),
// `setPassphraseCandidate`, `clearStoredPassphrase`, and `markPassphraseKeyMigrated`.
// Serialized, none can interleave across an await, so the invalidate-then-resolve ordering is linearizable.
let passphraseStateChain: Promise<unknown> = Promise.resolve();

/**
 * Run `op` after every previously-queued passphrase-state op has fully settled (kept alive across a
 * rejection so one failure can't wedge the lock). This is the transaction lock the {@link
 * pendingPassphraseAttempts} map alone can't provide — it makes each operation atomic w.r.t. every other.
 */
function runPassphraseExclusive<T>(op: () => Promise<T>): Promise<T> {
  const run = passphraseStateChain.then(op, op);
  passphraseStateChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Record an issued passphrase-mode attempt by its request id (evicting the oldest past the cap). Only the
 * id is kept, never the entry itself: the ack needs nothing more, and a module whose guarantee is "never at
 * rest" must not hold plaintext passphrases in the heap either. */
function rememberPassphraseAttempt(requestId: string): void {
  // Re-inserting refreshes recency (delete-then-add moves it to the end of the Set's insertion order).
  pendingPassphraseAttempts.delete(requestId);
  pendingPassphraseAttempts.add(requestId);
  while (pendingPassphraseAttempts.size > MAX_PENDING_PASSPHRASE_ATTEMPTS) {
    const oldest = pendingPassphraseAttempts.values().next().value;
    if (oldest === undefined) {
      break;
    }
    pendingPassphraseAttempts.delete(oldest);
  }
}

/** Invalidate every outstanding boot attempt — called whenever the pending candidate is replaced or the
 * passphrase is forgotten, so no in-flight/late attempt can be promoted after the operator moved on. */
function invalidatePassphraseAttempts(): void {
  pendingPassphraseAttempts.clear();
}

export type ResolvedDbKey = {
  mode: DbEncryptionMode;
  key?: string;
  /**
   * The legacy passphrase key derivation (`SHA256(passphrase)` alone, no device secret), present
   * ONLY for `mode === 'passphrase'` when this device hasn't recorded a confirmed migration yet. main.js threads it to the server as `LOAM_DB_KEY_MIGRATE_FROM`; `openInitialStore`
   * tries `key` first and falls back to this only on failure, rekeying the DB to `key` in place on
   * success. Never present for any other mode.
   */
  legacyKey?: string;
};

/** The subset of the nodejs-mobile bridge channel this module uses (kept loose, matching the other
 * RN↔launcher bridges — on-device-llm.ts, mesh-courier.ts, model-manager-bridge.ts). */
export interface BridgeChannel {
  // Returns RN's EventSubscription at runtime (see bridge-listener.ts); `void` covers test doubles.
  addListener(name: string, handler: (payload: unknown) => void): BridgeSubscription | void;
  removeAllListeners(name: string): void;
  post(name: string, payload: unknown): void;
}

function isDbEncryptionMode(value: unknown): value is DbEncryptionMode {
  return typeof value === 'string' && (DB_ENCRYPTION_MODES as readonly string[]).includes(value);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Distinct sentinel returned by {@link getDbEncryptionMode} on a genuine SecureStore READ FAILURE,
 * never conflated with `'off'`. A successful read that comes back `null`/absent/
 * garbage IS genuinely "no mode ever selected", and `'off'` is the correct, safe default for THAT case;
 * a thrown read (Keystore unavailable, corrupt store) tells you nothing about the operator's actual
 * choice, so it must stay distinguishable. Any caller that feeds a BOOT decision (`registerDbEncryption`
 * below, and main.js's `requestDbKey`) must treat this the same as "no usable key" (lock), never as
 * `'off'` (which would silently downgrade an operator's encrypted mode to plaintext on a transient
 * error). UI-only callers may treat it as "unknown, don't overwrite the last-known display". */
export const DB_ENCRYPTION_MODE_READ_ERROR = 'error' as const;
export type DbEncryptionModeOrError = DbEncryptionMode | typeof DB_ENCRYPTION_MODE_READ_ERROR;

/** Read the operator's persisted mode choice. Returns `'off'` ONLY after a successful read that came back
 * genuinely absent (`null` — "nothing selected yet", the safe default); returns
 * {@link DB_ENCRYPTION_MODE_READ_ERROR} on a thrown read AND on a non-null but corrupted/unrecognized
 * stored value. Neither may be silently reported as `'off'`, since a
 * caller feeding a boot decision would then downgrade an operator's encrypted mode to plaintext on a mere
 * transient Keystore hiccup OR a tampered/garbled item. Only confirmed absence is treated as "off". */
export async function getDbEncryptionMode(): Promise<DbEncryptionModeOrError> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(MODE_ITEM);
  } catch {
    return DB_ENCRYPTION_MODE_READ_ERROR;
  }
  if (raw === null) {
    return 'off';
  }
  return isDbEncryptionMode(raw) ? raw : DB_ENCRYPTION_MODE_READ_ERROR;
}

/** Result of {@link setDbEncryptionMode}: a REAL success/failure, not a swallowed best-effort, so the settings UI can surface a failed write as a failure rather than implying the mode
 *  was actually applied. `error` is a generic, human-readable summary — never key/passphrase material
 *  (this call never touches any, but kept consistent with the other Result types in this module). */
export type SetDbEncryptionModeResult = { ok: boolean; error?: string };

/** Persist the operator's mode choice, reporting whether the write actually succeeded: a failed write must
 * not be presented to the operator as "applied", because the picker's NEXT read returns whatever was stored
 * before, not the mode they just thought they set. */
export async function setDbEncryptionMode(mode: DbEncryptionMode): Promise<SetDbEncryptionModeResult> {
  try {
    await SecureStore.setItemAsync(MODE_ITEM, mode);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Tri-state answer to "does a passphrase GOVERN this database?". Deliberately NOT a boolean: a SecureStore
 * READ FAILURE is `'error'`, NEVER `'absent'`, so a transient Keystore hiccup can't make the picker show "No
 * passphrase set" and offer a first-time-entry path. `'present'` = the {@link PASSPHRASE_SET_ITEM} marker is
 * recorded (a DB opened under a passphrase) OR a legacy committed passphrase still exists (an older install
 * that hasn't booted since); `'absent'` = successful reads found neither; `'error'` = a read threw.
 * The passphrase itself is never stored, so this never returns (or reveals) it. */
export type PassphrasePresence = 'present' | 'absent' | 'error';

export async function hasStoredPassphrase(): Promise<PassphrasePresence> {
  let marker: string | null;
  let legacy: string | null;
  try {
    marker = await SecureStore.getItemAsync(PASSPHRASE_SET_ITEM);
    legacy = await SecureStore.getItemAsync(PASSPHRASE_ITEM);
  } catch {
    return 'error';
  }
  return marker === '1' || (typeof legacy === 'string' && legacy.length > 0) ? 'present' : 'absent';
}

/**
 * Store the boot-time passphrase ENTRY; see {@link PASSPHRASE_CANDIDATE_ITEM}. It is
 * TRIED (and consumed) by the next `resolveDbKey('passphrase')`, never committed: a wrong entry leaves the
 * database untouched and recoverable for another attempt, and a right one is simply not needed again until
 * the next start asks. Never logged; never written anywhere but the Keystore-backed secure store.
 */
export async function setPassphraseCandidate(passphrase: string): Promise<void> {
  await runPassphraseExclusive(async () => {
    // Write the new candidate FIRST, then invalidate every outstanding boot attempt: a late response for a
    // PRIOR candidate must never be promotable once the operator has entered a new one, but if the write
    // itself FAILS the still-valid prior attempts must stand, since no replacement actually landed. Under the lock this whole write-then-invalidate is atomic w.r.t. every resolve/promote.
    await SecureStore.setItemAsync(PASSPHRASE_CANDIDATE_ITEM, passphrase);
    invalidatePassphraseAttempts();
  });
}

/**
 * Forget everything passphrase-related on the device: the "a passphrase governs this DB" marker, any LEGACY
 * committed passphrase, any pending boot entry, and the key-version marker (e.g. the operator switches away
 * from passphrase mode), VERIFYING each is actually gone afterward. The database itself is untouched: it
 * still opens under the same passphrase at the next start. Returns a REAL `{ ok, error? }` result rather
 * than swallowing delete failures, so the settings screen never reports "forgotten" after a delete silently
 * failed. The caller must only report "forgotten" (and re-expose entry) when this resolves `{ ok: true }`.
 * `error` is a human-readable summary: only item names and generic error messages, NEVER the passphrase. */
export async function clearStoredPassphrase(): Promise<ClearDbKeysResult> {
  // The WHOLE forget runs under the passphrase-state lock so a confirmation can't be paused mid-way across
  // this deletion and then write the "set" marker back after we've reported it gone.
  return runPassphraseExclusive(async () => {
    const errors: string[] = [];

    // Invalidate every outstanding boot attempt: without this, a delayed migration ack for an in-flight
    // attempt could re-create the "set" marker moments after Forget reported it gone. (Under the lock a
    // confirmation either fully precedes this, and is then overwritten by the deletes below, or fully
    // follows it and finds no attempt to confirm.)
    invalidatePassphraseAttempts();

    // The key-VERSION marker goes too, so Forget returns every passphrase item to its never-configured
    // state and the next passphrase start goes through the full legacy-key offer and confirmed-open ack.
    for (const item of [PASSPHRASE_SET_ITEM, PASSPHRASE_ITEM, PASSPHRASE_CANDIDATE_ITEM, PASSPHRASE_KEY_VERSION_ITEM]) {
      try {
        await SecureStore.deleteItemAsync(item);
      } catch (err) {
        errors.push(`delete ${item} failed: ${err instanceof Error ? err.message : String(err)}`);
        continue; // no point verifying a delete that itself threw
      }
      try {
        const remaining = await SecureStore.getItemAsync(item);
        if (remaining !== null) {
          errors.push(`${item} is still present after delete`);
        }
      } catch (err) {
        // A failed verification READ is not proof the item is gone — surface it as its own failure rather
        // than reporting a verified success.
        errors.push(`verifying ${item} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return errors.length > 0 ? { ok: false, error: errors.join('; ') } : { ok: true };
  });
}

/**
 * Record that the server CONFIRMED a passphrase-mode DB opened under the current key derivation, called
 * from `registerDbEncryption`'s `loam-db-key-migrated` listener. The server sends that ack after a
 * successful `PRAGMA rekey` and after every passphrase-mode open under the current key.
 * Three effects, none of which stores the passphrase:
 *   - the {@link PASSPHRASE_SET_ITEM} marker is recorded ("a passphrase governs this database");
 *   - any LEGACY committed passphrase ({@link PASSPHRASE_ITEM}) is retired: that older install has now
 *     opened under it once, and from here on every start prompts;
 *   - the key-version marker is set, so `resolveDbKey('passphrase')` stops offering the legacy derivation.
 * Best-effort: a failed write just means the legacy key keeps getting offered unnecessarily on later boots
 * (and the next confirmed open writes the markers again), so this deliberately does not surface a failure.
 *
 * `requestId` is the launcher's opaque id for the key-handoff attempt whose DB open THIS ack confirms.
 * It acts ONLY for an attempt still outstanding under that exact id — a
 * delayed/duplicate/unknown ack, or one already invalidated by a candidate replacement / Forget, is a
 * complete no-op — so a stale ack can neither confirm an attempt the operator moved past nor resurrect a
 * forgotten passphrase's "set" state. A candidate entered AFTER this attempt resolved is a newer operator
 * action and is deliberately left for the next boot.
 */
export async function markPassphraseKeyMigrated(requestId?: string): Promise<void> {
  // The whole confirmation — the attempt lookup AND every SecureStore write/delete — runs under the
  // passphrase-state lock, so it can never interleave with a Forget.
  await runPassphraseExclusive(async () => {
    try {
      if (requestId === undefined || !pendingPassphraseAttempts.has(requestId)) {
        return;
      }
      pendingPassphraseAttempts.delete(requestId);
      await SecureStore.deleteItemAsync(PASSPHRASE_ITEM);
      await SecureStore.setItemAsync(PASSPHRASE_SET_ITEM, '1');
      await SecureStore.setItemAsync(PASSPHRASE_KEY_VERSION_ITEM, CURRENT_PASSPHRASE_KEY_VERSION);
    } catch {
      // best-effort — see doc comment above.
    }
  });
}

// Serialize ALL access to the device-key items (mint/read in getOrCreateDeviceSecret, delete in
// clearStoredDbKeys, snapshot/restore for setup) so a clear can never interleave with a key resolution on
// the same SecureStore item. Defense in depth: the primary ordering guarantee, "clear before resolve on a
// resumed wipe boot", lives in main.js's bootWithWipeResume; this covers any other overlap, e.g. a
// `loam-wipe-restart` clear racing a key request.
let deviceSecretLock: Promise<unknown> = Promise.resolve();
function withDeviceSecretLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = deviceSecretLock.then(fn, fn);
  deviceSecretLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Read (or mint) the device secret that makes `persistent`/`passphrase` mode's key genuinely
 * discardable: 'persistent' uses it AS the key; 'passphrase' mixes it into the passphrase digest (see
 * `resolveDbKey` below). A passphrase alone can never be made cryptographically discardable (the operator
 * can always type it again), so the actual "rotate on wipe" property has to come from this random,
 * device-generated value instead.
 *
 * Migration (not a new mint): a device that already had a `persistent`-mode key from BEFORE this device-
 * secret model (`PERSISTENT_KEY_ITEM`, generated directly as the key) reuses that value as its initial
 * device secret, so an already-encrypted DB keeps opening under the same effective key; only a wipe
 * (`clearStoredDbKeys`, which deletes both items) actually rotates it from here on. A device with
 * neither item mints 32 fresh random bytes.
 *
 * Can throw (Keystore/RNG failure): callers wrap this in `resolveDbKey`'s outer try/catch, which is
 * the one place that must never let a Keystore failure propagate as a plaintext fallback for these modes.
 */
function getOrCreateDeviceSecret(): Promise<string> {
  return withDeviceSecretLock(getOrCreateDeviceSecretUnlocked);
}

async function getOrCreateDeviceSecretUnlocked(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_SECRET_ITEM);
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }
  const legacy = await SecureStore.getItemAsync(PERSISTENT_KEY_ITEM);
  if (typeof legacy === 'string' && legacy.length > 0) {
    await SecureStore.setItemAsync(DEVICE_SECRET_ITEM, legacy);
    return legacy;
  }
  const bytes = await Crypto.getRandomBytesAsync(32);
  const generated = bytesToHex(bytes);
  await SecureStore.setItemAsync(DEVICE_SECRET_ITEM, generated);
  return generated;
}

/** Result of {@link clearStoredDbKeys} and {@link clearStoredPassphrase}: a REAL success/failure, not a
 *  swallowed best-effort, so a caller can only ever report the key as "cleared" once it's actually verified
 *  gone, and shows a real failure + Retry otherwise. `error` is a human-readable summary (item names and
 *  generic error messages only), never the key/passphrase material itself. */
export type ClearDbKeysResult = { ok: boolean; error?: string };

/**
 * Forget the device secret AND the legacy persistent-mode key item, VERIFYING each is actually gone
 * afterward. Passphrase state is not touched: the passphrase is never stored (the operator types it at
 * every start), and the same passphrase combined with a freshly minted device secret yields a brand-new
 * key. After this resolves `{ ok: true }`: 'persistent' mode's next `resolveDbKey` call mints a NEW device
 * secret (a new key); 'passphrase' mode's next call combines the passphrase with that new device secret
 * (also a new key). Either way the OLD ciphertext is undecryptable under the new key.
 *
 * Two callers: `index.tsx`'s `loam-wipe-restart` bridge listener (the server-side kill switch's acked,
 * phase-gated fixed-key handoff, after the server has deleted the old database) and setup's
 * `prepareNewNetwork` (new-network.ts, before the launcher empties the data folder). The generic WebView
 * `loam-wipe` message never clears the device key: key rotation on a wipe is authorized exclusively by that
 * acked protocol at phase `key-clear-ready`, never by the unauthenticated `wipe` WS notice. A delete or
 * verify failure is reported back so the caller can keep its own durable marker around and let the operator
 * retry, rather than silently claiming the key is gone when it might not be. Never logs `key`/passphrase
 * material, only item names and generic error messages.
 */
export function clearStoredDbKeys(): Promise<ClearDbKeysResult> {
  return withDeviceSecretLock(clearStoredDbKeysUnlocked);
}

async function clearStoredDbKeysUnlocked(): Promise<ClearDbKeysResult> {
  const errors: string[] = [];

  for (const item of [DEVICE_SECRET_ITEM, PERSISTENT_KEY_ITEM]) {
    try {
      await SecureStore.deleteItemAsync(item);
    } catch (err) {
      errors.push(`delete ${item} failed: ${err instanceof Error ? err.message : String(err)}`);
      continue; // no point verifying a delete that itself threw
    }
    try {
      const remaining = await SecureStore.getItemAsync(item);
      if (remaining !== null) {
        errors.push(`${item} is still present after delete`);
      }
    } catch (err) {
      // A failed verification READ is not proof the item is still there — but it's also not proof it's
      // gone, so it can't be reported as a verified success either. Surface it as its own failure.
      errors.push(`verifying ${item} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return errors.length > 0 ? { ok: false, error: errors.join('; ') } : { ok: true };
}

/** The stored device-key items, exactly as they were (null = absent), so setup can put them back. */
export type StoredDbKeys = { deviceSecret: string | null; legacyKey: string | null };

/**
 * Read both device-key items before setup clears them (new-network.ts `prepareNewNetwork`), so a
 * preparation that fails afterwards can restore them and leave the previous database openable.
 * `undefined` when either read fails: without a snapshot the clear must not go ahead. Never logged.
 */
export function snapshotStoredDbKeys(): Promise<StoredDbKeys | undefined> {
  return withDeviceSecretLock(async () => {
    try {
      return {
        deviceSecret: await SecureStore.getItemAsync(DEVICE_SECRET_ITEM),
        legacyKey: await SecureStore.getItemAsync(PERSISTENT_KEY_ITEM),
      };
    } catch {
      return undefined;
    }
  });
}

/**
 * Put back a {@link snapshotStoredDbKeys} snapshot after a failed {@link clearStoredDbKeys} (one item may
 * already be gone), and verify each item reads back as it was. True only when both match.
 */
export function restoreStoredDbKeys(snapshot: StoredDbKeys): Promise<boolean> {
  return withDeviceSecretLock(async () => {
    let restored = true;
    for (const [item, value] of [
      [DEVICE_SECRET_ITEM, snapshot.deviceSecret],
      [PERSISTENT_KEY_ITEM, snapshot.legacyKey],
    ] as const) {
      try {
        const now = await SecureStore.getItemAsync(item);
        if (now === value) {
          continue;
        }
        if (value === null) {
          await SecureStore.deleteItemAsync(item);
        } else {
          await SecureStore.setItemAsync(item, value);
        }
        if ((await SecureStore.getItemAsync(item)) !== value) {
          restored = false;
        }
      } catch {
        restored = false;
      }
    }
    return restored;
  });
}

/**
 * Resolve the DB-encryption key material for `mode`, generating/persisting it as needed:
 *   - 'off'        → no key.
 *   - 'ephemeral'  → NO key from this module. main.js recognizes `mode === 'ephemeral'` itself and sets
 *                    the embedded server's `LOAM_DB_KEY` to the LITERAL string `'ephemeral'`; the server
 *                    (apps/server/src/embedded.ts) then generates and holds its OWN random RAM-only key.
 *                    That key living server-side, not here, is what lets the kill switch ROTATE it on a
 *                    wipe without a restart (`executeKillSwitch`); a key handed out from here would only
 *                    change per boot. The launcher (`computeDbBootEnv` in nodejs-project-template/
 *                    boot-config.js) special-cases 'ephemeral' and never reaches the "no key" lock path
 *                    for it.
 *   - 'persistent' → the device secret itself (see `getOrCreateDeviceSecret`), minted once and stored in
 *                    the Keystore-backed secure store; subsequent calls reuse it so the DB stays openable
 *                    across boots. A wipe (`clearStoredDbKeys`) deletes it, so the NEXT boot after a wipe
 *                    mints a genuinely different one.
 *   - 'passphrase' → `SHA256(passphrase + ':' + deviceSecret)` (the passphrase entered for this start
 *                    AND the Keystore-backed device secret). Mixing in the device secret is what makes THIS
 *                    mode discardable too: after a wipe, the SAME passphrase combined with the NEW device
 *                    secret yields a brand-new key.
 *                    This is a SIMPLE KDF (a single SHA-256 pass, hex-encoded) — a deliberate v1
 *                    shortcut, not a hardened one; a proper scrypt/Argon2 derivation is a documented
 *                    follow-up (see docs/21). Note this single SHA-256 pass is less weak than it sounds
 *                    in isolation: the resulting hex string is handed to SQLCipher as a `PRAGMA key`,
 *                    and SQLCipher does NOT use it directly as the DB key — it re-derives the actual
 *                    encryption key from that pragma string via its own salted PBKDF2 (64k+ iterations
 *                    by default), so there IS a real KDF between this digest and the on-disk key; this
 *                    module's SHA-256 pass just normalizes the passphrase+secret pair into a
 *                    fixed-length pragma value ahead of that. A stronger app-side KDF is still a
 *                    documented follow-up (docs/21), but "no KDF at all" would overstate the gap. If no
 *                    passphrase has been entered yet, resolves with no key (the UI must collect one
 *                    first via `setPassphraseCandidate`); this module NEVER falls back to plaintext for
 *                    this mode itself; the launcher must also refuse to boot plaintext here (it reports
 *                    `db_encryption_locked`, see `computeDbBootEnv` in boot-config.js).
 *                    UNTIL a confirmed migration is recorded (`markPassphraseKeyMigrated`), also returns
 *                    `legacyKey = SHA256(passphrase)` alongside `key`: the legacy derivation an existing
 *                    passphrase DB may still be encrypted under; the
 *                    server tries `key` first and falls back to `legacyKey` only on failure, rekeying in
 *                    place on success. Once migration is confirmed, `legacyKey` is omitted.
 *
 * Never throws — any failure (Keystore unavailable, RNG failure) resolves to `{ mode, key: undefined }`
 * so the caller can decide how to handle a missing key (main.js: refuse to boot plaintext for
 * 'persistent'/'passphrase', see `db_encryption_locked`).
 */
export async function resolveDbKey(mode: DbEncryptionMode): Promise<ResolvedDbKey> {
  try {
    if (mode === 'off') {
      return { mode };
    }

    if (mode === 'ephemeral') {
      // No key generated here (see the doc comment above) — main.js sets LOAM_DB_KEY to the literal
      // string 'ephemeral' itself and the server generates its own RAM-only key.
      return { mode };
    }

    if (mode === 'persistent') {
      const deviceSecret = await getOrCreateDeviceSecret();
      return { mode, key: deviceSecret };
    }

    // mode === 'passphrase'
    // A LEGACY committed passphrase (from an older install) is honoured so the existing database still
    // opens. It is NOT touched here: it is retired only by the server's confirmed-open ack
    // (`markPassphraseKeyMigrated`, sent on EVERY successful passphrase-mode open). Retiring it at read time
    // would lose data: a resolve whose result the launcher DISCARDS (its 5 s bridge timeout on a slow cold
    // start, or a driver-unavailable lock) would delete the only copy of a passphrase the operator never
    // had to remember. New installs never write it, so this is normally null.
    // The boot-time ENTRY comes FIRST: it is the operator's newest intent (typed on the locked/unreadable
    // screen, or pre-entered in Settings, which promises it is used at the next start even on a legacy
    // install). Tried WITHOUT being committed, so a wrong entry can't strand the intact database, and
    // CONSUMED right here, so the passphrase is at rest only between the operator typing it and this read,
    // never across a boot: every start prompts again. A consumed entry whose boot then fails simply has to
    // be typed again (the recovery screens offer that); on a legacy install the untouched legacy item
    // still opens the DB at the next start.
    let passphrase = await SecureStore.getItemAsync(PASSPHRASE_CANDIDATE_ITEM);
    if (typeof passphrase === 'string' && passphrase.length > 0) {
      await SecureStore.deleteItemAsync(PASSPHRASE_CANDIDATE_ITEM);
    } else {
      passphrase = await SecureStore.getItemAsync(PASSPHRASE_ITEM);
    }
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      // No passphrase entered for this start — the boot-time unlock prompt (index.tsx) collects one.
      // Returning no key here is what makes main.js treat this as locked (db_encryption_locked) rather
      // than silently booting plaintext.
      return { mode };
    }
    const deviceSecret = await getOrCreateDeviceSecret();
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${passphrase}:${deviceSecret}`);

    const migratedVersion = await SecureStore.getItemAsync(PASSPHRASE_KEY_VERSION_ITEM);
    if (migratedVersion === CURRENT_PASSPHRASE_KEY_VERSION) {
      return { mode, key: digest };
    }

    // No confirmed migration recorded yet: this could be an existing passphrase DB under the legacy
    // derivation (SHA256(passphrase) alone) OR a genuinely fresh install that simply never got marked. Offer BOTH: the server tries `digest` first (the fast path for an
    // already-migrated-in-fact or fresh DB) and falls back to `legacyKey` only if that fails, rekeying
    // in place on success and signalling back so `markPassphraseKeyMigrated` sets this marker and future
    // boots skip the extra key entirely.
    const legacyKey = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, passphrase);
    return { mode, key: digest, legacyKey };
  } catch {
    return { mode };
  }
}

/**
 * A new network from the setup screens: an operation id and its starting configuration. It rides every key
 * response until the launcher acknowledges it (`loam-new-network-applied` with the same id): the launcher
 * empties the data folder and writes the configuration as config.json before booting (main.js
 * `startNewNetwork`). A response the launcher never received (it timed out waiting) is simply sent again
 * with the next request. The id makes a repeat harmless: once the launcher has created the network it
 * records the id in the folder, and the same operation arriving again never empties it a second time.
 */
type NewNetworkOperation = { id: string; config: Record<string, unknown> };
let pendingNewNetwork: NewNetworkOperation | undefined;

/** Queue a new network for the next boot (a fresh operation id each time), or cancel one with undefined. */
export function setPendingNewNetwork(config: Record<string, unknown> | undefined): void {
  pendingNewNetwork = config ? { id: newOperationId(), config } : undefined;
}

function newOperationId(): string {
  return Crypto.getRandomBytes(12).reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), '');
}

/**
 * Wire the DB-encryption bridge responders onto the nodejs-mobile channel:
 *   - on each `loam-db-key-request` from main.js, read the persisted mode, resolve its key material,
 *     and post `loam-db-key-response` (carrying any pending new network). A mode READ FAILURE (see
 *     {@link DB_ENCRYPTION_MODE_READ_ERROR}) is forwarded as `{ mode: 'error' }`, never silently
 *     reported as `'off'`; the launcher must lock rather than boot plaintext on this.
 *   - on `loam-db-key-migrated` from main.js (the server's confirmed-open signal, see
 *     `openInitialStore`'s `reportDbKeyMigrated`), records it (`markPassphraseKeyMigrated`) so future
 *     boots stop offering the legacy passphrase key.
 *   - on `loam-new-network-applied`, stops sending that new-network operation.
 *
 * Register this in `index.tsx` alongside the other bridge responders (`registerOnDeviceLlm`,
 * `registerMeshCourier`). Order relative to `nodejs.start()` doesn't matter because main.js REQUESTS
 * and waits (with its own timeout), rather than relying on this being registered before the request is
 * posted.
 *
 * Never logs `key`/`legacyKey`/the passphrase. Returns a cleanup that removes all three listeners.
 */
export function registerDbEncryption(channel: BridgeChannel): () => void {
  const onRequest = (payload: unknown): void => {
    // Echo main.js's correlation id so a late answer to an already-timed-out
    // request can't be mistaken for the answer to a subsequent one, AND so the candidate this resolve used
    // is bound to THIS attempt for `markPassphraseKeyMigrated` to promote by id.
    const rawId = (payload as { requestId?: unknown } | undefined)?.requestId;
    const requestId = typeof rawId === 'string' ? rawId : undefined;
    void (async () => {
      let response: ResolvedDbKey | { mode: typeof DB_ENCRYPTION_MODE_READ_ERROR };
      try {
        const mode = await getDbEncryptionMode();
        if (mode === DB_ENCRYPTION_MODE_READ_ERROR) {
          response = { mode };
        } else {
          // Resolve the key AND bind its candidate to this request id as ONE critical section under the
          // passphrase-state lock. Locking the resolve alone would leave a gap
          // before `rememberPassphraseAttempt`, in which a Forget/replace could invalidate the map and this
          // resume would then insert a now-stale attempt. The raw candidate stays RN-side — it is
          // deliberately NOT copied into the bridge payload below (only the derived key/legacyKey cross).
          response = await runPassphraseExclusive(async () => {
            const resolved = await resolveDbKey(mode);
            // Record EVERY issued passphrase request by id: a matching entry is what authorizes
            // the confirmed-open ack to retire a legacy stored passphrase and set the "set" + version markers.
            // `markPassphraseKeyMigrated` then acts ONLY on a request it actually issued, so a delayed/unknown
            // ack can never touch newer state.
            if (requestId !== undefined && mode === 'passphrase') {
              rememberPassphraseAttempt(requestId);
            }
            return resolved;
          });
        }
      } catch {
        response = { mode: DB_ENCRYPTION_MODE_READ_ERROR };
      }
      try {
        const payload: {
          mode: DbEncryptionModeOrError;
          key?: string;
          legacyKey?: string;
          requestId?: string;
          newNetwork?: NewNetworkOperation;
        } = {
          mode: response.mode,
        };
        // Kept (not cleared) until the launcher acknowledges it; never alongside a read error, which locks.
        if (pendingNewNetwork && response.mode !== DB_ENCRYPTION_MODE_READ_ERROR) {
          payload.newNetwork = pendingNewNetwork;
        }
        if (requestId !== undefined) {
          payload.requestId = requestId;
        }
        if ('key' in response && response.key) {
          payload.key = response.key;
        }
        if ('legacyKey' in response && response.legacyKey) {
          payload.legacyKey = response.legacyKey;
        }
        channel.post('loam-db-key-response', payload);
      } catch {
        // main.js isn't listening (unlikely — it just posted the request) — nothing more to do.
      }
    })();
  };

  const onMigrated = (payload: unknown): void => {
    // The launcher echoes the request id of the accepted key handoff whose DB open this ack confirms;
    // act ONLY for that exact attempt.
    const rawId = (payload as { requestId?: unknown } | undefined)?.requestId;
    const requestId = typeof rawId === 'string' ? rawId : undefined;
    void markPassphraseKeyMigrated(requestId);
  };

  // The launcher created the new network: stop sending it (only that exact operation; a newer one stays).
  const onNewNetworkApplied = (payload: unknown): void => {
    const id = (payload as { id?: unknown } | undefined)?.id;
    if (pendingNewNetwork && typeof id === 'string' && id === pendingNewNetwork.id) {
      pendingNewNetwork = undefined;
    }
  };

  channel.addListener('loam-db-key-request', onRequest);
  channel.addListener('loam-db-key-migrated', onMigrated);
  channel.addListener('loam-new-network-applied', onNewNetworkApplied);
  return () => {
    channel.removeAllListeners('loam-db-key-request');
    channel.removeAllListeners('loam-db-key-migrated');
    channel.removeAllListeners('loam-new-network-applied');
  };
}

export type StartFreshResult = { ok: boolean; error?: string };

/**
 * The two DISTINCT intents the `.loam-db-start-fresh` marker can record. The intent is written INTO the
 * marker so the server honours the operator's actual choice; preserving on a deliberate "Delete & start
 * fresh" would leave the old (still key-recoverable) database renamed aside on disk, contradicting the
 * confirmation the operator agreed to:
 *   - `'delete'`   → a DELIBERATE destructive mode transition the operator explicitly confirmed (e.g.
 *                    off→encrypted, persistent→passphrase, passphrase→persistent, encrypted→ephemeral).
 *                    The server DELETES the existing database on the next boot, proving the old data is
 *                    genuinely gone rather than merely inaccessible under the new key. Retaining the old
 *                    ciphertext would leave it recoverable under the retained device secret even though
 *                    the operator was told the data would be deleted.
 *   - `'preserve'` → an ACCIDENTAL wrong/lost-key lockout (`db_encryption_unreadable`): the operator
 *                    can't open the existing encrypted DB but wants a working node, so the server RENAMES
 *                    the old (unopenable) ciphertext ASIDE (`*.unreadable-*`) and starts a fresh DB. This
 *                    is recovery, not a deliberate discard, so the old data is kept for a later attempt.
 */
export type StartFreshIntent = 'delete' | 'preserve';

/**
 * Ask the launcher (main.js) to write the `.loam-db-start-fresh` confirmation marker into its data
 * directory (docs/01, docs/15). The server consumes and deletes this marker on the next
 * boot as confirmation that a human actually asked for a fresh database, rather than the app silently
 * doing it on its own. This module has no direct filesystem access to main.js's `dataDir`
 * (`rnBridge.app.datadir()/loam`), so the write has to happen over there — this is a request/response
 * round trip over the bridge, mirroring `model-manager-bridge.ts`'s `roundTrip` helper.
 *
 * `intent` (REQUIRED) records WHY the fresh start was requested (see {@link StartFreshIntent}) and is
 * threaded into the marker so the server either DELETES the existing database (`'delete'` — a deliberate
 * destructive mode change; deletion proves absence of the old data) or PRESERVES it aside (`'preserve'` —
 * accidental wrong/lost-key lockout recovery; the old ciphertext is renamed aside for a later attempt).
 * The launcher only acks AFTER durably writing the marker.
 *
 * Never throws — a timeout, an old launcher build with no handler, or a thrown `post()` all resolve to
 * `{ ok: false }` so the caller can tell the operator to retry rather than hang indefinitely.
 */
export function requestDbStartFresh(
  channel: BridgeChannel,
  intent: StartFreshIntent,
  timeoutMs = 5000,
): Promise<StartFreshResult> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (result: StartFreshResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Only THIS round trip's listener — an overlapping one on the same event must keep its own.
      removeListener();
      resolve(result);
    };

    const onResult = (payload: unknown): void => {
      const result = payload as { requestId?: unknown; ok?: unknown; error?: unknown } | undefined;
      if (!result || result.requestId !== requestId) {
        return;
      }
      finish({ ok: result.ok === true, error: typeof result.error === 'string' ? result.error : undefined });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'The embedded host did not respond (it may not be running yet).' });
    }, timeoutMs);

    const removeListener = addOwnListener(channel, 'loam-db-start-fresh-result', onResult);
    try {
      channel.post('loam-db-start-fresh', { requestId, intent });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export type DbUnlockResult = { ok: boolean; error?: string };

/**
 * Ask the launcher (main.js) to retry boot right now, the `db_encryption_locked` recovery: a
 * `persistent`/`passphrase` boot attempt found no usable key (typically passphrase mode before a
 * passphrase was ever entered) and, per the "never boot plaintext for these modes" rule, refused to
 * start the server at all rather than silently downgrade. `index.tsx` calls this after the operator has
 * done something that might now produce a key — for passphrase mode, having just called
 * `setPassphraseCandidate`; for persistent mode, as a plain manual retry (e.g. after a transient Keystore
 * hiccup). Mirrors `requestDbStartFresh`'s request/response round trip.
 *
 * This only ever ACKS that the retry was kicked off — the retry's real outcome (ready / still locked /
 * `db_encryption_unreadable` / any other boot error) arrives the normal way, via `loam-status`. Never
 * throws — a timeout, an old launcher build with no handler, or a thrown `post()` all resolve to
 * `{ ok: false }` so the caller can tell the operator to retry rather than hang indefinitely.
 */
export function requestDbUnlock(channel: BridgeChannel, timeoutMs = 5000): Promise<DbUnlockResult> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (result: DbUnlockResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Only THIS round trip's listener — an overlapping one on the same event must keep its own.
      removeListener();
      resolve(result);
    };

    const onResult = (payload: unknown): void => {
      const result = payload as { requestId?: unknown; ok?: unknown; error?: unknown } | undefined;
      if (!result || result.requestId !== requestId) {
        return;
      }
      finish({ ok: result.ok === true, error: typeof result.error === 'string' ? result.error : undefined });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'The embedded host did not respond (it may not be running yet).' });
    }, timeoutMs);

    const removeListener = addOwnListener(channel, 'loam-db-unlock-result', onResult);
    try {
      channel.post('loam-db-unlock', { requestId });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export type SetDbModeHintResult = { ok: boolean; error?: string };

/**
 * Ask the launcher (main.js) to persist the last-known mode-NAME hint TRANSACTIONALLY with a mode
 * SELECTION. If the launcher only wrote the hint when it SUCCESSFULLY resolved a mode at boot, a transient
 * `requestDbKey` failure could exploit two holes: (1) an existing encrypted install upgrading has no hint
 * yet, and (2) an off→encrypted selection leaves the stale `off` hint until the next successful encrypted
 * boot; either way a boot-time timeout could trust the absent/stale hint and downgrade to plaintext.
 * Writing it as part of the selection ({@link applyDbModeChange}: BEFORE the SecureStore commit for an
 * encrypted mode, after it for 'off') updates the hint before any boot, so the launcher's fail-closed gate
 * sees the real mode.
 *
 * Writes only the mode NAME, NEVER key/passphrase material (there is none to write; the hint is the same
 * non-secret mode string already sent in the clear over the bridge). This module has no filesystem access
 * to main.js's `dataDir`, so it's a request/response round trip mirroring {@link requestDbUnlock}. Never
 * throws: a timeout, an old launcher with no handler, or a thrown `post()` all resolve to `{ ok: false }`.
 * For an encrypted selection that means the change is NOT applied; for 'off' it is a soft warning.
 */
export function setDbModeHint(channel: BridgeChannel, mode: DbEncryptionMode, timeoutMs = 5000): Promise<SetDbModeHintResult> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (result: SetDbModeHintResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Only THIS round trip's listener — an overlapping one on the same event must keep its own.
      removeListener();
      resolve(result);
    };

    const onResult = (payload: unknown): void => {
      const result = payload as { requestId?: unknown; ok?: unknown; error?: unknown } | undefined;
      if (!result || result.requestId !== requestId) {
        return;
      }
      finish({ ok: result.ok === true, error: typeof result.error === 'string' ? result.error : undefined });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'The embedded host did not respond (it may not be running yet).' });
    }, timeoutMs);

    const removeListener = addOwnListener(channel, 'loam-db-set-mode-hint-result', onResult);
    try {
      channel.post('loam-db-set-mode-hint', { requestId, mode });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * TRI-STATE result of reading the last-known mode-NAME hint. The reader
 * (`readDbModeHint` in `nodejs-project-template/main.js`) must NOT collapse a read ERROR into `absent`:
 *   - `present` → the hint file held a recognized mode NAME.
 *   - `absent`  → a CONFIRMED ENOENT (the file genuinely does not exist).
 *   - `error`   → the read threw for any OTHER reason, OR the contents were malformed/truncated/
 *     unrecognized. This must LOCK, never boot plaintext — an unreadable/corrupt hint tells us nothing
 *     about whether there's a secret to protect, and an ephemeral node (no DB at boot) with a hint read
 *     error would otherwise present as `absent + no DB → plaintext`, a confidentiality downgrade.
 * Mirrored (by hand) in main.js's `readDbModeHint`, which cannot import this TS module.
 */
export type DbModeHintResult =
  | { status: 'present'; mode: string }
  | { status: 'absent' }
  | { status: 'error' };

/**
 * The PURE "may a plaintext boot be authorized after a locked-error?" decision, over the TRI-STATE
 * {@link DbModeHintResult}, so a confirmed-absent hint is never conflated with an unreadable/corrupt one.
 *
 * This is MIRRORED in `nodejs-project-template/boot-config.js`'s `mayBootPlaintextOnLockedError`: the
 * launcher is CJS on the embedded Node runtime and cannot import this TS module, so the two copies must be
 * kept in sync by hand (the boot-config.js copy carries a comment pointing here). The harness-tested copy
 * lives here, in the app's Vitest suite.
 *
 * A `locked-error` means main.js could not determine the operator's real mode this boot (a SecureStore
 * read failure, a `requestDbKey` timeout, or a malformed reply). Authorize a plaintext boot ONLY when:
 *   - `present` AND `mode === 'off'` → the last-known mode was explicitly plaintext → plaintext is safe.
 *   - `absent` (CONFIRMED ENOENT) AND `dbExists === false` → no on-disk DB AND no recorded mode choice at
 *     all (a genuinely fresh, never-configured node) → nothing to protect → plaintext.
 * Everything else LOCKS, never plaintext:
 *   - `error` (read failure/corrupt/truncated/unrecognized) → LOCK regardless of `dbExists` — closes the
 *     ephemeral "no DB + hint read error → plaintext" hole.
 *   - `absent` WITH a DB present → LOCK (a DB exists but no mode was recorded — don't downgrade it).
 *   - a `present` ENCRYPTED-mode hint (`ephemeral`/`persistent`/`passphrase`) → LOCK even with NO DB file:
 *     ephemeral wipes its DB every boot and a freshly-selected persistent/passphrase mode has no
 *     DB yet, but the operator explicitly chose an encrypted mode, so a transient error must not write an
 *     UNENCRYPTED `loam.db`.
 *
 * @param hint the tri-state hint read result.
 * @param dbExists whether an on-disk DB file exists.
 */
export function mayBootPlaintextOnLockedError(hint: DbModeHintResult, dbExists: boolean): boolean {
  if (hint.status === 'present' && hint.mode === 'off') {
    return true;
  }
  if (hint.status === 'absent' && dbExists === false) {
    return true;
  }
  return false;
}

/** Dependencies for {@link applyDbModeChange} — the reads/writes a picker selection performs. Injected so
 * the serialized sequencing can be harness-tested against scripted successes/failures (the React component
 * wires `readMode = getDbEncryptionMode`, `writeMode = setDbEncryptionMode`, and
 * `writeHint = (m) => setDbModeHint(channel, m)`). */
export interface ApplyDbModeChangeDeps {
  /**
   * Re-read the ACTUALLY-committed SecureStore mode INSIDE the serialized transaction.
   * The picker's captured React `mode` can be stale by the time a queued transition runs (another
   * transition may have committed a different mode while this one waited on the mutex), so the rollback
   * target and diff base MUST come from a fresh read here, not a value captured before the lock was held.
   * A read error ({@link DB_ENCRYPTION_MODE_READ_ERROR}) aborts the transaction — we can't pick a safe
   * rollback target without knowing the committed mode.
   */
  readMode: () => Promise<DbEncryptionModeOrError>;
  writeMode: (mode: DbEncryptionMode) => Promise<SetDbEncryptionModeResult>;
  writeHint: (mode: DbEncryptionMode) => Promise<SetDbModeHintResult>;
}

/** Outcome of {@link applyDbModeChange}: whether the change is safely applied, which mode the picker
 * radio should now DISPLAY (the committed SecureStore value — `next` only on a coherent apply, else the
 * re-read `previous`; `undefined` when the committed mode could not be re-read, so the caller leaves its
 * display untouched), an `error` when not applied, and a soft `hintWarning` when an 'off' selection
 * applied but its best-effort hint sync failed. */
export interface ApplyDbModeChangeOutcome {
  applied: boolean;
  committedMode?: DbEncryptionMode;
  error?: string;
  hintWarning?: boolean;
}

/**
 * Single-flight mutex serializing the ENTIRE hint+mode transaction across ALL concurrent
 * {@link applyDbModeChange} calls. The transaction is only safe for one call at a time: interleaved, two
 * callers could capture the same stale React `mode`, and the hint/mode writes of two transitions could
 * interleave into the exact fail-open state (SecureStore committed to an ENCRYPTED mode while the hint
 * still says `'off'`). Chaining every transaction onto this
 * promise guarantees only one runs at a time, and each re-reads the committed mode INSIDE its own turn.
 * Same shape as {@link withDeviceSecretLock} above.
 */
let modeChangeLock: Promise<unknown> = Promise.resolve();
function withModeChangeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = modeChangeLock.then(fn, fn);
  modeChangeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * The SERIALIZED, harness-tested sequencing for a mode-picker selection. Guarantees
 * the SecureStore mode and the mode-NAME hint never diverge into the DANGEROUS state — SecureStore
 * committed to an ENCRYPTED mode while the hint still says `'off'`/absent, which a transient boot-time
 * key-request failure would then resolve as a PLAINTEXT downgrade even WITH a DB on disk — even under
 * CONCURRENT picker taps.
 *
 * Two guarantees on top of the write ordering below:
 *   1. The whole transaction runs under a single-flight mutex ({@link withModeChangeLock}), so a second
 *      selection cannot start until the first fully commits/rolls back — two transitions can never
 *      interleave their writes into the fail-open state.
 *   2. The rollback target / diff base comes from a FRESH read of the committed SecureStore mode
 *      (`deps.readMode`) taken INSIDE the lock — never a captured/stale React `mode`. A read error aborts
 *      (no safe rollback target).
 *
 * Ordering within the transaction:
 *   - `'off'`: committing plaintext is never a confidentiality risk (a stale ENCRYPTED hint only
 *     over-locks a later boot, fail-closed), so commit the SecureStore mode directly and treat the hint
 *     as best-effort — a hint failure is only a soft `hintWarning`.
 *   - ENCRYPTED modes: write the HINT first (so a hint failure never touches SecureStore — nothing to
 *     roll back), then commit SecureStore; on a SecureStore failure, roll the hint back to the re-read
 *     `previous`. The only residual divergence ever left is the SAFE one (hint encrypted + SecureStore
 *     unchanged → over-locks, never downgrades).
 *
 * Never writes key/passphrase material anywhere — the hint carries only the non-secret mode NAME.
 */
export function applyDbModeChange(
  next: DbEncryptionMode,
  deps: ApplyDbModeChangeDeps,
): Promise<ApplyDbModeChangeOutcome> {
  return withModeChangeLock(() => applyDbModeChangeLocked(next, deps));
}

async function applyDbModeChangeLocked(
  next: DbEncryptionMode,
  deps: ApplyDbModeChangeDeps,
): Promise<ApplyDbModeChangeOutcome> {
  // Re-read the committed mode INSIDE the lock — the caller's captured value may be stale (a prior queued
  // transition may have committed a different mode). This is the authoritative rollback target + diff base.
  const previous = await deps.readMode();
  if (previous === DB_ENCRYPTION_MODE_READ_ERROR) {
    return {
      applied: false,
      error: 'Could not read the current encryption setting (a device security-store error). The change was NOT applied.',
    };
  }

  if (next === 'off') {
    const modeResult = await deps.writeMode('off');
    if (!modeResult.ok) {
      return { applied: false, committedMode: previous, error: modeResult.error };
    }
    const hintResult = await deps.writeHint('off');
    return { applied: true, committedMode: 'off', hintWarning: !hintResult.ok };
  }

  // Encrypted mode: hint first, so a hint failure never leaves SecureStore ahead of the hint.
  const hintResult = await deps.writeHint(next);
  if (!hintResult.ok) {
    return { applied: false, committedMode: previous, error: hintResult.error };
  }
  const modeResult = await deps.writeMode(next);
  if (!modeResult.ok) {
    // Roll the hint back to the re-read `previous` so SecureStore (unchanged) and the hint agree again.
    // Best-effort: a failed revert only leaves the SAFE over-locking divergence, never a plaintext downgrade.
    await deps.writeHint(previous);
    return { applied: false, committedMode: previous, error: modeResult.error };
  }
  return { applied: true, committedMode: next };
}

/** The boot-status code the server reports when an ENCRYPTED mode is configured but the on-disk DB is
 * still PLAINTEXT. There is no in-place plaintext→encrypted conversion, so the
 * host must NEVER silently serve plaintext under an encrypted selection. `index.tsx` maps this to a
 * DESTRUCTIVE recovery (delete the existing data and start a fresh encrypted DB, or switch encryption
 * back off to keep the existing unencrypted data). A non-destructive in-place plaintext→encrypted
 * CONVERSION is a documented FUTURE enhancement (docs/21) — not built. */
export const DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE = 'db_encryption_plaintext_unconverted' as const;

/** Boot-error code: an encrypted mode is selected but the SQLCipher native
 * driver failed to load, so the launcher LOCKED instead of booting plaintext. Recovery: Retry, or an explicit
 * switch to `off`. Mirrors `DB_ENCRYPTION_DRIVER_MISSING_CODE` in nodejs-project-template/boot-config.js. */
export const DB_ENCRYPTION_DRIVER_MISSING_CODE = 'db_encryption_driver_missing' as const;

/**
 * Whether SELECTING `next` is a destructive action that must be gated behind an
 * explicit operator confirmation before it is persisted. Any encrypted mode
 * (`ephemeral`/`persistent`/`passphrase`) is destructive: encryption can only apply to a FRESH database
 * (no in-place plaintext→encrypted conversion), so choosing one clears or strands any existing on-device
 * data. `'off'` never destroys data on its own.
 *
 * This module has no filesystem access to the launcher's data dir, so it cannot detect whether a DB
 * actually exists — the confirmation is therefore gated on the MODE alone (an encrypted selection is
 * treated as potentially destructive), and the server's {@link DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE}
 * boot recovery is the backstop for a plaintext DB that reaches boot un-cleared.
 */
export function dbModeSelectionIsDestructive(next: DbEncryptionMode): boolean {
  return next !== 'off';
}

/** The dedicated DB-encryption boot-recovery UI a given boot-error `code` maps to,
 * or `null` for codes with no dedicated recovery. Pure so `index.tsx`'s code→recovery mapping (which
 * decides whether to show the destructive plaintext-unconverted / start-fresh / unlock UI) is
 * harness-testable. */
export type DbEncryptionRecovery = 'plaintext-unconverted' | 'unreadable' | 'locked' | 'driver-missing';
export function dbEncryptionRecoveryForCode(code: string | undefined): DbEncryptionRecovery | null {
  switch (code) {
    case DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE:
      return 'plaintext-unconverted';
    case 'db_encryption_unreadable':
      return 'unreadable';
    case 'db_encryption_locked':
      return 'locked';
    case DB_ENCRYPTION_DRIVER_MISSING_CODE:
      return 'driver-missing';
    default:
      return null;
  }
}
