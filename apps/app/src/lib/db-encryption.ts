// RN-side key resolution for on-device DB encryption (PR B — docs/01, docs/21). This is the other half
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

export type DbEncryptionMode = 'off' | 'ephemeral' | 'persistent' | 'passphrase';

export const DB_ENCRYPTION_MODES: readonly DbEncryptionMode[] = ['off', 'ephemeral', 'persistent', 'passphrase'];

/** One-line description shown next to each mode in the picker UI. */
export const DB_ENCRYPTION_MODE_DESCRIPTIONS: Record<DbEncryptionMode, string> = {
  off: 'The on-device database is stored in plain SQLite — the default.',
  ephemeral: 'A random key generated at each launch, held only in memory. Wipes the database on every restart — nothing survives a reboot.',
  persistent: 'A random key generated once and stored in the device Keystore. Survives reboots; the database stays encrypted at rest.',
  passphrase: 'A key derived from an operator-chosen passphrase, stored in the device Keystore. Survives reboots; anyone who knows the passphrase can also derive the key.',
};

const MODE_ITEM = 'loam-db-encryption-mode';
const PERSISTENT_KEY_ITEM = 'loam-db-encryption-persistent-key';
const PASSPHRASE_ITEM = 'loam-db-encryption-passphrase';
/**
 * A boot-time unlock CANDIDATE passphrase (P2-a, Sol round 6). Entered on the `db_encryption_locked`
 * screen and stored HERE — deliberately separate from {@link PASSPHRASE_ITEM} — so it is TRIED without
 * being COMMITTED as the stored passphrase: `resolveDbKey('passphrase')` falls back to it only when no
 * passphrase is committed, and it is promoted to {@link PASSPHRASE_ITEM} by
 * {@link markPassphraseKeyMigrated} ONLY once the DB actually opens under it. That is what lets a WRONG
 * guess leave an intact stored passphrase (and its database) untouched and recoverable for another
 * attempt, instead of overwriting the stored passphrase and stranding the DB under the old key. NOTE:
 * an authenticated, in-place passphrase-REKEY transaction — atomically changing the stored passphrase
 * AND `PRAGMA rekey`ing the existing DB so its data survives the change — is a documented FUTURE
 * enhancement (docs/21); it does not exist today, so CHANGING a passphrase is only possible via the
 * explicit destructive start-fresh flow (which discards the existing encrypted data).
 */
const PASSPHRASE_CANDIDATE_ITEM = 'loam-db-encryption-passphrase-candidate';
/**
 * The one piece of key material a wipe can actually DISCARD (P1-1, Sol round 4). A user-chosen
 * passphrase can never itself be made cryptographically discardable — the operator can always type it
 * again — so `persistent`/`passphrase` mode both key off this random, device-generated secret instead:
 * `persistent` uses it directly, `passphrase` mixes it into the passphrase's digest (see `resolveDbKey`
 * below). Deleting THIS item (and minting a fresh one on next use) is what makes a wipe of either mode
 * genuinely rotate the key, even though the passphrase itself survives the wipe unchanged.
 */
const DEVICE_SECRET_ITEM = 'loam-db-encryption-device-secret';
/**
 * Marks a passphrase-mode DB as confirmed-migrated to the CURRENT key derivation (P1-1, Sol round 5).
 * Round 4 changed the passphrase key from `SHA256(passphrase)` (legacy) to
 * `SHA256(passphrase + ':' + deviceSecret)` (current) — an existing round-3-and-earlier passphrase DB
 * can only be opened with the legacy derivation. Absent (or any value other than
 * {@link CURRENT_PASSPHRASE_KEY_VERSION}) means "not confirmed migrated yet", so `resolveDbKey` keeps
 * offering the legacy key alongside the current one until the server confirms a successful migration
 * (`markPassphraseKeyMigrated`, called from `registerDbEncryption`'s `loam-db-key-migrated` listener).
 */
const PASSPHRASE_KEY_VERSION_ITEM = 'loam-db-passphrase-key-version';
const CURRENT_PASSPHRASE_KEY_VERSION = '2';

// Boot-time unlock CANDIDATE passphrases keyed by the launcher's opaque per-request id, so a promotion
// commits the EXACT value the accepted DB open verified — never a process-global "last resolve" that a
// later/overlapping/late resolve could have overwritten (Sol Fable-round P1-1). The flow is fully
// correlated end-to-end: main.js posts `loam-db-key-request { requestId }`; `resolveDbKey` records the
// candidate it actually used under that id here; main.js accepts exactly the response whose id matches,
// remembers it, and echoes it back in the `loam-db-key-migrated { requestId }` ack; `markPassphraseKeyMigrated`
// then promotes ONLY `pendingPassphraseAttempts.get(requestId)` — the candidate the open under this exact
// attempt verified. A candidate replacement (`setPassphraseCandidate`) or a forget (`clearStoredPassphrase`)
// INVALIDATES every outstanding attempt, so a stale/late migration ack can neither commit an old guess nor
// resurrect a forgotten passphrase. Bounded so a run of timed-out attempts can't grow it without limit.
const pendingPassphraseAttempts = new Map<string, string>();
const MAX_PENDING_PASSPHRASE_ATTEMPTS = 16;

