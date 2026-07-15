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
  off: 'The on-device database is stored in plain SQLite — todays default.',
  ephemeral: 'A random key generated at each launch, held only in memory. Wipes the database on every restart — nothing survives a reboot.',
  persistent: 'A random key generated once and stored in the device Keystore. Survives reboots; the database stays encrypted at rest.',
  passphrase: 'A key derived from an operator-chosen passphrase, stored in the device Keystore. Survives reboots; anyone who knows the passphrase can also derive the key.',
};

const MODE_ITEM = 'loam-db-encryption-mode';
const PERSISTENT_KEY_ITEM = 'loam-db-encryption-persistent-key';
const PASSPHRASE_ITEM = 'loam-db-encryption-passphrase';
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

/** Whether an operator passphrase has already been entered (for the picker UI — it should prompt for
 * one only when this is false, and offer to change it when true). Never returns the passphrase itself. */
export async function hasStoredPassphrase(): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(PASSPHRASE_ITEM);
    return typeof raw === 'string' && raw.length > 0;
  } catch {
    return false;
  }
}

/** Store (or overwrite) the operator's passphrase in the Keystore-backed secure store. Never written
 * anywhere else — no AsyncStorage, no plain file, no log line. */
export async function setStoredPassphrase(passphrase: string): Promise<void> {
  await SecureStore.setItemAsync(PASSPHRASE_ITEM, passphrase);
}

/** Forget the stored passphrase (e.g. the operator switches away from passphrase mode). Best-effort. */
export async function clearStoredPassphrase(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PASSPHRASE_ITEM);
  } catch {
    // best-effort
  }
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
 */
export async function markPassphraseKeyMigrated(): Promise<void> {
  try {
    await SecureStore.setItemAsync(PASSPHRASE_KEY_VERSION_ITEM, CURRENT_PASSPHRASE_KEY_VERSION);
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
 * Called from `index.tsx`'s `loam-wipe-restart` bridge listener (the server-side kill switch's
 * fixed-key handoff, P1-2) and from its WebView `loam-wipe` message handler (the client's own `wipe`
 * WS-event notice). Real success/failure, NOT swallowed (P1-2b): a delete or verify failure is reported
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
    const passphrase = await SecureStore.getItemAsync(PASSPHRASE_ITEM);
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      // No passphrase entered yet — the picker UI (or the boot-time unlock prompt, see index.tsx) is
      // responsible for collecting one. Returning no key here is what makes main.js treat this as
      // locked (db_encryption_locked) rather than silently booting plaintext.
      return { mode };
    }
    const deviceSecret = await getOrCreateDeviceSecret();
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${passphrase}:${deviceSecret}`);

    const migratedVersion = await SecureStore.getItemAsync(PASSPHRASE_KEY_VERSION_ITEM);
    if (migratedVersion === CURRENT_PASSPHRASE_KEY_VERSION) {
      return { mode, key: digest };
    }

    // P1-1 (Sol round 5): no confirmed migration recorded yet — this could be an existing pre-round-4
    // passphrase DB (legacy key = SHA256(passphrase) alone) OR a genuinely fresh install that simply
    // never got marked. Offer BOTH: the server tries `digest` first (the fast path for an
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
  const onRequest = (): void => {
    void (async () => {
      let response: ResolvedDbKey | { mode: typeof DB_ENCRYPTION_MODE_READ_ERROR };
      try {
        const mode = await getDbEncryptionMode();
        response = mode === DB_ENCRYPTION_MODE_READ_ERROR ? { mode } : await resolveDbKey(mode);
      } catch {
        response = { mode: DB_ENCRYPTION_MODE_READ_ERROR };
      }
      try {
        const payload: { mode: DbEncryptionModeOrError; key?: string; legacyKey?: string } = { mode: response.mode };
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

  const onMigrated = (): void => {
    void markPassphraseKeyMigrated();
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
 * Ask the launcher (main.js) to write the `.loam-db-start-fresh` confirmation marker into its data
 * directory (design#1 / AF8, docs/01, docs/15). When boot fails with `db_encryption_unreadable` (an
 * encrypted DB that the current key can't open), the operator can explicitly choose "preserve the old
 * database as-is and start a fresh one" — the server consumes and deletes this marker on the next boot
 * as confirmation that a human actually asked for that, rather than the app silently doing it on its
 * own. This module has no direct filesystem access to main.js's `dataDir`
 * (`rnBridge.app.datadir()/loam`), so the write has to happen over there — this is a request/response
 * round trip over the bridge, mirroring `model-manager-bridge.ts`'s `roundTrip` helper.
 *
 * Never throws — a timeout, an old launcher build with no handler, or a thrown `post()` all resolve to
 * `{ ok: false }` so the caller can tell the operator to retry rather than hang indefinitely.
 */
export function requestDbStartFresh(channel: BridgeChannel, timeoutMs = 5000): Promise<StartFreshResult> {
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
      channel.post('loam-db-start-fresh', { requestId });
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