/** Record the candidate a resolve used, keyed by its request id, evicting the oldest if over the cap. */
function rememberPassphraseAttempt(requestId: string, candidate: string): void {
  // Re-inserting refreshes recency (delete-then-set moves it to the end of the Map's insertion order).
  pendingPassphraseAttempts.delete(requestId);
  pendingPassphraseAttempts.set(requestId, candidate);
  while (pendingPassphraseAttempts.size > MAX_PENDING_PASSPHRASE_ATTEMPTS) {
    const oldest = pendingPassphraseAttempts.keys().next().value;
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
   * The pre-round-4 passphrase key derivation (`SHA256(passphrase)` alone, no device secret) — present
   * ONLY for `mode === 'passphrase'` when this device hasn't recorded a confirmed migration yet (P1-1,
   * Sol round 5). main.js threads it to the server as `LOAM_DB_KEY_MIGRATE_FROM`; `openInitialStore`
   * tries `key` first and falls back to this only on failure, rekeying the DB to `key` in place on
   * success. Never present for any other mode.
   */
  legacyKey?: string;
  /**
   * The exact boot-time CANDIDATE passphrase this resolve used to derive `key` (Sol Fable-round P1-1),
   * present ONLY when `resolveDbKey('passphrase')` fell back to an uncommitted candidate. It is RN-side
   * bookkeeping — the responder records it against the request id so `markPassphraseKeyMigrated` can promote
   * the verified value, and NEVER puts it in the bridge payload (raw passphrases don't cross the bridge; only
   * the derived `key`/`legacyKey` do). Absent when a committed passphrase (or no passphrase) was used.
   */
  attemptCandidate?: string;
};

/** The subset of the nodejs-mobile bridge channel this module uses (kept loose, matching the other
 * RN↔launcher bridges — on-device-llm.ts, mesh-courier.ts, model-manager-bridge.ts). */
export interface BridgeChannel {
  addListener(name: string, handler: (payload: unknown) => void): void;
  removeListener(name: string, handler: (payload: unknown) => void): void;
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

/** Distinct sentinel returned by {@link getDbEncryptionMode} on a genuine SecureStore READ FAILURE
 * (P1-3, Sol round 5) — never conflated with `'off'`. A successful read that comes back `null`/absent/
 * garbage IS genuinely "no mode ever selected", and `'off'` is the correct, safe default for THAT case;
 * a thrown read (Keystore unavailable, corrupt store) tells you nothing about the operator's actual
 * choice, so it must stay distinguishable. Any caller that feeds a BOOT decision (`registerDbEncryption`
 * below, and main.js's `requestDbKey`) must treat this the same as "no usable key" (lock), never as
 * `'off'` (which would silently downgrade an operator's encrypted mode to plaintext on a transient
 * error). UI-only callers may treat it as "unknown, don't overwrite the last-known display". */
export const DB_ENCRYPTION_MODE_READ_ERROR = 'error' as const;
export type DbEncryptionModeOrError = DbEncryptionMode | typeof DB_ENCRYPTION_MODE_READ_ERROR;

/** Read the operator's persisted mode choice. Returns `'off'` only after a SUCCESSFUL read that came
 * back null/absent/unrecognized (genuinely "nothing selected yet" — the safe default); returns
 * {@link DB_ENCRYPTION_MODE_READ_ERROR} on a thrown read (P1-3, Sol round 5) — that failure must never
 * be silently reported as `'off'`, since a caller feeding a boot decision would then downgrade an
 * operator's encrypted mode to plaintext on a mere transient Keystore hiccup. */
export async function getDbEncryptionMode(): Promise<DbEncryptionModeOrError> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(MODE_ITEM);
  } catch {
    return DB_ENCRYPTION_MODE_READ_ERROR;
  }
  return isDbEncryptionMode(raw) ? raw : 'off';
}

/** Result of {@link setDbEncryptionMode} — P1-3, Sol round 5: a REAL success/failure, not a swallowed
 *  best-effort, so the settings UI can surface a failed write as a failure rather than implying the mode
 *  was actually applied. `error` is a generic, human-readable summary — never key/passphrase material
 *  (this call never touches any, but kept consistent with the other Result types in this module). */
export type SetDbEncryptionModeResult = { ok: boolean; error?: string };

/** Persist the operator's mode choice, reporting whether the write actually succeeded (P1-3, Sol round
 * 5) — a failed write here must not be presented to the operator as "applied": the picker's NEXT read
 * still falls back to `'off'` (the safe default), which may not be the mode they just thought they set. */
export async function setDbEncryptionMode(mode: DbEncryptionMode): Promise<SetDbEncryptionModeResult> {
  try {
    await SecureStore.setItemAsync(MODE_ITEM, mode);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Tri-state presence of a COMMITTED operator passphrase (P1-3, Sol round 7). Deliberately NOT a boolean:
 * a SecureStore READ FAILURE is `'error'`, NEVER `'absent'`. Collapsing a read error to `'absent'`/
 * `false` (as this used to) let the picker show "No passphrase set" on a transient Keystore hiccup and
 * expose a first-time-entry path that could OVERWRITE the committed passphrase — reintroducing the
 * passphrase-replacement bug while the existing DB is still under the OLD key. `'present'` = a non-empty
 * committed passphrase; `'absent'` = a SUCCESSFUL read that came back null/empty; `'error'` = the read
 * threw. The UI must not expose any committed-overwrite affordance on `'error'`. Never returns the
 * passphrase itself. */
export type PassphrasePresence = 'present' | 'absent' | 'error';

export async function hasStoredPassphrase(): Promise<PassphrasePresence> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(PASSPHRASE_ITEM);
  } catch {
    return 'error';
  }
  return typeof raw === 'string' && raw.length > 0 ? 'present' : 'absent';
}

/** Store (COMMIT) the operator's passphrase in the Keystore-backed secure store. Never written anywhere
 * else — no AsyncStorage, no plain file, no log line.
 *
 * P1-3 (Sol round 7): this COMMITS the passphrase DIRECTLY, so it is no longer used by any UI entry
 * path — the settings picker AND the boot-time unlock prompt both go through the CANDIDATE flow
 * ({@link setPassphraseCandidate} → promoted by {@link markPassphraseKeyMigrated} only once the DB
 * actually opens under it), so neither can ever overwrite a committed passphrase and strand the DB under
 * the old key. Retained as the low-level commit primitive (and exercised by tests); prefer the candidate
 * flow for anything reachable while a DB may exist. */
export async function setStoredPassphrase(passphrase: string): Promise<void> {
  await SecureStore.setItemAsync(PASSPHRASE_ITEM, passphrase);
}

/**
 * Store a boot-time unlock CANDIDATE passphrase (P2-a, Sol round 6) — see {@link PASSPHRASE_CANDIDATE_ITEM}.
 * Kept separate from {@link setStoredPassphrase}: the candidate is TRIED by `resolveDbKey('passphrase')`
 * (only when no passphrase is committed) but NOT treated as the stored passphrase until the DB actually
 * opens under it, at which point {@link markPassphraseKeyMigrated} promotes it. A wrong guess therefore
 * leaves any intact stored passphrase — and its database — untouched and recoverable for another attempt.
 * Never logged; never written anywhere but the Keystore-backed secure store.
 */
export async function setPassphraseCandidate(passphrase: string): Promise<void> {
  // Replacing the pending candidate INVALIDATES every outstanding boot attempt (Sol Fable-round P1-1): a
  // late response for a PRIOR candidate must never be promotable once the operator has entered a new one.
  invalidatePassphraseAttempts();
  await SecureStore.setItemAsync(PASSPHRASE_CANDIDATE_ITEM, passphrase);
}

/**
 * Forget the stored passphrase AND any pending unlock candidate (e.g. the operator switches away from
 * passphrase mode), VERIFYING each is actually gone afterward (P1-3, Sol round 7). Returns a REAL
 * `{ ok, error? }` result rather than swallowing delete failures: the old best-effort version always
 * "succeeded", so `handleForgetPassphrase` reported "forgotten" even when the delete silently failed —
 * which then re-enabled the first-time-entry path and let a NEW passphrase overwrite the still-committed
 * old one while the DB was under the OLD key. The caller must only report "forgotten" (and re-expose
 * entry) when this resolves `{ ok: true }`. `error` is a human-readable summary — only item names and
 * generic error messages, NEVER the passphrase material itself. */
export async function clearStoredPassphrase(): Promise<ClearDbKeysResult> {
  const errors: string[] = [];

  // Invalidate every outstanding boot attempt (Sol Fable-round P1-1): without this, a delayed migration
  // ack for an in-flight attempt could RE-CREATE a passphrase moments after Forget reported it gone.
  invalidatePassphraseAttempts();

  // Also delete the key-VERSION marker (Fable review MEDIUM-1): without this, "Forget" leaves the marker at
  // the current version, so a re-entered passphrase (as a boot candidate) is never re-offered with its legacy
  // key and `markPassphraseKeyMigrated` never fires to promote it — the node then boots forever on an
  // unpromoted candidate while Settings misreports "no passphrase set". Clearing the marker lets the next
  // candidate re-run the migrate/promote path cleanly.
  for (const item of [PASSPHRASE_ITEM, PASSPHRASE_CANDIDATE_ITEM, PASSPHRASE_KEY_VERSION_ITEM]) {
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
}

/**
 * Record that the server CONFIRMED a passphrase-mode DB is now encrypted under the current key
 * derivation (P1-1, Sol round 5) — called from `registerDbEncryption`'s `loam-db-key-migrated` listener
 * once the server signals a successful `PRAGMA rekey` (or reports that the current key already opened
 * the DB directly, e.g. a fresh install). After this resolves, `resolveDbKey('passphrase')` stops
 * offering the legacy key on future boots. Best-effort: a failed write just means the legacy key keeps
 * getting offered unnecessarily on later boots — self-healing (the current key still opens the DB first
 * every time, and `openInitialStore` re-signals migrated again) rather than a correctness problem, so
 * this deliberately does not surface a failure the way {@link setDbEncryptionMode} does.
 *
 * `requestId` is the launcher's opaque id for the key-handoff attempt whose DB open THIS ack confirms
 * (Sol Fable-round P1-1). Promotion commits ONLY the candidate `resolveDbKey` recorded under that exact id
 * — never a process-global "last resolve" that an overlapping/late/timed-out attempt could have overwritten,
 * and never a value a concurrent Settings edit swapped in. A missing/unknown id (older launcher, or an
 * attempt invalidated by a candidate replacement / forget) promotes nothing — fail-safe.
 */
export async function markPassphraseKeyMigrated(requestId?: string): Promise<void> {
  try {
    // The exact candidate the ACCEPTED attempt used (if the open used a boot candidate rather than a
    // committed passphrase). Consumed here so a duplicate ack can't act on it twice.
    const openedWith = requestId !== undefined ? pendingPassphraseAttempts.get(requestId) : undefined;
    if (requestId !== undefined) {
      pendingPassphraseAttempts.delete(requestId);
    }
    const committed = await SecureStore.getItemAsync(PASSPHRASE_ITEM);
    const hadCommitted = typeof committed === 'string' && committed.length > 0;
    if (typeof openedWith === 'string' && openedWith.length > 0 && !hadCommitted) {
      // A DB open under the current key is PROOF this exact passphrase is correct — promote the VERIFIED
      // candidate. Guarded on "nothing committed" so it can never clobber a committed passphrase that
      // itself opened the DB.
      await SecureStore.setItemAsync(PASSPHRASE_ITEM, openedWith);
    }
    // Whether a passphrase is committed AFTER this call: either one already was, or we just promoted the
    // verified candidate. Only then is the DB confirmed migrated and a pending candidate moot — so gate BOTH
    // the candidate cleanup AND the version marker on it. This makes a stale/forgotten-race ack (no attempt,
    // nothing committed) a complete no-op: it can't drop a candidate, resurrect a passphrase, or falsely
    // mark migrated.
    const committedNow = hadCommitted || (typeof openedWith === 'string' && openedWith.length > 0);
    if (committedNow) {
      const storedCandidate = await SecureStore.getItemAsync(PASSPHRASE_CANDIDATE_ITEM);
      if (typeof storedCandidate === 'string' && storedCandidate.length > 0) {
        // The open succeeded, so `resolveDbKey` will prefer the committed passphrase from now on — the
        // pending candidate is moot; clear it.
        await SecureStore.deleteItemAsync(PASSPHRASE_CANDIDATE_ITEM);
      }
      await SecureStore.setItemAsync(PASSPHRASE_KEY_VERSION_ITEM, CURRENT_PASSPHRASE_KEY_VERSION);
    }
  } catch {
    // best-effort — see doc comment above.
  }
}

/**
 * Read (or mint) the device secret that makes `persistent`/`passphrase` mode's key genuinely
 * discardable (P1-1, Sol round 4): 'persistent' uses it AS the key; 'passphrase' mixes it into the
 * passphrase digest (see `resolveDbKey` below). A passphrase alone can never be made cryptographically
 * discardable — the operator can always type it again — so the actual "rotate on wipe" property has to
 * come from this random, device-generated value instead.
 *
 * Migration (not a new mint): a device that already had a `persistent`-mode key from BEFORE this device-
 * secret model (`PERSISTENT_KEY_ITEM`, generated directly as the key) reuses that value as its initial
 * device secret, so an already-encrypted DB keeps opening under the same effective key — only a wipe
 * (`clearStoredDbKeys`, which deletes both items) actually rotates it from here on. A device with
 * neither item mints 32 fresh random bytes.
 *
 * Can throw (Keystore/RNG failure) — callers wrap this in `resolveDbKey`'s outer try/catch, which is
 * the one place that must never let a Keystore failure propagate as a plaintext fallback for these modes.
 */
// Serialize ALL access to the device secret (mint/read in getOrCreateDeviceSecret vs. delete in
// clearStoredDbKeys) so a wipe's clear can never interleave with a key resolution on the same SecureStore
// item (Sol round-4 finding #1 defense-in-depth — the primary ordering guarantee, "clear before resolve on
// a resumed wipe boot", lives in main.js's bootWithWipeResume; this covers any OTHER overlap, e.g. the
// client `wipe` WS-event firing clearStoredDbKeys while a DM concurrently drives resolveDbKey).
let deviceSecretLock: Promise<unknown> = Promise.resolve();
function withDeviceSecretLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = deviceSecretLock.then(fn, fn);
  deviceSecretLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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

/** Result of {@link clearStoredDbKeys} — P1-2(b), Sol round 4: a REAL success/failure, not a swallowed
 *  best-effort, so `index.tsx` can only ever report the key as "cleared" once it's actually verified
 *  gone, and shows a real failure + Retry otherwise. `error` is a human-readable summary (item names and
 *  generic error messages only) — never the key/passphrase material itself. */
export type ClearDbKeysResult = { ok: boolean; error?: string };

/**
 * Forget the device secret (P1-1, Sol round 4) AND the legacy persistent-mode key item, VERIFYING each
 * is actually gone afterward — never the stored passphrase, which is designed to survive a wipe (see
 * `getOrCreateDeviceSecret`'s doc comment: the passphrase + a freshly-minted device secret together
 * still yield a brand-new key, so the passphrase itself has no reason to be forgotten). After this
 * resolves `{ ok: true }`: 'persistent' mode's next `resolveDbKey` call mints a NEW device secret (a new
 * key); 'passphrase' mode's next call combines the SAME passphrase with that new device secret (also a
 * new key). Either way the OLD ciphertext — already deleted server-side by the kill switch before this
 * is ever invoked — is undecryptable under the new key.
 *
 * Called ONLY from `index.tsx`'s `loam-wipe-restart` bridge listener — the server-side kill switch's
 * acked, phase-gated fixed-key handoff (P1-2). The generic WebView `loam-wipe` message no longer clears
 * the device key (Sol round-8 P1-2): key rotation is authorized exclusively by that acked protocol at
 * phase `key-clear-ready`, never by the unauthenticated `wipe` WS notice. Real success/failure, NOT
 * swallowed (P1-2b): a delete or verify failure is reported
 * back so the caller can keep its own durable wipe-pending marker around and let the operator retry,
 * rather than silently claiming the key is gone when it might not be. Never logs `key`/passphrase
 * material — only item names and generic error messages.
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

/**
 * Resolve the DB-encryption key material for `mode`, generating/persisting it as needed:
 *   - 'off'        → no key.
 *   - 'ephemeral'  → NO key from this module any more (Sol P1-1). main.js recognizes `mode ===
 *                    'ephemeral'` itself and sets the embedded server's `LOAM_DB_KEY` to the LITERAL
 *                    string `'ephemeral'`; the server (apps/server/src/embedded.ts) then generates and
 *                    holds its OWN random RAM-only key. That key living server-side — not here — is
 *                    what lets the kill switch actually ROTATE it on wipe (`executeKillSwitch`): when
 *                    this module used to hand back a fresh key on every call, the key was regenerated
 *                    per BOOT (via this function), not per WIPE, so a wipe with no restart had no key
 *                    here to rotate at all, and "rotation" only ever happened as a side effect of the
 *                    next cold start. Returning no key keeps this module out of that loop entirely —
 *                    `resolveDbEncryptionAndBoot` in main.js special-cases 'ephemeral' and never
 *                    reaches the "no key" plaintext-downgrade path for it.
 *   - 'persistent' → the device secret itself (P1-1, Sol round 4 — see `getOrCreateDeviceSecret`),
 *                    minted once and stored in the Keystore-backed secure store; subsequent calls reuse
 *                    it so the DB stays openable across boots. A wipe (`clearStoredDbKeys`) deletes it,
 *                    so the NEXT boot after a wipe mints a genuinely different one.
 *   - 'passphrase' → `SHA256(passphrase + ':' + deviceSecret)` (Keystore-backed passphrase AND device
 *                    secret). Mixing in the device secret is what makes THIS mode discardable too, even
 *                    though the passphrase itself survives a wipe unchanged (P1-1): after a wipe, the
 *                    SAME passphrase combined with the NEW device secret still yields a brand-new key.
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
 *                    first via `setStoredPassphrase`) — this module NEVER falls back to plaintext for
 *                    this mode itself; that decision belongs to main.js/index.tsx (see `resolveDbEncryptionAndBoot`'s
 *                    `db_encryption_locked` handling), which must also refuse to boot plaintext here.
 *                    UNTIL a confirmed migration is recorded (`markPassphraseKeyMigrated`, P1-1 Sol
 *                    round 5), also returns `legacyKey = SHA256(passphrase)` alongside `key` — the
 *                    pre-round-4 derivation an existing passphrase DB may still be encrypted under; the
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
    let passphrase = await SecureStore.getItemAsync(PASSPHRASE_ITEM);
    // The exact candidate this resolve uses (if it falls back to one) — returned so the responder can map it
    // to the request id and `markPassphraseKeyMigrated` promotes THIS verified value, never a global.
    let attemptCandidate: string | undefined;
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      // P2-a (Sol round 6): no COMMITTED passphrase — fall back to a boot-time unlock CANDIDATE if one is
      // pending (entered on the locked screen). It is tried WITHOUT being committed; only once the DB
      // opens under it does `markPassphraseKeyMigrated` promote it (the exact value used, tracked below).
      // So a wrong guess can't overwrite an intact stored passphrase.
      const candidate = await SecureStore.getItemAsync(PASSPHRASE_CANDIDATE_ITEM);
      if (typeof candidate === 'string' && candidate.length > 0) {
        passphrase = candidate;
        attemptCandidate = candidate;
      }
    }
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      // No passphrase entered yet (neither committed nor a pending candidate) — the picker UI (or the
      // boot-time unlock prompt, see index.tsx) is responsible for collecting one. Returning no key here
      // is what makes main.js treat this as locked (db_encryption_locked) rather than silently booting
      // plaintext.
      return { mode };
    }
    const deviceSecret = await getOrCreateDeviceSecret();
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${passphrase}:${deviceSecret}`);

    const migratedVersion = await SecureStore.getItemAsync(PASSPHRASE_KEY_VERSION_ITEM);
    if (migratedVersion === CURRENT_PASSPHRASE_KEY_VERSION) {
      return { mode, key: digest, attemptCandidate };
    }

    // P1-1 (Sol round 5): no confirmed migration recorded yet — this could be an existing pre-round-4
    // passphrase DB (legacy key = SHA256(passphrase) alone) OR a genuinely fresh install that simply
    // never got marked. Offer BOTH: the server tries `digest` first (the fast path for an
    // already-migrated-in-fact or fresh DB) and falls back to `legacyKey` only if that fails, rekeying
    // in place on success and signalling back so `markPassphraseKeyMigrated` sets this marker and future
    // boots skip the extra key entirely.
    const legacyKey = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, passphrase);
    return { mode, key: digest, legacyKey, attemptCandidate };
  } catch {
    return { mode };
  }
}

/**
 * Wire the DB-encryption bridge responders onto the nodejs-mobile channel:
 *   - on each `loam-db-key-request` from main.js, read the persisted mode, resolve its key material,
 *     and post `loam-db-key-response`. A mode READ FAILURE (P1-3, Sol round 5 — see
 *     {@link DB_ENCRYPTION_MODE_READ_ERROR}) is forwarded as `{ mode: 'error' }`, never silently
 *     reported as `'off'` — main.js's `requestDbKey` must lock rather than boot plaintext on this.
 *   - on `loam-db-key-migrated` from main.js (the server's confirmed-migration signal, P1-1 Sol round
 *     5 — see `openInitialStore`'s `reportDbKeyMigrated`), records the migration
 *     (`markPassphraseKeyMigrated`) so future boots stop offering the legacy passphrase key.
 *
 * Register this in `index.tsx` alongside the other bridge responders (`registerOnDeviceLlm`,
 * `registerMeshCourier`) — order relative to `nodejs.start()` doesn't matter because main.js REQUESTS
 * and waits (with its own timeout), rather than relying on this being registered before the request is
 * posted.
 *
 * Never logs `key`/`legacyKey`/the passphrase. Returns a cleanup that removes both listeners.
 */
export function registerDbEncryption(channel: BridgeChannel): () => void {
  const onRequest = (payload: unknown): void => {
    // Echo main.js's correlation id (Sol Fable-round P1-1) so a late answer to an already-timed-out
    // request can't be mistaken for the answer to a subsequent one, AND so the candidate this resolve used
    // is bound to THIS attempt for `markPassphraseKeyMigrated` to promote by id.
    const rawId = (payload as { requestId?: unknown } | undefined)?.requestId;
    const requestId = typeof rawId === 'string' ? rawId : undefined;
    void (async () => {
      let response: ResolvedDbKey | { mode: typeof DB_ENCRYPTION_MODE_READ_ERROR };
      try {
        const mode = await getDbEncryptionMode();
        response = mode === DB_ENCRYPTION_MODE_READ_ERROR ? { mode } : await resolveDbKey(mode);
      } catch {
        response = { mode: DB_ENCRYPTION_MODE_READ_ERROR };
      }
      // Bind the exact candidate this resolve used to the request id, so a promotion later commits THIS
      // verified value (not a global that an overlapping/late resolve overwrote). The raw candidate stays
      // RN-side — it is deliberately NOT copied into the bridge payload below.
      if (requestId !== undefined && 'attemptCandidate' in response && response.attemptCandidate) {
        rememberPassphraseAttempt(requestId, response.attemptCandidate);
      }
      try {
        const payload: { mode: DbEncryptionModeOrError; key?: string; legacyKey?: string; requestId?: string } = {
          mode: response.mode,
        };
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
    // The launcher echoes the request id of the accepted key handoff whose DB open this ack confirms
    // (Sol Fable-round P1-1) — promote ONLY that exact attempt's candidate.
    const rawId = (payload as { requestId?: unknown } | undefined)?.requestId;
    const requestId = typeof rawId === 'string' ? rawId : undefined;
    void markPassphraseKeyMigrated(requestId);
  };

  channel.addListener('loam-db-key-request', onRequest);
  channel.addListener('loam-db-key-migrated', onMigrated);
  return () => {
    channel.removeListener('loam-db-key-request', onRequest);
    channel.removeListener('loam-db-key-migrated', onMigrated);
  };
}

export type StartFreshResult = { ok: boolean; error?: string };

/**
 * The two DISTINCT intents the `.loam-db-start-fresh` marker can record (Sol P1 / release blocker). The
 * SAME marker was previously used for both, but the server only ever PRESERVED the old ciphertext — so a
 * deliberate "Delete & start fresh" left the old (still key-recoverable) database renamed aside on disk,
 * silently contradicting the confirmation the operator agreed to. The intent is now written INTO the
 * marker so the server can honour the operator's actual choice:
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
 * directory (design#1 / AF8, docs/01, docs/15). The server consumes and deletes this marker on the next
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
      channel.removeListener('loam-db-start-fresh-result', onResult);
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

    channel.addListener('loam-db-start-fresh-result', onResult);
    try {
      channel.post('loam-db-start-fresh', { requestId, intent });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export type DbUnlockResult = { ok: boolean; error?: string };

/**
 * Ask the launcher (main.js) to retry boot right now — `db_encryption_locked` recovery (P1-1, Sol round
 * 4): a `persistent`/`passphrase` boot attempt found no usable key (typically passphrase mode before a
 * passphrase was ever entered) and, per the "never boot plaintext for these modes" rule, refused to
 * start the server at all rather than silently downgrade. `index.tsx` calls this after the operator has
 * done something that might now produce a key — for passphrase mode, having just called
 * `setStoredPassphrase`; for persistent mode, as a plain manual retry (e.g. after a transient Keystore
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
      channel.removeListener('loam-db-unlock-result', onResult);
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

    channel.addListener('loam-db-unlock-result', onResult);
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
 * SELECTION (P1-b, Sol round 6). main.js otherwise only wrote the hint when it SUCCESSFULLY resolved a
 * mode at boot, which left two holes a transient `requestDbKey` failure could exploit: (1) an existing
 * encrypted install upgrading has no hint yet, and (2) an off→encrypted selection leaves the stale `off`
 * hint until the next successful encrypted boot — either way a boot-time timeout could trust the
 * absent/stale hint and downgrade to plaintext. Calling this right AFTER `setDbEncryptionMode` succeeds
 * updates the hint immediately, BEFORE any boot, so the launcher's fail-closed gate sees the real mode.
 *
 * Writes only the mode NAME — NEVER key/passphrase material (there is none to write; the hint is the same
 * non-secret mode string already sent in the clear over the bridge). This module has no filesystem access
 * to main.js's `dataDir`, so it's a request/response round trip mirroring {@link requestDbUnlock}. Never
 * throws — a timeout, an old launcher with no handler, or a thrown `post()` all resolve to `{ ok: false }`,
 * which the caller surfaces as a soft warning (the mode itself is still persisted in SecureStore).
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
      channel.removeListener('loam-db-set-mode-hint-result', onResult);
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

    channel.addListener('loam-db-set-mode-hint-result', onResult);
    try {
      channel.post('loam-db-set-mode-hint', { requestId, mode });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * TRI-STATE result of reading the last-known mode-NAME hint (P1-1, Sol round 7). The reader
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
 * P1-1 (Sol round 7, was P1-b round 6): the PURE "may a plaintext boot be authorized after a
 * locked-error?" decision, now over the TRI-STATE {@link DbModeHintResult} (was `hint | undefined`,
 * which conflated a confirmed-absent hint with an unreadable/corrupt one and let a read error boot
 * plaintext).
 *
 * This is MIRRORED inline in `nodejs-project-template/main.js`'s `resolveDbEncryptionAndBoot` — main.js
 * is CJS on the embedded Node runtime and cannot import this TS module, so the two copies must be kept in
 * sync by hand (the main.js copy carries a comment pointing here). It lives here because it's the one
 * place in this codebase whose Vitest harness can exercise it directly; main.js itself is not
 * harness-loadable (it pulls in `rn-bridge` and boots as a side effect on require).
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
 *   - a `present` ENCRYPTED-mode hint (`ephemeral`/`persistent`/`passphrase`) → LOCK even with NO DB file
 *     (RF6-c): ephemeral wipes its DB every boot and a freshly-selected persistent/passphrase mode has no
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
   * Re-read the ACTUALLY-committed SecureStore mode INSIDE the serialized transaction (P1-3, Sol round 8).
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
 * {@link applyDbModeChange} calls (P1-3, Sol round 8). Without it, the transaction was safe for ONE
 * isolated call but NOT for interleaved ones: every caller captured the same stale React `mode`, and the
 * hint/mode writes of two transitions could interleave into the exact fail-open state (SecureStore
 * committed to an ENCRYPTED mode while the hint still says `'off'`). Chaining every transaction onto this
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
 * P1-3 (Sol round 8): the SERIALIZED, harness-tested sequencing for a mode-picker selection. Guarantees
 * the SecureStore mode and the mode-NAME hint never diverge into the DANGEROUS state — SecureStore
 * committed to an ENCRYPTED mode while the hint still says `'off'`/absent, which a transient boot-time
 * key-request failure would then resolve as a PLAINTEXT downgrade even WITH a DB on disk — even under
 * CONCURRENT picker taps.
 *
 * Two guarantees on top of the round-7 ordering:
 *   1. The whole transaction runs under a single-flight mutex ({@link withModeChangeLock}), so a second
 *      selection cannot start until the first fully commits/rolls back — two transitions can never
 *      interleave their writes into the fail-open state.
 *   2. The rollback target / diff base comes from a FRESH read of the committed SecureStore mode
 *      (`deps.readMode`) taken INSIDE the lock — never a captured/stale React `mode`. A read error aborts
 *      (no safe rollback target).
 *
 * Ordering within the transaction (unchanged from round 7):
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
 * still PLAINTEXT (P1-4-RN, Sol round 8) — there is no in-place plaintext→encrypted conversion, so the
 * host must NEVER silently serve plaintext under an encrypted selection. `index.tsx` maps this to a
 * DESTRUCTIVE recovery (delete the existing data and start a fresh encrypted DB, or switch encryption
 * back off to keep the existing unencrypted data). A non-destructive in-place plaintext→encrypted
 * CONVERSION is a documented FUTURE enhancement (docs/21) — not built. */
export const DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE = 'db_encryption_plaintext_unconverted' as const;

/**
 * P1-4-RN (Sol round 8): whether SELECTING `next` is a destructive action that must be gated behind an
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

/** The dedicated DB-encryption boot-recovery UI a given boot-error `code` maps to (P1-4-RN, Sol round 8),
 * or `null` for codes with no dedicated recovery. Pure so `index.tsx`'s code→recovery mapping (which
 * decides whether to show the destructive plaintext-unconverted / start-fresh / unlock UI) is
 * harness-testable. */
export type DbEncryptionRecovery = 'plaintext-unconverted' | 'unreadable' | 'locked';
export function dbEncryptionRecoveryForCode(code: string | undefined): DbEncryptionRecovery | null {
  switch (code) {
    case DB_ENCRYPTION_PLAINTEXT_UNCONVERTED_CODE:
      return 'plaintext-unconverted';
    case 'db_encryption_unreadable':
      return 'unreadable';
    case 'db_encryption_locked':
      return 'locked';
    default:
      return null;
  }
}
